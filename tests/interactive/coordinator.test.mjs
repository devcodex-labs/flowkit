import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';
import {canonicalBytes} from '../../src/interactive/canonical.mjs';

const dirs=[];
after(async()=>{for(const dir of dirs)await rm(dir,{recursive:true,force:true})});
async function dbPath(){
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-m4-'));
  dirs.push(dir);
  return path.join(dir,'runs.db');
}
const dsl="import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';";
const schema="{type:'object',properties:{answer:{type:'string'}}}";
function agentSource({branch=true,retries=2}={}) {
  return dsl + "\nexport default defineWorkflow({id:'m4-agent',version:'1.0.0',name:'M4',nodes:["
    +(branch ? "condition('gate',{name:'Gate',branches:[{when:'ready',next:'worker'},{when:'true',next:'fail'}]})," : "")
    +"node('worker',{name:'Worker',agent:'writer',inputs:['existing','missing'],output:"+schema
    +",retries:"+retries+",overview:true,next:'done'}),"
    +"terminal('done',{name:'Done',status:'succeeded'}),"
    +(branch ? "terminal('fail',{name:'Failure',status:'failed'})" : "")
    +"]});";
}
function terminalSource() {
  return dsl+"\nexport default defineWorkflow({id:'m4-terminal',version:'1.0.0',name:'M4Terminal',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});";
}
async function emitted(source) {
  const analysis=await analyzeSource(source,{filename:'m4.workflow.js',projectRoot:process.cwd(),skillCheck:false});
  assert.equal(analysis.diagnostics.some(d=>d.severity==='error'),false,JSON.stringify(analysis.diagnostics));
  const ir=lowerInteractive(analysis);
  assert.ok(ir.ir,JSON.stringify(ir.diagnostics));
  const output=emitInteractive(ir.ir);
  assert.ok(output.code,JSON.stringify(output.diagnostics));
  return {programBytes:Buffer.from(output.code),programIdentity:output.programIdentity};
}
const bindings={
  skillResolver:async descriptor=>'Write valid JSON for '+descriptor.nodeId,
  validateResult:(schema,result)=>result && typeof result==='object'
    && typeof result.answer==='string' ? [] : ['answer must be string'],
};
const check=(result, expected)=>assert.equal(result.status,expected,JSON.stringify(result));
function coordinator(store,{runtime=bindings,policy={},maxStagesPerCall}={}) {
  return createInteractiveCoordinator({store,runtime,policy,
    ...(maxStagesPerCall===undefined?{}:{maxStagesPerCall})});
}
async function runAgentFixture(t,{retries=2,branch=true,runtime=bindings,maxStagesPerCall}={}) {
  const file=await dbPath();
  const store=createSqliteCheckpointStore(file,{namespace:'alpha'});
  t.after(()=>store.close());
  const source=await emitted(agentSource({retries,branch}));
  const api=coordinator(store,{runtime,maxStagesPerCall});
  const state=branch?{ready:true,existing:'hello'}:{existing:'hello'};
  return {file,store,source,api,state};
}
function receipt(frame,result={answer:'hello'}) {
  return {runId:frame.runId,requestId:frame.pending.requestId,
    nodeId:frame.pending.nodeId,attempt:frame.pending.attempt,result};
}
async function advanceBudget(api,runId,stopStatus='waiting') {
  let frame=await api.resume({runId});
  for(let steps=0;steps<40 && frame.status!==stopStatus && frame.status==='paused';steps++) {
    frame=await api.resume({runId});
  }
  return frame;
}

test('M4 pure Terminal passes without Agent bindings, then resume is stable',async t=>{
  const file=await dbPath();
  const store=createSqliteCheckpointStore(file,{namespace:'alpha'});
  t.after(()=>store.close());
  const api=coordinator(store,{runtime:{}});
  const source=await emitted(terminalSource());
  const result=await api.start({...source,startKey:'one',state:{value:1}});
  check(result,'succeeded');
  assert.deepEqual(result.state,{value:1});
  assert.equal(result.terminal.nodeId,'done');
  const stable=await api.resume({runId:result.runId});
  assert.equal(stable.revision,result.revision);
  assert.deepEqual(stable,result);
});

test('M4 generated Program routes Condition before Agent, publishes immutable Pending, then commits verified State',async t=>{
  const {api,store,source,state}=await runAgentFixture(t);
  const started=await api.start({...source,startKey:'first',state});
  check(started,'waiting');
  assert.ok(started.revision>=5);
  assert.equal(started.pending.kind,'agent');
  assert.equal(started.pending.name,'Worker');
  assert.equal(started.pending.id,'worker');
  assert.equal(started.pending.attempt,1);
  assert.equal(started.pending.instruction,'Write valid JSON for worker');
  assert.deepEqual(started.pending.input,{existing:'hello'});
  assert.deepEqual(started.pending.missing,['missing']);
  assert.deepEqual(started.pending.overview,{step:1});
  assert.deepEqual(started.pending.reasons,[]);
  assert.equal(Object.hasOwn(started,'state'),false); // only Terminal discloses complete State
  assert.deepEqual(await api.resume({runId:started.runId}),started);
  const accepted=await api.complete(receipt(started,{answer:'ok'}));
  check(accepted,'succeeded');
  assert.deepEqual(accepted.state,{ready:true,existing:'hello',answer:'ok'});
  assert.ok(accepted.acceptedRevision>started.revision);
  assert.deepEqual(store.listJournal(started.runId).map(x=>x.revision),
    Array.from({length:accepted.revision+1},(_,i)=>i));
  assert.equal((await api.resume({runId:started.runId})).revision,accepted.revision);
});

test('M4 false Condition never emits an Agent Pending and returns failed Terminal',async t=>{
  const {api,source}=await runAgentFixture(t);
  const result=await api.start({...source,startKey:'false-branch',state:{ready:false}});
  check(result,'failed');
  assert.equal(result.terminal.nodeId,'fail');
});

test('M4 Standard-compatible missing when input is a durable errored FK_R002 (never a fake waiting)',async t=>{
  const sourceText=dsl + "\nexport default defineWorkflow({id:'missing-when',version:'1.0.0',name:'Missing',nodes:[condition('gate',{name:'Gate',branches:[{when:'review.approved',next:'done'},{when:'true',next:'fail'}]}),terminal('done',{name:'Done',status:'succeeded'}),terminal('fail',{name:'Fail',status:'failed'})]});";
  const source=await emitted(sourceText);
  const file=await dbPath();
  const store=createSqliteCheckpointStore(file,{namespace:'alpha'});
  t.after(()=>store.close());
  const api=coordinator(store,{runtime:{}});
  const result=await api.start({...source,startKey:'bad-when',state:{}});
  check(result,'errored');
  assert.equal(result.terminal.causeCode,'FK_R002');
  const again=await api.resume({runId:result.runId});
  assert.equal(again.revision,result.revision);
  assert.equal(store.listJournal(result.runId).length,result.revision+1);
});

test('M4 duplicate equal receipt returns durable acceptedRevision after multiple later CAS stages',async t=>{
  const {api,source,state}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'dup',state});
  const original=receipt(waiting,JSON.parse('{"answer":"yes","nested":{"b":2,"a":1}}'));
  const accepted=await api.complete(original);
  check(accepted,'succeeded');
  const same={...original,result:JSON.parse('{"nested":{"a":1,"b":2},"answer":"yes"}')};
  const replay=await api.complete(same);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.acceptedRevision,accepted.acceptedRevision);
  assert.equal(replay.revision,accepted.revision);
  assert.deepEqual(replay.state,accepted.state);
});

test('M4 wrong node, attempt, requestId, different digest and untrusted event kind all reject without State mutation',async t=>{
  const {api,store,source,state}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'reject',state});
  const id=waiting.runId;
  const before=canonicalBytes(store.load(id));
  for(const invalid of [
    {...receipt(waiting),nodeId:'other'},
    {...receipt(waiting),attempt:2},
    {...receipt(waiting),requestId:'req:fake'},
    {...receipt(waiting),kind:'human'},
  ]) {
    await assert.rejects(api.complete(invalid),/FK_I_(STALE_RECEIPT|INVALID_RECEIPT)/);
    assert.deepEqual(canonicalBytes(store.load(id)),before);
  }
  const first=await api.complete(receipt(waiting));
  await assert.rejects(api.complete(receipt(waiting,{answer:'changed'})),/FK_I_RECEIPT_CONFLICT/);
  assert.equal(store.load(id).revision,first.revision);
});

test('M4 retries invalid Agent outputs at most retries+1, preserving State and FK_R004 on exhaustion',async t=>{
  const {api,store,source,state}=await runAgentFixture(t);
  let current=await api.start({...source,startKey:'exhaust',state});
  check(current,'waiting');
  const ids=[];
  for(let attempt=1;attempt<=3;attempt++){
    assert.equal(current.pending.attempt,attempt);
    ids.push(current.pending.requestId);
    const result=await api.complete(receipt(current,{answer:37}));
    if(attempt<3){
      check(result,'waiting');
      assert.equal(result.pending.attempt,attempt+1);
      assert.deepEqual(result.pending.reasons,['answer must be string']);
      current=result;
    }else {
      check(result,'errored');
      assert.equal(result.terminal.causeCode,'FK_R004');
      assert.deepEqual(result.state,state);
    }
  }
  assert.equal(new Set(ids).size,3);
  const final=store.load(current.runId);
  assert.equal(final.status,'errored');
  assert.equal(final.receipts.length,3);
  assert.equal((await api.resume({runId:current.runId})).revision,final.revision);
});

test('M4 synchronous validator that throws or returns undefined becomes terminal contract error without retry',async t=>{
  for(const validateResult of [
    ()=>{throw new Error('secret validator exception')},
    ()=>undefined,
    async()=>[],
  ]){
    const {api,source,state}=await runAgentFixture(t,{runtime:{...bindings,validateResult}});
    const waiting=await api.start({...source,startKey:'bad-validator',state});
    const result=await api.complete(receipt(waiting));
    check(result,'errored');
    assert.equal(result.terminal.causeCode,'FK_I_VALIDATOR_CONTRACT');
    assert.deepEqual(result.state,state);
    assert.equal((await api.resume({runId:waiting.runId})).revision,result.revision);
  }
});

test('M4 host-reported Agent call failure retries once and eventually stops without executing a model internally',async t=>{
  const {api,source,state}=await runAgentFixture(t,{retries:1});
  const first=await api.start({...source,startKey:'throw',state});
  const failedCall={
    runId:first.runId,requestId:first.pending.requestId,
    nodeId:first.pending.nodeId,attempt:1,
    kind:'agent-call-failed',failure:{message:'timeout'},
  };
  const next=await api.complete(failedCall);
  check(next,'waiting');
  assert.deepEqual(next.pending.reasons,['runAgent threw: timeout']);
  const exhausted=await api.complete({
    ...failedCall,requestId:next.pending.requestId,attempt:2,
  });
  check(exhausted,'errored');
  assert.equal(exhausted.terminal.causeCode,'FK_R004');
});

test('M4 run start fingerprint rejects drift but same startKey+same intent returns original run',async t=>{
  const {api,source,state}=await runAgentFixture(t);
  const first=await api.start({...source,startKey:'daily',state,startIntent:{tenant:'v1'}});
  const again=await api.start({...source,runId:'different-run',startKey:'daily',
    state:{existing:'hello',ready:true},startIntent:{tenant:'v1'}});
  assert.equal(again.runId,first.runId);
  assert.equal(again.pending.requestId,first.pending.requestId);
  await assert.rejects(api.start({...source,startKey:'daily',state:{ready:true},
    startIntent:{tenant:'v1'}}),/FK_I_START_CONFLICT/);
  await assert.rejects(api.start({...source,startKey:'daily',state,
    startIntent:{tenant:'v2'}}),/FK_I_START_CONFLICT/);
});

test('M4 restart with no workflow source uses retained compiler artifact and immutable policy',async t=>{
  const {file,store,api,source,state}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'resume',state});
  const laterStore=createSqliteCheckpointStore(file,{namespace:'alpha'});
  t.after(()=>laterStore.close());
  const restored=coordinator(laterStore,{runtime:bindings});
  assert.deepEqual(await restored.resume({runId:waiting.runId}),waiting);
  const success=await restored.complete(receipt(waiting,{answer:'resumed'}));
  check(success,'succeeded');
  const wrongPolicy=coordinator(laterStore,{runtime:bindings,policy:{bindingVersion:2}});
  await assert.rejects(wrongPolicy.resume({runId:waiting.runId}),/FK_I_POLICY_MISMATCH/);
  assert.equal(store.load(waiting.runId).revision,success.revision);
});

test('M4 stage budget=1 checkpoints every step, never returns an empty fake waiting, resumes to the same result',async t=>{
  const {api,source,state}=await runAgentFixture(t,{maxStagesPerCall:1});
  const first=await api.start({...source,startKey:'tiny-budget',state});
  check(first,'paused');
  assert.equal(first.pauseReason,'stage-budget');
  let waiting=await advanceBudget(api,first.runId);
  check(waiting,'waiting');
  assert.ok(waiting.pending.requestId);
  const paused=await api.complete(receipt(waiting,{answer:'success'}));
  check(paused,'paused');
  let ending=await advanceBudget(api,first.runId,'succeeded');
  check(ending,'succeeded');
  assert.equal(ending.state.answer,'success');
});

test('M4 changing client-owned input object while waiting does not mutate persisted State',async t=>{
  const {api,source,state}=await runAgentFixture(t);
  state.existing='before';
  const waiting=await api.start({...source,startKey:'snapshot',state});
  state.existing='after';
  const result=await api.complete(receipt(waiting));
  check(result,'succeeded');
  assert.equal(result.state.existing,'before');
});

test('M4 rejects unsupported checkStep and missing runtime bindings before start writes',async t=>{
  const {store,source,state}=await runAgentFixture(t);
  for(const runtime of [
    {validateResult:bindings.validateResult},
    {skillResolver:bindings.skillResolver},
    {...bindings,checkStep:()=>null},
  ]){
    const api=coordinator(store,{runtime});
    await assert.rejects(api.start({...source,startKey:'not-started',state}),
      /FK_I_(BINDING_MISSING|UNSUPPORTED_GRAPH)/);
  }
  assert.deepEqual(store.listJournal('not-started'),[]);
});

test('M4 concurrent complete from two independent Store connections accepts one receipt but returns same Ack',async t=>{
  const {file,api,source,state,store}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'race',state});
  const otherStore=createSqliteCheckpointStore(file,{namespace:'alpha'});
  t.after(()=>otherStore.close());
  const second=coordinator(otherStore);
  const [a,b]=await Promise.all([
    api.complete(receipt(waiting)),
    second.complete(receipt(waiting)),
  ]);
  assert.equal(a.acceptedRevision,b.acceptedRevision);
  assert.ok(a.duplicate!==b.duplicate);
  assert.equal(store.load(waiting.runId).receipts.length,1);
  assert.equal(store.load(waiting.runId).status,'succeeded');
});

test('M4 rejects other tenant runId without exposing checkpoint, even with same compiled workflow',async t=>{
  const {file,api,source,state}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'private-run',state});
  const foreign=createSqliteCheckpointStore(file,{namespace:'beta'});
  t.after(()=>foreign.close());
  const other=coordinator(foreign);
  assert.equal(await other.load({runId:waiting.runId}),null);
  await assert.rejects(other.resume({runId:waiting.runId}),/FK_I_RUN_NOT_FOUND/);
  await assert.rejects(other.complete(receipt(waiting)),/FK_I_RUN_NOT_FOUND/);
});

test('M4 forbids invalid JSON and preserve __proto__ as State data after verified merge',async t=>{
  const {api,source}=await runAgentFixture(t);
  const state=JSON.parse('{"ready":true,"__proto__":{"safe":"state"}}');
  const waiting=await api.start({...source,startKey:'special-data',state});
  const result=await api.complete(receipt(waiting,JSON.parse('{"answer":"fine","__proto__":{"safe":"result"}}')));
  check(result,'succeeded');
  assert.equal(result.state.__proto__.safe,'result');
  assert.equal({}.safe,undefined);
  await assert.rejects(api.start({...source,startKey:'accessor',
    state:{ready:true,bad:NaN}}),/canonical JSON number/i);
});


test('M4 malformed Host failure message is rejected before receipt CAS and leaves waiting replayable',async t=>{
  const {api,store,source,state}=await runAgentFixture(t);
  const waiting=await api.start({...source,startKey:'malformed-failure',state});
  const before=canonicalBytes(store.load(waiting.runId));
  for(const bad of [12,null,{}, {message:12},{message:''},{message:'x',extra:'y'}]){
    await assert.rejects(api.complete({
      runId:waiting.runId,requestId:waiting.pending.requestId,
      nodeId:waiting.pending.nodeId,attempt:waiting.pending.attempt,
      kind:'agent-call-failed',failure:bad,
    }),/FK_I_INVALID_RECEIPT|Expected plain JSON/i);
    assert.deepEqual(canonicalBytes(store.load(waiting.runId)),before);
  }
  const good=await api.complete(receipt(waiting));
  check(good,'succeeded');
});

test('M4 an overly permissive validator cannot strand a primitive candidate at commit',async t=>{
  const runtime={...bindings,validateResult:()=>[]};
  const {api,source,state}=await runAgentFixture(t,{runtime});
  const waiting=await api.start({...source,startKey:'primitive',state});
  const retried=await api.complete(receipt(waiting,null));
  check(retried,'waiting');
  assert.deepEqual(retried.pending.reasons,['Agent result must be object']);
  const done=await api.complete(receipt(retried,{answer:'safe'}));
  check(done,'succeeded');
  assert.equal(done.state.answer,'safe');
});

test('M4 a sparse validator reasons array fails closed without committing invalid State',async t=>{
  const runtime={...bindings,validateResult:()=>Array(1)};
  const {api,source,state}=await runAgentFixture(t,{runtime});
  const waiting=await api.start({...source,startKey:'sparse-reasons',state});
  const result=await api.complete(receipt(waiting));
  check(result,'errored');
  assert.equal(result.terminal.causeCode,'FK_I_VALIDATOR_CONTRACT');
  assert.deepEqual(result.state,state);
});


test('M4 a successful receipt CAS followed by a lost response is recovered by durable duplicate Ack',async t=>{
  const {store,source,state}=await runAgentFixture(t);
  let loseOnce=true;
  const wrapped={
    ...store,
    compareAndSwap(args){
      const response=store.compareAndSwap(args);
      if(loseOnce && response.committed && args.nextCheckpoint.phase==='validate'){
        loseOnce=false;
        throw new Error('simulated lost CAS response after commit');
      }
      return response;
    },
  };
  const original=coordinator(wrapped);
  const waiting=await original.start({...source,startKey:'lost-response',state});
  const submitted=receipt(waiting,{answer:'once'});
  await assert.rejects(original.complete(submitted),/lost CAS response/);
  const accepted=store.load(waiting.runId);
  assert.equal(accepted.phase,'validate');
  assert.equal(accepted.receipts.length,1);
  assert.equal(accepted.receipts[0].requestId,waiting.pending.requestId);
  const recovered=await coordinator(store).complete(submitted);
  check(recovered,'succeeded');
  assert.equal(recovered.duplicate,true);
  assert.equal(recovered.acceptedRevision,accepted.revision);
  assert.equal(recovered.state.answer,'once');
  assert.equal(store.load(waiting.runId).receipts.length,1);
});


test('R04 regression: start snapshots caller-owned State before first await',async t=>{
  const {api,source,state,store}=await runAgentFixture(t);
  const originalState={...state};
  const starting=api.start({...source,startKey:'r04-state-snapshot',state});
  // A later write by the caller must never become the Run's initial State.
  state.existing='modified-after-start';
  const frame=await starting;
  assert.deepEqual(store.load(frame.runId).state,originalState,
    'persisted State must be an entry-time snapshot');
});

test('R04 regression: start snapshots caller-owned startIntent before first await',async t=>{
  const {api,source,state}=await runAgentFixture(t);
  const intent={request:'before-await'};
  const starting=api.start({
    ...source,startKey:'r04-intent-snapshot',state,startIntent:intent,
  });
  // The idempotency identity must not depend on post-call mutation.
  intent.request='modified-after-start';
  const first=await starting;
  const originalReplay=await api.start({
    ...source,startKey:'r04-intent-snapshot',state,
    startIntent:{request:'before-await'},
  });
  assert.equal(originalReplay.runId,first.runId);
});
