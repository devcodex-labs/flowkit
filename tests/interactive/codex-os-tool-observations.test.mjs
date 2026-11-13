import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createAgentReceiptStatement,createSqliteCheckpointStore,createTrustedInteractiveHost,
  encodeAgentReceiptStatement} from '../../src/interactive/index.mjs';
import {createOsToolObservations,dispatchObservedOsTool} from '../security/codex-os-tool-observations.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from '../security/p0a-ops-fixture.mjs';

const turn={threadId:'thread',turnId:'turn'};
const args={requestId:'request',answer:'ready'};
const tool='flowkit_submit';
const start=(id,input=args)=>({...turn,item:{id,tool,arguments:input}});
const callback=(callId,input=args)=>({...turn,callId,tool,arguments:input});

test('OS-bound tool calls require a matching start recorded before the callback',()=>{
  const observations=createOsToolObservations();
  assert.equal(observations.consume(callback('missing')),null);
  observations.record(start('missing'));
  assert.equal(observations.consume(callback('missing')),null);

  observations.record(start('different',{...args,answer:'other'}));
  assert.equal(observations.consume(callback('different')),null);

  observations.record(start('valid'));
  assert.deepEqual(observations.consume(callback('valid',{answer:'ready',requestId:'request'})),
    {...turn,tool,arguments:args});
  assert.equal(observations.consume(callback('valid')),null);
});

test('observation state belongs to one turn and preserves the first start',()=>{
  const observations=createOsToolObservations();
  observations.record(start('call'));
  observations.record(start('call',{...args,answer:'other'}));
  assert.deepEqual(observations.consume(callback('call')),{...turn,tool,arguments:args});

  observations.record(start('other-turn'));
  assert.equal(observations.consume({...callback('other-turn'),turnId:'different'}),null);
  const next=createOsToolObservations();
  next.record(start('call'));
  assert.ok(next.consume(callback('call')));
});

test('observation denial returns immediately and the same Pending remains available to the next turn',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-os-observation-'));
  let store;
  t.after(async()=>{
    store?.close();
    await rm(root,{recursive:true,force:true});
  });
  const program=await compileOpsWorkflow(root);
  store=createSqliteCheckpointStore(path.join(root,'run.sqlite'),{namespace:'tenant-observation'});
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  let signatures=0,cas=0;
  const host=createTrustedInteractiveHost({
    store:{...store,compareAndSwap(input){cas++;return store.compareAndSwap(input);}},
    runtime:opsRuntime,trustedPublicKeys:{proof:publicKey},
    trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:['question'],disclosurePolicyId:'observation-fixture',authorizeDisclosure:()=>true,
  });
  const {runId}=await host.start(opsStart(program,'observation-recovery'));
  const task=await host.getPublicAgentTask({runId});
  const {requestId,nodeId,attempt}=task;
  const input={requestId,answer:'ready'};
  const snapshot=()=>({run:store.load(runId),journal:store.listJournal(runId),
    receipt:store.getReceipt(runId,requestId),cas,signatures});
  const before=snapshot();
  assert.equal(before.run.status,'waiting');
  assert.equal(before.receipt,null);
  const accept=async observation=>{
    assert.deepEqual(observation.arguments,input);
    const receipt={runId,requestId,nodeId,attempt,kind:'agent-result',result:{answer:input.answer}};
    const issuedAt=Date.now();
    const statement=createAgentReceiptStatement({run:store.load(runId),receipt,keyId:'proof',proofId:'next-call',
      issuedAt,expiresAt:issuedAt+30000});
    const signature=sign(null,encodeAgentReceiptStatement(statement),privateKey).toString('base64url');
    signatures++;
    return host.accept({receipt,attestation:{statement,signature}});
  };

  const observations=createOsToolObservations();
  const denied={accepted:false,code:'REQUEST_DENIED'};
  let denials=0;
  const onDenied=()=>{denials++;};
  assert.deepEqual(dispatchObservedOsTool(null,callback('unbound-call',input),accept,onDenied),denied);
  assert.deepEqual(dispatchObservedOsTool(observations,callback('prior-call',input),accept,onDenied),denied);
  observations.record(start('prior-call',input));
  assert.deepEqual(dispatchObservedOsTool(observations,callback('prior-call',input),accept,onDenied),denied);
  observations.record(start('different',{...input,answer:'other'}));
  assert.deepEqual(dispatchObservedOsTool(observations,callback('different',input),accept,onDenied),denied);
  assert.equal(denials,4);
  assert.deepEqual(snapshot(),before);
  assert.deepEqual(await host.getPublicAgentTask({runId}),task);

  const next=createOsToolObservations();
  next.record({...start('next-call',input),turnId:'next-turn'});
  const accepted=await dispatchObservedOsTool(next,{...callback('next-call',input),turnId:'next-turn'},accept,onDenied);
  assert.equal(accepted.status,'succeeded');
  assert.equal(denials,4);
  assert.equal(signatures,1);
  assert.ok(cas>before.cas);
  assert.equal(store.getReceipt(runId,requestId).acceptedRevision,accepted.acceptedRevision);
  assert.equal(store.listJournal(runId).length,accepted.revision+1);
  assert.equal(await host.getPublicAgentTask({runId}),null);
});
