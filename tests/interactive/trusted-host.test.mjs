import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {
  createAgentReceiptStatement,encodeAgentReceiptStatement,normalizeHostAgentReceipt,
} from '../../src/interactive/host-attestation.mjs';

const dirs=[];
after(async()=>{for(const p of dirs)await rm(p,{recursive:true,force:true})});
const CLOCK=1794400000000;
const runtime={
  skillResolver:async descriptor=>'Validated instruction: '+descriptor.nodeId,
  validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['answer required'],
};
const dsl="import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';\n";
const source=dsl+
  "export default defineWorkflow({id:'m5-agent',version:'1.0.0',name:'M5',nodes:["+
  "condition('gate',{name:'Gate',branches:[{when:'ready',next:'worker'},{when:'true',next:'fail'}]}),"+
  "node('worker',{name:'Worker',agent:'writer',inputs:['existing'],output:{type:'object',properties:{answer:{type:'string'}}},retries:1,next:'done'}),"+
  "terminal('done',{name:'Done',status:'succeeded'}),"+
  "terminal('fail',{name:'Fail',status:'failed'})]});";

async function compile(text=source) {
  const analyzed=await analyzeSource(text,{
    filename:'m5.workflow.js',projectRoot:process.cwd(),skillCheck:false,
  });
  assert.ok(!analyzed.diagnostics.some(d=>d.severity==='error'),JSON.stringify(analyzed.diagnostics));
  const lowered=lowerInteractive(analyzed);
  assert.ok(lowered.ir,JSON.stringify(lowered.diagnostics));
  const emitted=emitInteractive(lowered.ir);
  assert.ok(emitted.code);
  return {programBytes:Buffer.from(emitted.code),programIdentity:emitted.programIdentity};
}
async function fixture(t,options={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-m5-'));
  dirs.push(dir);
  const store=createSqliteCheckpointStore(path.join(dir,'run.db'),{namespace:'tenant-m5'});
  t.after(()=>store.close());
  const program=await compile();
  const keys=generateKeyPairSync('ed25519');
  const hostOptions={
    store,runtime,
    policy:{hostVersion:'1'},
    trustedPublicKeys:{'host-a':keys.publicKey},
    trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:['existing'],
    disclosurePolicyId:'disclosure-v1',
    authorizeDisclosure:async()=>true,
    now:()=>CLOCK,
    ...options,
  };
  const host=createTrustedInteractiveHost(hostOptions);
  return {dir,store,program,keys,host,hostOptions};
}
async function waiting(t,options={}) {
  const f=await fixture(t,options);
  const frame=await f.host.start({
    ...f.program, startKey:'run-'+f.dir,
    state:{ready:true,existing:'public input',secret:'Host private data'},
  });
  assert.equal(frame.status,'waiting');
  return {...f,frame};
}
function agentResult(frame,result={answer:'safe'}) {
  return {
    runId:frame.runId,requestId:frame.pending.requestId,
    nodeId:frame.pending.nodeId,attempt:frame.pending.attempt,
    kind:'agent-result',result,
  };
}
function proof(run,receipt,privateKey,{
  keyId='host-a',proofId='provider-event-1',
  issuedAt=CLOCK-1000,expiresAt=CLOCK+10000,
}={}) {
  const statement=createAgentReceiptStatement({
    run,receipt,keyId,proofId,issuedAt,expiresAt,
  });
  const signature=sign(null,encodeAgentReceiptStatement(statement),privateKey).toString('base64url');
  return {statement,signature};
}
async function rejectUnchanged(f,receipt,attestation) {
  const cp=f.store.load(f.frame.runId);
  const before=canonicalBytes(cp);
  const count=f.store.listJournal(f.frame.runId).length;
  await assert.rejects(f.host.accept({receipt,attestation}),{code:'FK_I_PROVENANCE_REJECTED'});
  assert.deepEqual(canonicalBytes(f.store.load(f.frame.runId)),before);
  assert.equal(f.store.listJournal(f.frame.runId).length,count);
}

test('Host drains the old policy, blocks revoked workers across connections, and reads only the exact original Ack',async t=>{
  let approved=false;
  const f=await waiting(t,{authorizeReceiptAudit:request=>approved && request.action==='receipt:read-history'});
  const secondStore=createSqliteCheckpointStore(path.join(f.dir,'run.db'),{namespace:f.store.namespace});
  t.after(()=>secondStore.close());
  const oldWorker=createTrustedInteractiveHost({...f.hostOptions,store:secondStore});
  const pending=await oldWorker.start({...f.program,startKey:'pending-old',state:{ready:true}});
  const nextKeys=generateKeyPairSync('ed25519');
  const nextHost=createTrustedInteractiveHost({...f.hostOptions,store:secondStore,
    trustedPublicKeys:{next:nextKeys.publicKey},authorizeKeyRevocation:()=>approved});
  const drain=createTrustedInteractiveHost({...f.hostOptions,drainOnly:true});
  await assert.rejects(oldWorker.start({...f.program,startKey:'should-not-start',state:{ready:true}}),
    {code:'FK_I_HOST_DENIED'});
  const receipt=agentResult(f.frame);
  const attestation=proof(f.store.load(receipt.runId),receipt,f.keys.privateKey);
  const accepted=await drain.accept({receipt,attestation});
  assert.equal(accepted.status,'succeeded');
  const next=await nextHost.start({...f.program,startKey:'new-policy',state:{ready:true}});
  assert.equal(next.status,'waiting');
  assert.notEqual(f.store.load(next.runId).policyHash,f.store.load(pending.runId).policyHash);

  const oldKeyHash=sha256Bytes(f.keys.publicKey.export({type:'spki',format:'der'}));
  await assert.rejects(nextHost.revokeKey(oldKeyHash),{code:'FK_I_HOST_DENIED'});
  const pendingReceipt=agentResult(pending);
  const pendingProof=proof(f.store.load(pending.runId),pendingReceipt,f.keys.privateKey);
  const call={threadId:'thread',turnId:'turn',callId:'call',tool:'flowkit_submit',
    args:{requestId:pendingReceipt.requestId,answer:'safe'}};
  const outbox=openCodexOutbox({database:path.join(f.dir,'outbox.sqlite'),store:secondStore,host:oldWorker,now:()=>CLOCK});
  t.after(()=>outbox.close());
  const pendingTask=await oldWorker.getPublicAgentTask({runId:pending.runId});
  const observed={task:pendingTask,started:call,callback:call,modelPid:100};
  let unsigned;
  approved=true;
  await assert.rejects(outbox.record(observed,pendingReceipt,f.keys.privateKey,{
    async afterObserve(row) {
      unsigned=row.proofId;
      assert.equal(await nextHost.revokeKey(oldKeyHash),true);
    },
  }),{code:'FK_I_HOST_DENIED'});
  assert.equal(outbox.describe(unsigned).state,'OBSERVED');
  assert.equal(outbox.describe(unsigned).statementHash,undefined);
  assert.equal(await nextHost.revokeKey(oldKeyHash),false);
  await assert.rejects(oldWorker.resume({runId:pending.runId}),{code:'FK_I_HOST_DENIED'});
  await assert.rejects(oldWorker.accept({receipt:pendingReceipt,attestation:pendingProof}),{code:'FK_I_PROVENANCE_REJECTED'});
  await assert.rejects(oldWorker.accept({receipt,attestation}),{code:'FK_I_PROVENANCE_REJECTED'});
  assert.equal(f.store.getReceipt(pending.runId,pendingReceipt.requestId),null);
  assert.equal((await nextHost.resume({runId:next.runId})).status,'waiting');
  const {namespace,runId,requestId,nodeId,attempt,receiptHash}=attestation.statement;
  const query={namespace,runId,requestId,nodeId,attempt,receiptHash};
  const before=f.store.load(runId);
  const journal=f.store.listJournal(runId);
  for (const malformed of [{namespace:'other'},{receiptHash:'sha256:'+'0'.repeat(64)},{attempt:2}]) {
    await assert.rejects(f.host.readHistoricalAck({...query,...malformed}),{code:'FK_I_HOST_DENIED'});
  }
  await assert.rejects(f.host.readHistoricalAck({...query,runId:pending.runId,requestId:pendingReceipt.requestId}),
    {code:'FK_I_HOST_DENIED'});
  assert.deepEqual(await f.host.readHistoricalAck(query),{...query,acceptedRevision:accepted.acceptedRevision});
  assert.deepEqual(await f.host.readHistoricalAck(query),{...query,acceptedRevision:accepted.acceptedRevision});
  assert.deepEqual(f.store.load(runId),before);
  assert.deepEqual(f.store.listJournal(runId),journal);
});

test('M5 authorized public task contains only allowlisted declared input, not State or Host internals',async t=>{
  const f=await waiting(t);
  const task=await f.host.getPublicAgentTask({runId:f.frame.runId});
  assert.equal(task.schemaVersion,1);
  assert.equal(task.requestId,f.frame.pending.requestId);
  assert.equal(task.id,'worker');
  assert.deepEqual(task.input,{existing:'public input'});
  assert.deepEqual(task.missing,[]);
  assert.equal(task.instruction,'Validated instruction: worker');
  for(const forbidden of ['namespace','artifactHash','policyHash','secret','ready','state',
    'checkpoint','candidate','controlStack','receipts','signer','privateKey']) {
    assert.equal(Object.hasOwn(task,forbidden),false,forbidden);
  }
  assert.equal(JSON.stringify(task).includes('Host private data'),false);
  assert.equal((await f.host.getPublicAgentTask({runId:f.frame.runId})).requestId,task.requestId);
  assert.equal(f.store.load(f.frame.runId).revision,f.frame.revision);
});

test('CF-05: terminal projection and trusted result require separate permissions',async t=>{
  let allowedAction='run:read';
  const calls=[];
  const f=await waiting(t,{
    authorizeTerminalAccess:async context=>{
      calls.push(context);
      return context.action===allowedAction;
    },
  });
  const runId=f.frame.runId;
  await assert.rejects(f.host.getPublicTerminalFrame({runId}),{code:'FK_I_HOST_DENIED'});
  const receipt=agentResult(f.frame);
  const completed=await f.host.accept({receipt,attestation:proof(f.store.load(runId),receipt,f.keys.privateKey)});
  const resultRef={runId,revision:completed.revision,projectionVersion:1};
  const before=canonicalBytes(f.store.load(runId));
  const journal=f.store.listJournal(runId);

  const frame=await f.host.getPublicTerminalFrame({runId});
  assert.deepEqual(frame,{
    protocolVersion:1,runId,revision:completed.revision,status:'succeeded',pending:[],
    checkpointRef:{runId,revision:completed.revision},terminal:{nodeId:'done',status:'succeeded'},resultRef,
  });
  await assert.rejects(f.host.readTrustedTerminalResult({resultRef}),{code:'FK_I_HOST_DENIED'});
  allowedAction='result:read';
  await assert.rejects(f.host.getPublicTerminalFrame({runId}),{code:'FK_I_HOST_DENIED'});
  const result=await f.host.readTrustedTerminalResult({resultRef});
  assert.deepEqual(result,{
    projectionVersion:1,namespace:'tenant-m5',runId,status:'succeeded',
    terminal:{nodeId:'done',status:'succeeded'},state:completed.state,contextError:null,
  });
  assert.ok(calls.every(context=>Object.isFrozen(context) &&
    context.namespace==='tenant-m5' && context.runId===runId && context.revision===completed.revision));
  await assert.rejects(f.host.readTrustedTerminalResult({
    resultRef:{...resultRef,revision:resultRef.revision-1},
  }),{code:'FK_I_HOST_DENIED'});

  const unconfigured=createTrustedInteractiveHost({...f.hostOptions,authorizeTerminalAccess:undefined});
  await assert.rejects(unconfigured.getPublicTerminalFrame({runId}),{code:'FK_I_HOST_DENIED'});
  const otherStore=createSqliteCheckpointStore(path.join(f.dir,'run.db'),{namespace:'another-tenant'});
  t.after(()=>otherStore.close());
  const other=createTrustedInteractiveHost({...f.hostOptions,store:otherStore,authorizeTerminalAccess:()=>true});
  await assert.rejects(other.readTrustedTerminalResult({resultRef}),{code:'FK_I_HOST_DENIED'});
  assert.deepEqual(canonicalBytes(f.store.load(runId)),before);
  assert.deepEqual(f.store.listJournal(runId),journal);
});

test('CF-05: public error terminal omits the private cause and State',async t=>{
  const f=await fixture(t,{authorizeTerminalAccess:()=>true});
  const frame=await f.host.start({
    ...f.program,startKey:'terminal-with-error',state:{secret:'Host private data'},
  });
  assert.equal(frame.status,'errored');
  const projection=await f.host.getPublicTerminalFrame({runId:frame.runId});
  assert.equal(projection.status,'errored');
  assert.equal(Object.hasOwn(projection,'terminal'),false);
  assert.equal(Object.hasOwn(projection,'causeCode'),false);
  assert.equal(Object.hasOwn(projection,'state'),false);
  const result=await f.host.readTrustedTerminalResult({resultRef:projection.resultRef});
  assert.equal(result.causeCode,'FK_R002');
  assert.deepEqual(result.state,{secret:'Host private data'});
});

test('M5 strict disclosure allowlist and authorizer both fail closed with zero CAS writes',async t=>{
  for(const options of [
    {allowedInputKeys:[]},
    {authorizeDisclosure:async()=>false},
    {authorizeDisclosure:async()=>({approved:true})},
    {authorizeDisclosure:async()=>{throw Error('Private DLP details')}},
  ]) {
    const f=await waiting(t,options);
    const before=canonicalBytes(f.store.load(f.frame.runId));
    await assert.rejects(f.host.getPublicAgentTask({runId:f.frame.runId}),error=>
      error.code==='FK_I_HOST_DENIED' && !error.message.includes('Private DLP details'));
    assert.deepEqual(canonicalBytes(f.store.load(f.frame.runId)),before);
  }
});

test('M5 trusted Ed25519 Agent receipt completes, and signed retransmission returns durable Ack',async t=>{
  const f=await waiting(t);
  const receipt=agentResult(f.frame,{answer:'signed'});
  const attestation=proof(f.store.load(f.frame.runId),receipt,f.keys.privateKey);
  const completed=await f.host.accept({receipt,attestation});
  assert.equal(completed.status,'succeeded');
  assert.equal(completed.state.secret,'Host private data');
  assert.equal(completed.state.answer,'signed');
  const retry=await f.host.accept({receipt,attestation});
  assert.equal(retry.duplicate,true);
  assert.equal(retry.acceptedRevision,completed.acceptedRevision);
  assert.equal(retry.revision,completed.revision);
  assert.equal(await f.host.getPublicAgentTask({runId:f.frame.runId}),null);
});

test('M5 cannot forge provenance with arbitrary string, unknown key, other signature or modified body',async t=>{
  const f=await waiting(t);
  const receipt=agentResult(f.frame);
  const run=f.store.load(f.frame.runId);
  const authentic=proof(run,receipt,f.keys.privateKey);
  const attacker=generateKeyPairSync('ed25519');
  await rejectUnchanged(f,receipt,{statement:authentic.statement,signature:'not-a-signature'});
  await rejectUnchanged(f,receipt,{'provenanceRef':'host-approval-123'});
  await rejectUnchanged(f,receipt,{statement:authentic.statement,
    signature:proof(run,receipt,attacker.privateKey).signature});
  await rejectUnchanged(f,receipt,{statement:{...authentic.statement,keyId:'fake-key'},
    signature:authentic.signature});
  await rejectUnchanged(f,{...receipt,result:{answer:'tampered'}},authentic);
  await rejectUnchanged(f,{...receipt,attempt:receipt.attempt+1},authentic);
  await rejectUnchanged(f,{...receipt,requestId:'different'},authentic);
  await rejectUnchanged(f,receipt,{statement:{...authentic.statement,namespace:'other-tenant'},
    signature:authentic.signature});
  await rejectUnchanged(f,receipt,{statement:{...authentic.statement,policyHash:'sha256:'+'f'.repeat(64)},
    signature:authentic.signature});
  await rejectUnchanged(f,receipt,{statement:{...authentic.statement,artifactHash:'sha256:'+'f'.repeat(64)},
    signature:authentic.signature});
});

test('M5 proof time checks reject expiry, future, excessive lifetime and bad signing context before CAS',async t=>{
  const f=await waiting(t);
  const receipt=agentResult(f.frame);
  const run=f.store.load(f.frame.runId);
  for(const range of [
    {issuedAt:CLOCK-300000,expiresAt:CLOCK-30000},
    {issuedAt:CLOCK+60000,expiresAt:CLOCK+120000},
    {issuedAt:CLOCK-300000,expiresAt:CLOCK+100000},
  ]) {
    await rejectUnchanged(f,receipt,proof(run,receipt,f.keys.privateKey,range));
  }
  const wrong=proof(run,receipt,f.keys.privateKey,{keyId:'host-other'});
  await rejectUnchanged(f,receipt,wrong);
});

test('M5 cannot authorize Human/Action/Verification or model-picked fields by signed agent proof',async t=>{
  const f=await waiting(t);
  const normal=agentResult(f.frame);
  const signed=proof(f.store.load(f.frame.runId),normal,f.keys.privateKey);
  for(const changed of [
    {...normal,kind:'human',approved:true},
    {...normal,kind:'action'},
    {...normal,kind:'verification'},
    {...normal,transitionId:'injected'},
    {...normal,provenanceRef:'model-approval'},
    {...normal,source:'fake'},
  ]) {
    await rejectUnchanged(f,changed,signed);
  }
  const readOnly=f.store.load(f.frame.runId);
  assert.equal(readOnly.pending.requestId,f.frame.pending.requestId);
});

test('M5 strictly rejects malformed Agent failure receipt prior to verifier and Store mutation',async t=>{
  const f=await waiting(t);
  for(const body of [
    {kind:'agent-call-failed',failure:{message:7}},
    {kind:'agent-call-failed',failure:{message:'',unexpected:true}},
    {kind:'agent-call-failed',failure:{message:'x'},result:{}},
    {kind:'agent-result'},
  ]) {
    const invalid={runId:f.frame.runId,requestId:f.frame.pending.requestId,
      nodeId:'worker',attempt:1,...body};
    await rejectUnchanged(f,invalid,{});
  }
});

test('M5 signed Host-reported failure retries through the same Coordinator receipt CAS',async t=>{
  const f=await waiting(t);
  const receipt={
    runId:f.frame.runId,requestId:f.frame.pending.requestId,
    nodeId:'worker',attempt:1,kind:'agent-call-failed',failure:{message:'provider timeout'},
  };
  const attestation=proof(f.store.load(f.frame.runId),receipt,f.keys.privateKey);
  const next=await f.host.accept({receipt,attestation});
  assert.equal(next.status,'waiting');
  assert.equal(next.pending.attempt,2);
  assert.notEqual(next.pending.requestId,receipt.requestId);
  assert.deepEqual(next.pending.reasons,['runAgent threw: provider timeout']);
});

test('M5 rejects unapproved Program bytes *before importing/executing* them',async t=>{
  const f=await fixture(t);
  const alt=await compile(dsl+"export default defineWorkflow({id:'alt',version:'1.0.0',name:'Alternate',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});");
  const hash=alt.programIdentity.artifactHash;
  assert.notEqual(hash,f.program.programIdentity.artifactHash);
  const modified=Buffer.from(alt.programBytes.toString('utf8')+'\nthrow Error("untrusted side effect");\n');
  const attempted={...alt,programBytes:modified,programIdentity:{
    ...alt.programIdentity,
    artifactHash:sha256Bytes(modified),
  }};
  await assert.rejects(f.host.start({...attempted,startKey:'malicious',state:{}}),{code:'FK_I_HOST_DENIED'});
  assert.equal(f.store.getArtifact(attempted.programIdentity.artifactHash),null);
  await assert.rejects(f.host.start({...alt,startKey:'unapproved',state:{}}),{code:'FK_I_HOST_DENIED'});
  assert.equal(f.store.getArtifact(hash),null);
});

test('M5 trust-key, artifact and disclosure policy changes invalidate previously pinned policy',async t=>{
  const f=await waiting(t);
  const next=generateKeyPairSync('ed25519');
  const changed=createTrustedInteractiveHost({
    ...f.hostOptions,trustedPublicKeys:{'host-b':next.publicKey},
  });
  await assert.rejects(changed.resume({runId:f.frame.runId}),{code:'FK_I_HOST_DENIED'});
  const rotatedAllowlist=createTrustedInteractiveHost({
    ...f.hostOptions,allowedInputKeys:['existing','secret'],
  });
  await assert.rejects(rotatedAllowlist.load({runId:f.frame.runId}),{code:'FK_I_HOST_DENIED'});
  assert.deepEqual(await f.host.resume({runId:f.frame.runId}),f.frame);
});

test('M5 host constructor fails closed without a signer trust root or disclosure approval policy',async t=>{
  const f=await fixture(t);
  for(const invalid of [
    {trustedPublicKeys:{}},
    {trustedPublicKeys:{'key':generateKeyPairSync('rsa',{modulusLength:2048}).publicKey}},
    {trustedArtifacts:[]},
    {allowedInputKeys:['existing','existing']},
    {authorizeDisclosure:undefined},
    {disclosurePolicyId:undefined},
    {maxProofAgeMs:3600001},
  ]) {
    assert.throws(()=>createTrustedInteractiveHost({...f.hostOptions,...invalid}));
  }
});

test('M5 object prototype, proxy, accessor and undefined cannot bypass signed receipt canonicalization',async t=>{
  const f=await waiting(t);
  const valid=agentResult(f.frame);
  const signed=proof(f.store.load(f.frame.runId),valid,f.keys.privateKey);
  const getter={...valid};
  Object.defineProperty(getter,'result',{enumerable:true,get(){throw Error('getter triggered')}});
  const cycle={};cycle.self=cycle;
  for(const receipt of [getter,new Proxy(valid,{}),{...valid,result:{answer:-0}},
    {...valid,result:cycle},{...valid,result:undefined}]) {
    await rejectUnchanged(f,receipt,signed);
  }
  assert.throws(()=>normalizeHostAgentReceipt({...valid,extra:true}),/PROVENANCE_REJECTED/);
});


test('M5 async disclosure approval never releases a Pending superseded by another Host',async t=>{
  let finishWhileApproving;
  const f=await waiting(t,{
    authorizeDisclosure:async()=>{
      await finishWhileApproving();
      return true;
    },
  });
  finishWhileApproving=async()=>{
    const receipt=agentResult(f.frame,{answer:'already-completed'});
    const attestation=proof(f.store.load(f.frame.runId),receipt,f.keys.privateKey);
    const completed=await f.host.accept({receipt,attestation});
    assert.equal(completed.status,'succeeded');
  };
  await assert.rejects(f.host.getPublicAgentTask({runId:f.frame.runId}),{
    code:'FK_I_HOST_DENIED',
  });
  assert.equal(f.store.load(f.frame.runId).status,'succeeded');
  assert.equal(f.store.load(f.frame.runId).state.answer,'already-completed');
  assert.equal(await f.host.getPublicAgentTask({runId:f.frame.runId}),null);
});


test('M5 missing-input field names are also covered by explicit public allowlist',async t=>{
  const f=await fixture(t);
  const alternative=await compile(source.replace(
    "inputs:['existing']","inputs:['existing','secretKeyName']",
  ));
  const host=createTrustedInteractiveHost({
    ...f.hostOptions,
    trustedArtifacts:[alternative.programIdentity.artifactHash],
    allowedInputKeys:['existing'],
  });
  const pending=await host.start({
    ...alternative,startKey:'missing-sensitive-field',
    state:{ready:true,existing:'safe'},
  });
  assert.equal(pending.status,'waiting');
  assert.deepEqual(pending.pending.missing,['secretKeyName']);
  const snapshot=canonicalBytes(f.store.load(pending.runId));
  await assert.rejects(host.getPublicAgentTask({runId:pending.runId}),{
    code:'FK_I_HOST_DENIED',
  });
  assert.deepEqual(canonicalBytes(f.store.load(pending.runId)),snapshot);
});


test('M5 expired authentic proof re-acks an already accepted identical receipt, never a new one',async t=>{
  let clock=CLOCK;
  const f=await waiting(t,{now:()=>clock});
  const receipt=agentResult(f.frame,{answer:'finished'});
  const signed=proof(f.store.load(f.frame.runId),receipt,f.keys.privateKey,{
    issuedAt:CLOCK-1000,expiresAt:CLOCK+10000,
  });
  const done=await f.host.accept({receipt,attestation:signed});
  assert.equal(done.status,'succeeded');
  clock=CLOCK+3600000; // Much later than the original proof validity.
  const replay=await f.host.accept({receipt,attestation:signed});
  assert.equal(replay.duplicate,true);
  assert.equal(replay.acceptedRevision,done.acceptedRevision);
  assert.equal(replay.revision,done.revision);
  const mutated={...receipt,result:{answer:'not previously accepted'}};
  await rejectUnchanged(f,mutated,signed);
});


test('M5 even VALIDLY signed proofs for a wrong tenant, Program, policy, request or result are rejected',async t=>{
  const f=await waiting(t);
  const receipt=agentResult(f.frame,{answer:'authoritative'});
  const run=f.store.load(f.frame.runId);
  const cases=[
    proof({...run,namespace:'attacker-tenant'},receipt,f.keys.privateKey),
    proof({...run,artifactHash:'sha256:'+'a'.repeat(64)},receipt,f.keys.privateKey),
    proof({...run,policyHash:'sha256:'+'b'.repeat(64)},receipt,f.keys.privateKey),
    proof(run,{...receipt,requestId:'other-request'},f.keys.privateKey),
    proof(run,{...receipt,nodeId:'other-node'},f.keys.privateKey),
    proof(run,{...receipt,attempt:receipt.attempt+1},f.keys.privateKey),
    proof(run,{...receipt,result:{answer:'different-result'}},f.keys.privateKey),
  ];
  for(const attestation of cases) {
    // All attestations have actual, mathematically valid Host signatures.
    // They must fail on the expected authoritative run identity/body.
    await rejectUnchanged(f,receipt,attestation);
  }
});
