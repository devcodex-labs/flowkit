/**
 * P0-A S07: trusted Host transport oversize outcomes.
 * The mocked transport observation below is deterministic test evidence,
 * NOT an authenticated real-model provider session (S13 remains blocked).
 * An oversized unverified model response never gains Coordinator authority.
 */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {canonicalBytes} from '../../src/interactive/canonical.mjs';
import {
  createAgentReceiptStatement,encodeAgentReceiptStatement,
  MAX_AGENT_RECEIPT_BYTES,
} from '../../src/interactive/host-attestation.mjs';

const roots=[];
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true})});
const NOW=1794400000000;
const runtime={
  skillResolver:async()=> 'Return a small structured answer or a data reference',
  validateResult:(_schema,result)=>typeof result?.answer==='string'
    ? []:['answer must be a string'],
};

async function fixture(t,retries=1){
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-host-oversize-'));
  roots.push(root);
  const filename=path.join(root,'run.sqlite');
  const definition=[
    "import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';",
    "export default defineWorkflow({id:'host-oversize',version:'1.0.0',name:'Host Oversize',nodes:[",
    "node('worker',{name:'Worker',agent:'writer',inputs:[],",
    "output:{type:'object',properties:{answer:{type:'string'}}},",
    "retries:"+retries+",next:'done'}),",
    "terminal('done',{name:'Done',status:'succeeded'})]});",
  ].join('\n');
  const analysis=await analyzeSource(definition,{
    filename:'host-oversize.workflow.js',projectRoot:root,skillCheck:false,
  });
  assert.equal(analysis.diagnostics.some(d=>d.severity==='error'),false,
    JSON.stringify(analysis.diagnostics));
  const lower=lowerInteractive(analysis);
  assert.ok(lower.ir,JSON.stringify(lower.diagnostics));
  const compiled=emitInteractive(lower.ir);
  assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
  const program={
    programBytes:Buffer.from(compiled.code),
    programIdentity:compiled.programIdentity,
  };
  const keys=generateKeyPairSync('ed25519');
  const store=createSqliteCheckpointStore(filename,{namespace:'trusted-oversize'});
  t.after(()=>store.close());
  const options={
    store,runtime,policy:{contract:'host-oversize-v1'},
    trustedPublicKeys:{transport:keys.publicKey},
    trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:[],disclosurePolicyId:'host-private-disclosure-v1',
    authorizeDisclosure:async()=>true,now:()=>NOW,
  };
  const host=createTrustedInteractiveHost(options);
  const runId='oversize-run-'+retries;
  const started=await host.start({...program,runId,startKey:runId,
    state:{approved:true,privateField:'not sent to model'}});
  assert.equal(started.status,'waiting');
  const task=await host.getPublicAgentTask({runId});
  assert.ok(task);
  assert.equal(Object.hasOwn(task,'privateField'),false);
  return {root,filename,store,keys,options,host,task,started};
}

function makeReceipt(task,kind,payload){
  return {
    runId:task.runId,requestId:task.requestId,nodeId:task.nodeId,
    attempt:task.attempt,kind,
    ...(kind==='agent-result'?{result:payload}:{failure:{message:payload}}),
  };
}

function attestation(store,receipt,privateKey,proofId){
  const statement=createAgentReceiptStatement({
    run:store.load(receipt.runId),
    receipt,keyId:'transport',proofId,issuedAt:NOW-1000,expiresAt:NOW+10000,
  });
  return {
    statement,signature:sign(null,encodeAgentReceiptStatement(statement),privateKey)
      .toString('base64url'),
  };
}

function unchanged(f,cp,journal){
  assert.deepEqual(canonicalBytes(f.store.load(f.task.runId)),cp);
  assert.deepEqual(f.store.listJournal(f.task.runId),journal);
}

test('S07 oversized raw model receipt cannot terminate the Run without authenticated transport evidence',async t=>{
  const f=await fixture(t);
  const before=canonicalBytes(f.store.load(f.task.runId));
  const journal=f.store.listJournal(f.task.runId);
  const huge=makeReceipt(f.task,'agent-result',{answer:'x'.repeat(MAX_AGENT_RECEIPT_BYTES+1024)});
  await assert.rejects(f.host.accept({
    receipt:huge,attestation:{statement:{},signature:'model-claimed-proof'},
  }),{code:'FK_I_PROVENANCE_REJECTED'});
  // The legacy signer API correctly refuses to manufacture proof for bytes
  // that are not representable in the signed v1 receipt contract.
  assert.throws(()=>createAgentReceiptStatement({
    run:f.store.load(f.task.runId),receipt:huge,keyId:'transport',
    proofId:'invalid-large',issuedAt:NOW-1000,expiresAt:NOW+10000,
  }),{code:'FK_I_PROVENANCE_REJECTED'});
  unchanged(f,before,journal);
  assert.equal((await f.host.load({runId:f.task.runId})).status,'waiting');
  assert.equal(f.store.getReceipt(f.task.runId,f.task.requestId),null);

  // A malicious model also cannot turn its unsupported output into an
  // authenticated failure by adding a small, fabricated failure body.
  const pretendFailure=makeReceipt(f.task,'agent-call-failed',
    'Model claims its own output exceeded a capacity bound');
  await assert.rejects(f.host.accept({
    receipt:pretendFailure,
    attestation:{statement:{kind:'agent-call-failed'},signature:'fake'},
  }),{code:'FK_I_PROVENANCE_REJECTED'});
  unchanged(f,before,journal);
});

test('S07 trusted transport size failure signs an existing bounded failure receipt, retries once, then accepts a small reference',async t=>{
  const f=await fixture(t,1);
  const hugeRaw=makeReceipt(f.task,'agent-result',{
    answer:'model-output'.repeat(200000),
  });
  assert.ok(hugeRaw.result.answer.length>MAX_AGENT_RECEIPT_BYTES);
  const cp=canonicalBytes(f.store.load(f.task.runId));
  await assert.rejects(f.host.accept({
    receipt:hugeRaw,attestation:null,
  }),{code:'FK_I_PROVENANCE_REJECTED'});
  assert.deepEqual(canonicalBytes(f.store.load(f.task.runId)),cp);

  // Simulated *trusted transport* observation, NOT model-authored instructions.
  // The Host independently observed excess bytes from the bound provider call,
  // so it deliberately creates a tiny protocol failure rather than signing
  // an oversized result. This changes no FlowKit SDK or execution ABI.
  const observedTransportEvent={
    kind:'provider-output-size-limit',
    sessionId:'host-verified-session-001',
    requestId:f.task.requestId,
    observedBytes:Buffer.byteLength(hugeRaw.result.answer,'utf8'),
  };
  assert.equal(observedTransportEvent.kind,'provider-output-size-limit');
  assert.equal(observedTransportEvent.requestId,f.task.requestId);
  assert.ok(observedTransportEvent.observedBytes>MAX_AGENT_RECEIPT_BYTES);
  const failure=makeReceipt(f.task,'agent-call-failed',
    'FK_I_AGENT_OUTPUT_TOO_LARGE: trusted provider response exceeded 2 MiB');
  const signedFailure=attestation(f.store,failure,f.keys.privateKey,'observed-provider-limit-1');
  const afterFailure=await f.host.accept({receipt:failure,attestation:signedFailure});
  assert.equal(afterFailure.status,'waiting');
  assert.equal(afterFailure.pending.attempt,2);
  assert.notEqual(afterFailure.pending.requestId,f.task.requestId);
  assert.deepEqual(f.store.load(f.task.runId).state,{
    approved:true,privateField:'not sent to model',
  });
  assert.equal(f.store.getReceipt(f.task.runId,f.task.requestId).acceptedRevision,
    afterFailure.acceptedRevision);
  assert.equal(f.store.listJournal(f.task.runId).length,afterFailure.revision+1);
  assert.equal(JSON.stringify(f.store.listJournal(f.task.runId))
    .includes(hugeRaw.result.answer.slice(0,1000)),false);

  // A lost response to the first signed failure gets its ORIGINAL Ack and
  // cannot create a third attempt.
  const duplicate=await f.host.accept({receipt:failure,attestation:signedFailure});
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.acceptedRevision,afterFailure.acceptedRevision);
  assert.equal(duplicate.pending.requestId,afterFailure.pending.requestId);

  // Recover through a new trusted Host object with same pinned policy, key,
  // Program and SQLite Store; no original output bytes are needed.
  const reopened=createTrustedInteractiveHost(f.options);
  const second=await reopened.getPublicAgentTask({runId:f.task.runId});
  assert.equal(second.attempt,2);
  const small=makeReceipt(second,'agent-result',{answer:'context-ref:result-001'});
  const signed=attestation(f.store,small,f.keys.privateKey,'observed-provider-result-2');
  const completed=await reopened.accept({receipt:small,attestation:signed});
  assert.equal(completed.status,'succeeded');
  assert.equal(completed.state.answer,'context-ref:result-001');
  assert.equal(completed.state.privateField,'not sent to model');
  assert.equal(completed.revision,f.store.listJournal(f.task.runId).length-1);
  const old=await reopened.accept({receipt:failure,attestation:signedFailure});
  assert.equal(old.duplicate,true);
  assert.equal(old.acceptedRevision,afterFailure.acceptedRevision);
  assert.equal(old.status,'succeeded');
});

test('S07 trusted transport oversize failure with no retries exits FK_R004 durably, not by unverified payload mutation',async t=>{
  const f=await fixture(t,0);
  const failure=makeReceipt(f.task,'agent-call-failed',
    'FK_I_AGENT_OUTPUT_TOO_LARGE: Host observed response-size limit');
  const signed=attestation(f.store,failure,f.keys.privateKey,'observed-provider-limit-0');
  const ended=await f.host.accept({receipt:failure,attestation:signed});
  assert.equal(ended.status,'errored');
  assert.equal(ended.terminal.causeCode,'FK_R004');
  assert.deepEqual(ended.state,{
    approved:true,privateField:'not sent to model',
  });
  assert.equal(f.store.load(f.task.runId).pending,null);
  assert.equal(f.store.getReceipt(f.task.runId,f.task.requestId).acceptedRevision,
    ended.acceptedRevision);
  assert.equal(f.store.listJournal(f.task.runId).length,ended.revision+1);
  assert.equal((await f.host.resume({runId:f.task.runId})).revision,ended.revision);
  const old=await f.host.accept({receipt:failure,attestation:signed});
  assert.equal(old.duplicate,true);
  assert.equal(old.acceptedRevision,ended.acceptedRevision);
});
