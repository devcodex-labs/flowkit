import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { compileToText } from '../../src/compiler/compile.mjs';
import { createSourceSnapshot } from '../../src/compiler/source.mjs';
import { evalWhen } from '../../src/when/evaluate.mjs';

const imports="import {defineWorkflow,node,action,parallel,condition,verification,loop,human,terminal} from '@devcodex-labs/flowkit/dsl';";
const end=(id='done')=>`terminal('${id}',{name:'${id}',status:'succeeded'})`;
const action=(id,next)=>`action('${id}',{name:'${id}',action:'${id}',next:'${next}'})`;
async function compile(nodes,options={}) {
  const source=`${imports}\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[${nodes.join(',')}]});`;
  const result=await compileToText(createSourceSnapshot(source,'emit.workflow.js'),{skillCheck:false,...options});
  assert.deepEqual(result.diagnostics.filter(d=>d.severity==='error'),[]);
  parse(result.code,{ecmaVersion:2025,sourceType:'module'});
  return result;
}
async function execute(result,runtime,state={}) {
  const module=await import('data:text/javascript;base64,'+Buffer.from(result.code).toString('base64'));
  const ctx={runtime:{isControlSignal:error=>error?.control===true,evalWhen,...runtime},state};
  return {result:await module.workflow(ctx),ctx};
}

test('generates structured branches and a single shared join, and executes the actual module',async()=>{
  const result=await compile(["condition('choose',{name:'Choose',branches:[{when:'flag',next:'a'},{when:'true',next:'b'}]})",action('a','done'),action('b','done'),end()]);
  assert.equal(result.plan.root.mode,'structured');
  assert.equal(result.code.match(/\/\/ \[done\]/g).length,1);
  for(const flag of [true,false]) {
    const calls=[];
    const actual=await execute(result,{runAction:id=>{calls.push(id);}},{flag});
    assert.deepEqual(calls,[flag?'a':'b']);
    assert.deepEqual(actual.result,{status:'succeeded',terminal:'done'});
  }
});

test('cross-merge fallback uses expanded static blocks and executes each selected path once',async()=>{
  const result=await compile(["condition('a',{name:'A',branches:[{when:'first',next:'b'},{when:'true',next:'c'}]})",action('b','done'),
    "condition('c',{name:'C',branches:[{when:'second',next:'b'},{when:'true',next:'done'}]})",end()]);
  assert.ok(result.plan.layouts.some(layout=>layout.mode==='topological'));
  for(const [first,second,expected] of [[true,false,['b']],[false,true,['b']],[false,false,[]]]) {
    const calls=[]; await execute(result,{runAction:id=>{calls.push(id);}},{first,second});assert.deepEqual(calls,expected);
  }
  assert.equal(result.code.match(/\/\/ \[b\]/g).length,1);
  assert.ok(!/\bswitch\s*\(|\bprocess\.|\bMath\.random|\bDate\b/.test(result.code));
});

test('loop passes, exhausts without a final repair, and resets repaired conditions each iteration',async()=>{
  const result=await compile(["loop('l',{name:'L',maxIterations:3,body:'v',onSuccess:'done',onMaxExceeded:'failed'})",
    "verification('v',{name:'V',verifier:'test',onSuccess:'l',onFailure:'repair'})",action('repair','v'),end(),end('failed')]);
  for(const answers of [[true],[false,true],[false,false,false]]) {
    const calls=[];const queue=[...answers];
    const actual=await execute(result,{runVerification:()=>{calls.push('v');return queue.shift();},runAction:id=>{calls.push(id);}});
    assert.deepEqual(calls,answers.flatMap((_,i)=>i===0?['v']:['repair','v']));
    assert.equal(actual.result.terminal,answers.at(-1)?'done':'failed');
  }
});

test('human default and multiple entry prefixes retain repair order before and after rejection',async()=>{
  const h="human('h',{name:'H',onApprove:'done',onReject:'r1'})";
  const chain=[action('r1','r2'),action('r2','h')];
  for(const entry of ['h','r1','r2']) {
    const result=await compile([action('start',entry),h,...chain,end()]);
    const calls=[];let count=0;
    await execute(result,{runAction:id=>{calls.push(id);},runHuman:()=>{calls.push('h');return ++count===2;}});
    assert.deepEqual(calls,['start',...(entry==='r1'?['r1','r2']:entry==='r2'?['r2']:[]),'h','r1','r2','h']);
    assert.equal(result.code.match(/\/\/ \[r2\]/g).length,1);
  }
});

test('action failure writes an own undefined error and skips verification; shared non-action arrivals remain valid',async()=>{
  const result=await compile(["condition('c',{name:'C',branches:[{when:'mode === 1',next:'a'},{when:'mode === 2',next:'b'},{when:'true',next:'v'}]})",
    action('a','v'),action('b','v'),"verification('v',{name:'V',verifier:'test',onSuccess:'done',onFailure:'failed'})",end(),end('failed')]);
  assert.equal(result.code.match(/\/\/ \[v\]/g).length,1);
  for(const mode of [1,2,3]) {
    let verified=0;
    const actual=await execute(result,{runAction:()=>{throw undefined;},runVerification:()=>{verified++;return true;}},{mode});
    assert.equal(verified,mode===3?1:0);
    assert.equal(actual.result.terminal,mode===3?'done':'failed');
    assert.equal(Object.hasOwn(actual.ctx,'error'),mode!==3);
  }
  const control={control:true};
  await assert.rejects(execute(result,{runAction:()=>{throw control;}},{mode:1}),error=>error===control);
});

test('parallel members use native all/any and verification writes its own id',async()=>{
  for(const strategy of ['all_succeeded','any']) {
    const result=await compile([`parallel('p',{name:'P',branches:['a','v'],join:{strategy:'${strategy}',next:'done'}})`,
      "action('a',{name:'A',action:'a'})","verification('v',{name:'V',verifier:'test'})",end()]);
    const actual=await execute(result,{runAction:async()=>{},runVerification:async()=>false});
    assert.equal(actual.result.terminal,'done');
    assert.equal(actual.ctx.state.v,false);
    if(strategy==='any')assert.ok(result.code.indexOf('Signals =')<result.code.indexOf('Promise.any('));
  }
});

test('agent templates load explicit skills, preserve own schema/input/candidate/commit and retry reasons',async()=>{
  const result=await compile(["node('n',{name:'N',skill:'skills/a.md',agent:'unused',inputs:['__proto__','missing'],output:{type:'object',properties:{'__proto__':{type:'string'}}},verify:'check',overview:true,next:'done'})",end()]);
  let attempts=0;let skillReads=0;
  const actual=await execute(result,{
    loadSkill:async()=>{skillReads++;return 'instructions';},loadSkillByAgent:()=>{assert.fail('Explicit skill wins');},
    runAgent:async step=>{assert.equal(Object.hasOwn(step.input,'__proto__'),true);assert.equal(Object.hasOwn(step.input,'missing'),true);assert.deepEqual(step.missing,['__proto__','missing']);
      assert.equal(Object.hasOwn(step.resultSchema.properties,'__proto__'),true);assert.equal(step.overview.step,1);attempts++;return JSON.parse('{"__proto__":"value"}');},
    validateResult:()=>attempts===1?['retry']:[],
    runVerification:async(_verifier,_name,ctx)=>{assert.equal(Object.getPrototypeOf(ctx.state),Object.prototype);assert.equal(Object.hasOwn(ctx.state,'__proto__'),true);return true;},
  });
  assert.equal(attempts,2);assert.equal(skillReads,1);
  assert.equal(Object.hasOwn(actual.ctx.state,'__proto__'),true);assert.equal(actual.ctx.state.__proto__,'value');
  assert.equal(Object.getPrototypeOf(actual.ctx.state),Object.prototype);
  assert.ok(result.code.includes('verify: "check", overview: true'));
});
