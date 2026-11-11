import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign} from 'node:crypto';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {
  createAgentReceiptStatement,encodeAgentReceiptStatement,
} from '../../src/interactive/host-attestation.mjs';
import {
  canonicalBytes,MAX_CHECKPOINT_BYTES,MAX_ACTIVE_CHECKPOINT_BYTES,
  MAX_INLINE_AGENT_RESULT_BYTES,
} from '../../src/interactive/canonical.mjs';

const directories=[];
after(async()=>{for(const dir of directories)await rm(dir,{recursive:true,force:true})});
const definition=(count=1)=>{
  const nodes=[];
  for(let i=0;i<count;i++){
    nodes.push("node('agent"+i+"',{name:'Agent "+i+"',agent:'worker',"+
      "inputs:[],output:{type:'object',properties:{answer:{type:'string'}}},"+
      "retries:0,next:'"+(i===count-1?'done':'agent'+(i+1))+"'})");
  }
  nodes.push("terminal('done',{name:'Done',status:'succeeded'})");
  return "import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';\n"+
    "export default defineWorkflow({id:'s07-capacity',version:'1.0.0',name:'Capacity',nodes:["+nodes.join(',')+"]});";
};
const runtime={
  skillResolver:async()=> 'Return a structured result',
  validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['Expected answer'],
};
async function compiled(count=1){
  const analysis=await analyzeSource(definition(count),{
    filename:'s07.workflow.js',projectRoot:process.cwd(),skillCheck:false,
  });
  assert.equal(analysis.diagnostics.some(d=>d.severity==='error'),false,
    JSON.stringify(analysis.diagnostics));
  const lowered=lowerInteractive(analysis);
  assert.ok(lowered.ir,JSON.stringify(lowered.diagnostics));
  const emitted=emitInteractive(lowered.ir);
  assert.ok(emitted.code,JSON.stringify(emitted.diagnostics));
  return {programBytes:Buffer.from(emitted.code),programIdentity:emitted.programIdentity};
}
async function fixture(t,count=1){
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-s07-'));
  directories.push(dir);
  const file=path.join(dir,'test.db');
  const store=createSqliteCheckpointStore(file,{namespace:'s07'});
  t.after(()=>store.close());
  const source=await compiled(count);
  const api=createInteractiveCoordinator({store,runtime});
  return {file,store,api,source};
}
function receipt(frame,result={answer:'ok'}){
  return {runId:frame.runId,requestId:frame.pending.requestId,
    nodeId:frame.pending.nodeId,attempt:frame.pending.attempt,result};
}
async function waiting(f,{runId='run-s07',state={message:'small'},startKey='start-s07'}={}){
  const frame=await f.api.start({...f.source,startKey,runId,state});
  assert.equal(frame.status,'waiting');
  return frame;
}
function checkJournal(store,runId){
  const cp=store.load(runId);
  const journal=store.listJournal(runId);
  assert.equal(journal.length,cp.revision+1);
  assert.deepEqual(journal.map(r=>r.revision),Array.from({length:cp.revision+1},(_,i)=>i));
  return {cp,journal};
}
function fillWaitingTo(f,original,limit,headroom=75){
  const current=f.store.load(original.runId);
  const next={
    ...current,revision:current.revision+1,
    state:{...current.state,filler:''},
  };
  const base=canonicalBytes(next).byteLength;
  assert.ok(limit-base-headroom>0);
  next.state.filler='x'.repeat(limit-base-headroom);
  return next;
}

test('S07 original 2 MiB waiting seed is rejected BEFORE publishing unacceptably large State; 64 KiB valid receipt still succeeds',async t=>{
  const f=await fixture(t);
  const w=await waiting(f);
  const before=canonicalBytes(f.store.load(w.runId));
  const journal=f.store.listJournal(w.runId);
  const huge=fillWaitingTo(f,w,MAX_CHECKPOINT_BYTES);
  assert.throws(()=>f.store.compareAndSwap({
    runId:w.runId,expectedRevision:w.revision,nextCheckpoint:huge,
    transitionId:'s07-invalid-near-hard',journalEntry:{kind:'test-large'},
  }),{code:'FK_I_CHECKPOINT_CAPACITY'});
  assert.deepEqual(canonicalBytes(f.store.load(w.runId)),before);
  assert.deepEqual(f.store.listJournal(w.runId),journal);
  const complete=await f.api.complete(receipt(w,{answer:'v'.repeat(64*1024)}));
  assert.equal(complete.status,'succeeded');
  assert.equal(complete.state.answer.length,64*1024);
  assert.equal(f.store.getReceipt(w.runId,w.pending.requestId).acceptedRevision,
    complete.acceptedRevision);
  checkJournal(f.store,w.runId);
});

test('S07 valid 64 KiB receipt at safe active headroom deterministically errors instead of stranding waiting',async t=>{
  const f=await fixture(t);
  const w=await waiting(f);
  const expanded=fillWaitingTo(f,w,MAX_ACTIVE_CHECKPOINT_BYTES);
  assert.equal(f.store.compareAndSwap({
    runId:w.runId,expectedRevision:w.revision,nextCheckpoint:expanded,
    transitionId:'s07-near-soft',journalEntry:{kind:'test-reserved'},
  }).committed,true);
  const before=f.store.load(w.runId);
  assert.equal(before.status,'waiting');
  assert.ok(MAX_ACTIVE_CHECKPOINT_BYTES-canonicalBytes(before).byteLength<=75);
  await assert.rejects(f.api.complete(receipt(w,{answer:'v'.repeat(64*1024)})),
    {code:'FK_I_CHECKPOINT_CAPACITY'});
  const ended=f.store.load(w.runId);
  assert.equal(ended.status,'errored');
  assert.equal(ended.terminal.causeCode,'FK_I_CHECKPOINT_CAPACITY');
  assert.deepEqual(ended.state,before.state);
  assert.equal(ended.pending,null);
  assert.equal(ended.candidate,null);
  assert.equal(f.store.getReceipt(w.runId,w.pending.requestId),null);
  const revision=ended.revision;
  assert.equal((await f.api.resume({runId:w.runId})).revision,revision);
  assert.equal((await f.api.resume({runId:w.runId})).status,'errored');
  await assert.rejects(f.api.complete(receipt(w)),/FK_I_STALE_RECEIPT/);
  checkJournal(f.store,w.runId);
});

test('S07 oversized Host-owned inline Agent output is a durable terminal capacity error; no false acceptedRevision',async t=>{
  for(const bytes of [MAX_INLINE_AGENT_RESULT_BYTES+1,MAX_CHECKPOINT_BYTES+1024]){
    const f=await fixture(t);
    const runId='too-large-'+bytes;
    const w=await waiting(f,{runId,startKey:runId,state:{valuable:'kept'}});
    const oversized=receipt(w,{answer:'z'.repeat(bytes)});
    await assert.rejects(f.api.complete(oversized),{code:'FK_I_CHECKPOINT_CAPACITY'});
    const snapshot=f.store.load(runId);
    assert.equal(snapshot.status,'errored');
    assert.equal(snapshot.terminal.causeCode,'FK_I_CHECKPOINT_CAPACITY');
    assert.deepEqual(snapshot.state,{valuable:'kept'});
    assert.equal(snapshot.receipts.length,0);
    assert.equal(f.store.getReceipt(runId,w.pending.requestId),null);
    checkJournal(f.store,runId);
  }
});

test('S07 initial State exceeding active budget fails before creating a resumable Run',async t=>{
  const f=await fixture(t);
  const state={filler:'a'.repeat(MAX_ACTIVE_CHECKPOINT_BYTES)};
  await assert.rejects(f.api.start({...f.source,
    runId:'oversized-initial',startKey:'initial-too-large',state}),{
    code:'FK_I_CHECKPOINT_CAPACITY',
  });
  assert.equal(f.store.load('oversized-initial'),null);
  assert.deepEqual(f.store.listJournal('oversized-initial'),[]);
});

test('S07 21 Agent receipts retain a constant-size Checkpoint cache but all old Ack identities in SQLite index',async t=>{
  const f=await fixture(t,21);
  let current=await waiting(f);
  let first,originalReceipt;
  for(let i=0;i<21;i++){
    assert.equal(current.pending.nodeId,'agent'+i);
    const submitted=receipt(current,{answer:'done-'+i});
    const accepted=await f.api.complete(submitted);
    if(i===0){first=accepted.acceptedRevision;originalReceipt=submitted}
    assert.equal(f.store.getReceipt(current.runId,submitted.requestId).acceptedRevision,
      accepted.acceptedRevision);
    current=accepted;
  }
  assert.equal(current.status,'succeeded');
  const final=f.store.load(current.runId);
  assert.equal(final.receipts.length,16);
  assert.ok(!final.receipts.some(x=>x.requestId===originalReceipt.requestId));
  assert.equal(f.store.getReceipt(current.runId,originalReceipt.requestId).acceptedRevision,first);
  const reopened=createSqliteCheckpointStore(f.file,{namespace:'s07'});
  t.after(()=>reopened.close());
  assert.equal(reopened.getReceipt(current.runId,originalReceipt.requestId).acceptedRevision,first);
  const replay=await f.api.complete(originalReceipt);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.acceptedRevision,first);
  assert.equal(replay.revision,current.revision);
  checkJournal(f.store,current.runId);
});

test('S07 M5 signed duplicate recovery checks index even after the old receipt leaves Checkpoint cache',async t=>{
  const f=await fixture(t,21);
  const keys=generateKeyPairSync('ed25519');
  let clock=1794400000000;
  const host=createTrustedInteractiveHost({
    store:f.store,runtime,
    trustedPublicKeys:{'host':keys.publicKey},
    trustedArtifacts:[f.source.programIdentity.artifactHash],
    allowedInputKeys:[],disclosurePolicyId:'s07-public-v1',
    authorizeDisclosure:async()=>true,now:()=>clock,
  });
  let frame=await host.start({...f.source,
    startKey:'host-s07',runId:'host-s07',state:{counter:0}});
  assert.equal(frame.status,'waiting');
  let originalSigned=null,originalReceipt=null,firstRevision=null;
  for(let i=0;i<21;i++){
    const task=await host.getPublicAgentTask({runId:frame.runId});
    assert.ok(task);
    const item={
      runId:task.runId,requestId:task.requestId,nodeId:task.nodeId,
      attempt:task.attempt,kind:'agent-result',result:{answer:'signed-'+i},
    };
    const statement=createAgentReceiptStatement({
      run:f.store.load(item.runId),receipt:item,keyId:'host',proofId:'s07-proof-'+i,
      issuedAt:clock-1000,expiresAt:clock+5000,
    });
    const attestation={statement,
      signature:sign(null,encodeAgentReceiptStatement(statement),keys.privateKey)
        .toString('base64url'),
    };
    const completed=await host.accept({receipt:item,attestation});
    if(i===0) {originalReceipt=item;originalSigned=attestation;firstRevision=completed.acceptedRevision;}
    frame=completed;
  }
  assert.equal(frame.status,'succeeded');
  assert.equal(f.store.load(frame.runId).receipts.length,16);
  clock+=3600000;
  const old=await host.accept({receipt:originalReceipt,attestation:originalSigned});
  assert.equal(old.duplicate,true);
  assert.equal(old.acceptedRevision,firstRevision);
  checkJournal(f.store,frame.runId);
});

test('S07 pre-upgrade inline receipt history is transactionally indexed before the next receipt is committed',async t=>{
  const f=await fixture(t,2);
  const first=await waiting(f);
  const receiptA=receipt(first,{answer:'a'});
  const afterA=await f.api.complete(receiptA);
  assert.equal(afterA.status,'waiting');
  const original=f.store.load(first.runId).receipts[0];
  const db=new DatabaseSync(f.file);
  try {
    const count=db.prepare('DELETE FROM fk_i_receipt_index WHERE namespace=? AND run_id=? AND request_id=?')
      .run('s07',first.runId,receiptA.requestId).changes;
    assert.equal(count,1);
  } finally {db.close()}
  assert.deepEqual(f.store.getReceipt(first.runId,receiptA.requestId),original);
  const afterB=await f.api.complete(receipt(afterA,{answer:'b'}));
  assert.equal(afterB.status,'succeeded');
  assert.equal(f.store.getReceipt(first.runId,receiptA.requestId).acceptedRevision,original.acceptedRevision);
  const db2=new DatabaseSync(f.file);
  try {
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM fk_i_receipt_index WHERE namespace=? AND run_id=?')
      .get('s07',first.runId).n,2);
  }finally{db2.close()}
});

test('S07 corrupting receipt index identity cannot turn a different body into accepted duplicate',async t=>{
  const f=await fixture(t);
  const w=await waiting(f);
  await f.api.complete(receipt(w));
  const db=new DatabaseSync(f.file);
  try{
    db.prepare('UPDATE fk_i_receipt_index SET digest=? WHERE namespace=? AND run_id=? AND request_id=?')
      .run('sha256:'+'e'.repeat(64),'s07',w.runId,w.pending.requestId);
  }finally{db.close()}
  assert.throws(()=>f.store.getReceipt(w.runId,w.pending.requestId),{code:'FK_I_STORE_CORRUPT'});
  await assert.rejects(f.api.complete(receipt(w)),{code:'FK_I_STORE_CORRUPT'});
});
