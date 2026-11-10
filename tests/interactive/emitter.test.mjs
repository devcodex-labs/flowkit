import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {loadInteractiveProgram} from '../../src/interactive/load.mjs';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {evaluateWhenAst} from '../../src/when/evaluate.mjs';

const importDSL = "import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';";
function source(branches="[ {when:'ready && review.approved',next:'worker'}, {when:'true',next:'failed'} ]") {
  return importDSL + '\nexport default defineWorkflow({id:"interactive-test",version:"1.0.0",name:"Test",nodes:['
   + "condition('gate',{name:'Gate',branches:" + branches + "}),"
   + "node('worker',{name:'Worker',agent:'writer',inputs:['missing'],output:{type:'object',properties:{answer:{type:'string'}}},retries:2,next:'done'}),"
   + "terminal('done',{name:'Done',status:'succeeded'}),"
   + "terminal('failed',{name:'Failed',status:'failed'})]});";
}
async function compile(text=source()) {
  const analysis = await analyzeSource(text, {filename:'interactive.workflow.js', projectRoot:process.cwd(),skillCheck:false});
  assert.equal(analysis.diagnostics.some(d=>d.severity==='error'),false,JSON.stringify(analysis.diagnostics));
  const result=lowerInteractive(analysis);
  assert.ok(result.ir,JSON.stringify(result.diagnostics));
  const emitted=emitInteractive(result.ir);
  assert.ok(emitted.code,JSON.stringify(emitted.diagnostics));
  const loaded=await loadInteractiveProgram(Buffer.from(emitted.code,'utf8'),emitted.programIdentity.artifactHash);
  return {analysis,ir:result.ir,...emitted,loaded};
}
const ev=(blockId,kind='internal-step',extra={})=>({schemaVersion:1,forBlockId:blockId,kind,eventId:'e',eventDigest:'sha256:'+'0'.repeat(64),...extra});
const cv=(blockId,state={},controlStack=[],candidate=null)=>({schemaVersion:1,namespace:'ns',runId:'r',revision:1,blockId,phase:blockId.split('::')[1],state,controlStack,candidate});

test('M2 emits deterministic standalone JS with exact hash, ABI V1, zero imports and required bindings',async()=>{
 const a=await compile();const b=await compile();
 assert.equal(a.code,b.code);
 assert.equal(a.programIdentity.artifactHash,b.programIdentity.artifactHash);
 assert.equal(a.programIdentity.artifactHash,'sha256:'+createHash('sha256').update(Buffer.from(a.code,'utf8')).digest('hex'));
 assert.equal(a.loaded.programTable.entryBlockId,'gate::enter');
 assert.equal(a.loaded.interactiveProgram.identity.sourceHash,a.programIdentity.sourceHash);
 assert.equal(a.loaded.interactiveProgram.identity.implementedStage,'P0-A');
 assert.equal(a.loaded.programTable.requiredBindings.length,2);
 assert.equal(a.loaded.programTable.nodes.worker.metadata.retries,2);
 assert.equal(Object.isFrozen(a.loaded.programTable),true);
 assert.equal(Object.isFrozen(a.loaded.programTable.nodes),true);
 assert.equal(a.code.includes('export function advance'),true);
 assert.equal(a.code.includes('import '),false);
});

test('generated JS routes Condition and Terminal, preserving original when own-data semantics',async()=>{
 const a=await compile();
 const p=a.loaded.advance;
 const enter=p(cv('gate::enter'),ev('gate::enter'));
 assert.equal(enter.toBlockId,'gate::route');
 assert.equal(enter.kind,'move');
 const t=p(cv('gate::route',{ready:true,review:{approved:true}}),ev('gate::route'));
 assert.equal(t.toBlockId,'worker::enter');
 const f=p(cv('gate::route',{ready:false}),ev('gate::route'));
 assert.equal(f.toBlockId,'failed::enter');
 const invalid=p(cv('gate::route',{ready:true}),ev('gate::route'));
 assert.equal(invalid.kind,'raise-error');
 assert.equal(invalid.causeCode,'FK_R002');
 const term=p(cv('done::route'),ev('done::route'));
 assert.deepEqual(term.terminal,{status:'succeeded',nodeId:'done'});
 for(const state of [{ready:false},{ready:true,review:{approved:true}},{ready:true}]) {
   const ast=a.ir.nodes.gate.metadata.branches[0].ast;
   let expected;
   try { expected=evaluateWhenAst(ast,state); } catch(e){expected=e.code}
   const q=p(cv('gate::route',state),ev('gate::route'));
   assert.equal(q.kind==='raise-error'?'FK_R002':q.toBlockId==='worker::enter',expected);
 }
});

test('Agent generated JS emits certified frame, Pending publish, retry, commit and pop decisions',async()=>{
 const {loaded}=await compile();
 const advance=loaded.advance;
 const enter=advance(cv('worker::enter'),ev('worker::enter','internal-step',{activation:7}));
 assert.equal(enter.stackEffect.kind,'push');
 assert.equal(enter.stackEffect.frame.activation,7);
 assert.equal(enter.stackEffect.frame.attempt,1);
 const frame=enter.stackEffect.frame;
 assert.equal(advance(cv('worker::prepare',{},[frame]),ev('worker::prepare')).kind,'prepare-pending');
 assert.equal(advance(cv('worker::dispatch-ready',{},[frame]),ev('worker::dispatch-ready','pending-prepared')).kind,'publish-pending');
 const retry=advance(cv('worker::validate',{},[frame]),ev('worker::validate','validation-rejected',{reasons:['bad output']}));
 assert.equal(retry.kind,'retry-agent');
 assert.equal(retry.stackEffect.value,2);
 const exhausted=advance(cv('worker::validate',{},[{...frame,attempt:3}]),ev('worker::validate','validation-rejected'));
 assert.equal(exhausted.kind,'raise-error');
 assert.equal(exhausted.causeCode,'FK_R004');
 const candidate={kind:'agent',requestId:'req-1',result:{answer:'ok'}};
 assert.equal(advance(cv('worker::validate',{},[frame],candidate),ev('worker::validate','validation-passed')).kind,'commit-candidate');
 const commit=advance(cv('worker::commit',{},[frame],candidate),ev('worker::commit'));
 assert.deepEqual(commit.mergeIntent,{kind:'commit-candidate',requestId:'req-1'});
 assert.equal(commit.toBlockId,'worker::route');
 const route=advance(cv('worker::route',{},[frame]),ev('worker::route'));
 assert.deepEqual(route.stackEffect,{kind:'pop',expectedKind:'agent',expectedNodeId:'worker'});
 assert.equal(route.toBlockId,'done::enter');
 assert.throws(()=>advance(cv('worker::enter'),ev('worker::enter')),TypeError);
 assert.throws(()=>advance(cv('worker::awaiting',{},[frame]),ev('worker::awaiting')),TypeError);
});

test('loader rejects wrong digest, dynamic imports and mismatched Program ABI',async()=>{
 const {code,programIdentity}=await compile();
 const bytes=Buffer.from(code,'utf8');
 await assert.rejects(loadInteractiveProgram(Buffer.from(code+'\n','utf8'),programIdentity.artifactHash),/PROGRAM_MISMATCH/);
 await assert.rejects(loadInteractiveProgram(bytes,'sha256:bad'),/Invalid SHA/);
 const imp="import 'node:fs';\n"+code;
 const hash=s=>'sha256:'+createHash('sha256').update(s).digest('hex');
 await assert.rejects(loadInteractiveProgram(Buffer.from(imp),hash(imp)),/imports are forbidden/);
 const dynamic=code+'\nfunction bad(){ return import("node:fs"); }\n';
 await assert.rejects(loadInteractiveProgram(Buffer.from(dynamic),hash(dynamic)),/imports are forbidden/);
 const different=code.replace('FlowkitInteractiveProgramV1','MaliciousProgram');
 await assert.rejects(loadInteractiveProgram(Buffer.from(different),hash(different)),/Invalid Interactive Program ABI/);
});

test('public-facing compiler can emit memory/file without importing DSL source, and only uses original analyzer',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'fk-m2-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'example.workflow.js');
 await writeFile(file,importDSL+"\nexport default defineWorkflow({id:'only-terminal',version:'1.0.0',name:'Only',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});");
 const memory=await compileInteractive(file,{output:'memory',featureStage:'P0-A'});
 assert.ok(memory.code.length>500);
 assert.equal(memory.artifactPath,undefined);
 const disk=await compileInteractive(file,{output:'file',featureStage:'P0-A',outDir:dir});
 assert.equal(await readFile(disk.artifactPath,'utf8'),memory.code);
 const loaded=await loadInteractiveProgram(Buffer.from(disk.code),disk.programIdentity.artifactHash);
 assert.equal(loaded.advance(cv('done::route'),ev('done::route')).terminal.status,'succeeded');
 await assert.rejects(compileInteractive(file,{output:'memory',featureStage:'P0-B'}),/Only P0-A/);
});
