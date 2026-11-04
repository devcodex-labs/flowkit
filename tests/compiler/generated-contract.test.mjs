import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileToText } from '../../src/compiler/compile.mjs';
import { createSourceSnapshot } from '../../src/compiler/source.mjs';
import { evalWhen } from '../../src/when/evaluate.mjs';

const imports="import {defineWorkflow,node,action,parallel,condition,verification,loop,human,terminal} from '@devcodex/flowkit/dsl';";
const end="terminal('done',{name:'Done',status:'succeeded'})";
const text=nodes=>`${imports}\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[${nodes.join(',')}]});\n`;
const compile=async(nodes,options={})=>{
  const result=await compileToText(createSourceSnapshot(text(nodes),'generated.workflow.js'),{skillCheck:false,...options});
  assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]);return result;
};
const load=async result=>(await import('data:text/javascript;base64,'+Buffer.from(result.code).toString('base64'))).workflow;
const ctx=(runtime,state={})=>({runtime:{isControlSignal:error=>error?.control===true,evalWhen,...runtime},state});
const agent="node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},retries:1,next:'done'})";
const base={loadSkill:async()=>'',validateResult:()=>[]};

test('ten-line headers hash raw source bytes and the body minus exactly one final LF, repeatably',async()=>{
  const raw=Buffer.from('\uFEFF'+text([end]).replaceAll('\n','\r\n'));
  const snapshot=createSourceSnapshot(raw,'fixtures/中文 space/a#b.workflow.ts');
  const first=await compileToText(snapshot,{skillCheck:false,mermaid:false});
  const second=await compileToText(snapshot,{skillCheck:false,mermaid:false,dump:'ignored',runId:'ignored'});
  assert.equal(first.code,second.code);assert.equal(first.mermaid,'');
  const lines=first.code.split('\n');assert.equal(lines[10],'export async function workflow(ctx) {');
  const hash=b=>createHash('sha256').update(b).digest('hex');
  assert.ok(lines[3].includes('sourceHash: sha256:'+hash(raw)));
  assert.ok(lines[3].includes('bodyHash: sha256:'+hash(lines.slice(10).join('\n').slice(0,-1))));
  assert.ok(lines[2].includes('a%23b.workflow.ts'));
  assert.ok(!first.code.includes('\r'));
  assert.ok(!first.code.slice(first.code.indexOf('export')).includes('trace'));
  const multiline=await compileToText(createSourceSnapshot(text([end]).replace("name:'Demo'", "name:'Line\\nBreak\\u2028End'"),'multiline.workflow.js'),{skillCheck:false});
  assert.equal(multiline.code,'');
  assert.equal(multiline.diagnostics[0].code,'FK_C003');
});

test('compile errors have empty text, warnings allow text, and diagram false still validates ids',async()=>{
  const invalid=await compileToText(createSourceSnapshot(text(["action('a',{name:'A',action:'a',next:'missing'})"]),'bad.workflow.js'),{skillCheck:false});
  assert.equal(invalid.code,'');assert.equal(invalid.mermaid,'');assert.equal(invalid.diagnostics[0].code,'FK_C015');
  const collision=await compileToText(createSourceSnapshot(text(["action('a-1',{name:'A',action:'a',next:'a1'})","terminal('a1',{name:'B',status:'succeeded'})"]),'bad.workflow.js'),{skillCheck:false,mermaid:false});
  assert.equal(collision.code,'');assert.equal(collision.diagnostics[0].code,'FK_C090');
  const warning=await compile(["node('n',{name:'N',skill:'https://example.test/a.md',output:{type:'object'},next:'done'})",end],{remoteSkillHosts:['example.test']});
  assert.equal(warning.diagnostics[0].code,'FK_C059');assert.ok(warning.code.length);
});

test('headers describe only actual structures and list remote explicit or mapped Skills with integrity',async()=>{
  const header=result=>result.code.split('\n').slice(0,10).join('\n');
  const human=await compile(["human('h',{name:'H',onApprove:'done',onReject:'repair'})","action('repair',{name:'Repair',action:'fix',next:'h'})",end]);
  assert.ok(header(human).includes('runHuman'));assert.ok(!header(human).includes('runVerification'));
  const verification=await compile(["verification('v',{name:'V',verifier:'check',onSuccess:'done',onFailure:'failed'})",end,"terminal('failed',{name:'Failed',status:'failed'})"]);
  assert.ok(header(verification).includes('runVerification'));assert.ok(!header(verification).includes('runHuman'));
  for(const strategy of ['all_succeeded','any']) {
    const result=await compile([`parallel('p',{name:'P',branches:['a','b'],join:{strategy:'${strategy}',next:'done'}})`,"action('a',{name:'A',action:'a'})","action('b',{name:'B',action:'b'})",end]);
    assert.equal(header(result).includes('Promise.any'),strategy==='any');
    assert.equal(header(result).includes('Promise.all'),strategy==='all_succeeded');
  }
  const integrity='sha256-'+Buffer.alloc(32).toString('base64');
  const explicit=await compile([`node('n',{name:'N',skill:'https://example.test/a.md',agent:'unused',integrity:'${integrity}',output:{type:'object'},next:'done'})`,end],{remoteSkillHosts:['example.test'],skillsRoot:'https://unused.test/root'});
  const mapped=await compile(["node('n',{name:'N',agent:'review',output:{type:'object'},next:'done'})",end],{remoteSkillHosts:['example.test'],skillsRoot:'https://example.test/skills'});
  for(const [result,url,pin] of [[explicit,'https://example.test/a.md',integrity],[mapped,'https://example.test/skills/review.md','not provided']]) {
    assert.equal(result.code.split('\n')[10],'export async function workflow(ctx) {');
    assert.ok(header(result).includes(`Remote Skills: ${url} (integrity: ${pin})`));
    assert.ok(result.code.includes(`; remote; integrity: ${pin}`));
    assert.ok(!result.code.includes('https://unused.test'));
    assert.ok(!header(result).includes('runVerification'));
  }
  const verified=await compile([agent.replace("next:'done'","verify:'check',next:'done'"),end]);
  assert.ok(header(verified).includes('runVerification'));assert.ok(!header(verified).includes('runHuman'));
  let loaded;
  const workflow=await load(explicit);
  await workflow(ctx({...base,loadSkill:async(...args)=>{loaded=args;return '';},loadSkillByAgent:()=>assert.fail('Explicit skill wins'),runAgent:async()=>({})}));
  assert.deepEqual(loaded,['https://example.test/a.md',{integrity}]);
});

test('generated runStep exhausts with conditional cause and propagates hook or verifier failures',async()=>{
  const workflow=await load(await compile([agent,end]));
  for(const failure of [undefined,null,new Error('model')]) {
    let attempts=0;
    await assert.rejects(workflow(ctx({...base,runAgent:async()=>{attempts++;throw failure;}})),error=>error.code==='FK_R004'&&Object.hasOwn(error,'cause')&&error.cause===failure);
    assert.equal(attempts,2);
  }
  let attempts=0;
  await assert.rejects(workflow(ctx({...base,runAgent:async()=>{if(++attempts===1)throw Error('first');return {};},validateResult:()=>['schema']})),error=>error.code==='FK_R004'&&!Object.hasOwn(error,'cause')&&error.reasons[0]==='schema');
  const thrown=new Error('hook');attempts=0;
  await assert.rejects(workflow(ctx({...base,runAgent:async()=>{attempts++;return {};},checkStep:()=>{throw thrown;}})),error=>error===thrown);
  assert.equal(attempts,1);
  await assert.rejects(workflow(ctx({...base,runAgent:async()=>({}),checkStep:async()=>false})),{code:'FK_R002'});
});

test('trace records agent as a whole, every verification/action/human, and keeps trace method this',async()=>{
  const result=await compile(["node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},verify:'verify',next:'a'})",
    "action('a',{name:'A',action:'save',next:'h'})","human('h',{name:'H',onApprove:'done',onReject:'repair'})",
    "action('repair',{name:'Repair',action:'repair',next:'h'})",end],{trace:true});
  const events=[];let asks=0;
  const trace={start(id){assert.equal(this,trace);events.push([id,'start']);},end(id,_name,outcome){assert.equal(this,trace);events.push([id,outcome]);}};
  const workflow=await load(result);
  const context=ctx({...base,trace,runAgent:async()=>({}),runVerification:async()=>true,runAction:async()=>{},runHuman:async()=>++asks===2});
  await workflow(context);
  assert.deepEqual(events,[['n','start'],['n','start'],['n','ok'],['n','ok'],['a','start'],['a','ok'],['h','start'],['h','ok'],['repair','start'],['repair','ok'],['h','start'],['h','ok']]);
  assert.deepEqual(context.state.h,{approved:true,comment:null});
  const invalidEvents=[];
  await assert.rejects(workflow(ctx({...base,runAgent:async()=>({}),runVerification:async()=>true,runAction:async()=>{},runHuman:async()=>({approved:true,comment:3}),
    trace:{start(){},end(id,_name,outcome){invalidEvents.push([id,outcome]);}}})),{code:'FK_R002'});
  assert.ok(invalidEvents.some(([id,outcome])=>id==='h'&&outcome==='error'));
  await workflow(ctx({...base,runAgent:async()=>({}),runVerification:async()=>true,runAction:async()=>{},runHuman:async()=>true,trace:{start(){throw Error('ignored');},end(){throw Error('ignored');}}}));
});

test('native any prioritizes a final control rejection and ignores a control signal after success',async()=>{
  const result=await compile(["parallel('p',{name:'P',branches:['a','b'],join:{strategy:'any',next:'done'}})",
    "action('a',{name:'A',action:'a'})","action('b',{name:'B',action:'b'})",end]);
  const workflow=await load(result);
  function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
  const first=deferred(),last=deferred();const control={control:true};
  const running=workflow(ctx({runAction:id=>id==='a'?first.promise:last.promise}));
  first.reject(Error('business'));await Promise.resolve();last.reject(control);
  await assert.rejects(running,error=>error===control);
  const good=deferred(),late=deferred();
  const success=workflow(ctx({runAction:id=>id==='a'?good.promise:late.promise}));
  good.resolve();assert.equal((await success).terminal,'done');late.reject(control);await Promise.resolve();
  await assert.rejects(workflow(ctx({runAction:async()=>{throw Error('business');}})),AggregateError);
});

test('crossing blocks stay local and a 500-node generated chain executes without duplication',async()=>{
  const crossing=await compile(["action('start',{name:'Start',action:'start',next:'a'})",
    "condition('a',{name:'A',branches:[{when:'flag',next:'b'},{when:'true',next:'c'}]})",
    "action('b',{name:'B',action:'b',next:'after'})","condition('c',{name:'C',branches:[{when:'flag',next:'b'},{when:'true',next:'after'}]})",
    "action('after',{name:'After',action:'after',next:'done'})",end]);
  assert.equal(crossing.plan.root.mode,'structured');
  assert.ok(!crossing.code.includes('StartReach'));
  assert.ok(!crossing.code.includes('n4_afterReach'));
  const nodes=[...Array.from({length:499},(_,i)=>`action('a-${i}',{name:'A ${i}',action:'${i}',next:'${i===498?'done':`a-${i+1}`}'})`),end];
  const result=await compile(nodes);const workflow=await load(result);const calls=[];
  assert.equal((await workflow(ctx({runAction:async id=>{calls.push(id);}}))).terminal,'done');
  assert.equal(calls.length,499);assert.equal(new Set(calls).size,499);
});

test('loop crossing repair flags reset so a skipped branch does not run on the second repair',async()=>{
  const result=await compile(["loop('l',{name:'L',maxIterations:3,body:'v',onSuccess:'done',onMaxExceeded:'failed'})",
    "verification('v',{name:'V',verifier:'check',onSuccess:'l',onFailure:'c1'})",
    "condition('c1',{name:'C1',branches:[{when:'flag',next:'b'},{when:'true',next:'c2'}]})",
    "action('b',{name:'B',action:'b',next:'d'})",
    "condition('c2',{name:'C2',branches:[{when:'flag',next:'b'},{when:'true',next:'d'}]})",
    "action('d',{name:'D',action:'d',next:'v'})",end,"terminal('failed',{name:'Failed',status:'failed'})"]);
  assert.ok(result.plan.layouts.some(layout=>layout.mode==='topological'));
  let attempts=0;const calls=[];
  const context=ctx({runVerification:async()=>++attempts===3,runAction:async(id,_name,target)=>{calls.push(id);if(id==='d')target.state.flag=false;}},{flag:true});
  assert.equal((await (await load(result))(context)).terminal,'done');
  assert.deepEqual(calls,['b','d','d']);assert.equal(attempts,3);
});
