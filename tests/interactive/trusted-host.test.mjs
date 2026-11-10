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
