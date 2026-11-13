import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {copyFile,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from '../security/p0a-ops-fixture.mjs';

test('quiesced R5 Store and Outbox backups reopen together and recover a signed receipt',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-staging-backup-'));
  const resources=[];
  t.after(async()=>{
    for (const db of resources.reverse()) db.close();
    await rm(root,{recursive:true,force:true});
  });
  const program=await compileOpsWorkflow(root);
  const key=generateKeyPairSync('ed25519');
  const clock=Date.now();
  const open=prefix=>{
    const storeFile=path.join(root,prefix+'-store.sqlite');
    const outboxFile=path.join(root,prefix+'-outbox.sqlite');
    const store=createSqliteCheckpointStore(storeFile,{namespace:'staging-backup'});
    const host=createTrustedInteractiveHost({store,runtime:opsRuntime,now:()=>clock,
      trustedPublicKeys:{proof:key.publicKey},trustedArtifacts:[program.programIdentity.artifactHash],
      allowedInputKeys:['question'],disclosurePolicyId:'staging-backup',authorizeDisclosure:()=>true,
      authorizeReceiptAudit:()=>true});
    const outbox=openCodexOutbox({database:outboxFile,store,host,now:()=>clock});
    resources.push(store,outbox);
    return {store,outbox,host,storeFile,outboxFile};
  };
  const live=open('live');
  async function signed(label) {
    const {runId}=await live.host.start(opsStart(program,label));
    const task=await live.host.getPublicAgentTask({runId});
    const {requestId,nodeId,attempt}=task;
    const call={tool:'flowkit_submit',callId:label,threadId:'test-thread',turnId:label,args:{requestId,answer:'ready'}};
    const proofId=await live.outbox.record({task,started:call,callback:call,modelPid:process.pid},
      {runId,requestId,nodeId,attempt,kind:'agent-result',result:{answer:'ready'}},key.privateKey);
    return {task,proofId};
  }
  const accepted=await signed('acknowledged');
  await live.outbox.deliver(accepted.proofId);
  const pending=await signed('pending');
  const state=(store,{task})=>({checkpoint:store.load(task.runId),journal:store.listJournal(task.runId),
    receipt:store.getReceipt(task.runId,task.requestId)});
  const before=[accepted,pending].map(item=>state(live.store,item));
  const [ackBefore,pendingBefore]=[accepted,pending].map(item=>live.outbox.describe(item.proofId));
  const hashes={};
  // There are no active writers between the two snapshots.
  for (const [label,file] of [['store',live.storeFile],['outbox',live.outboxFile]]) {
    const snapshot=path.join(root,`backup-${label}.sqlite`);
    const db=new DatabaseSync(file);
    try {db.prepare('VACUUM INTO ?').run(snapshot);} finally {db.close();}
    const checked=new DatabaseSync(snapshot,{readOnly:true});
    try {assert.equal(checked.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}
    finally {checked.close();}
    hashes[label]=createHash('sha256').update(await readFile(snapshot)).digest('hex');
    await copyFile(snapshot,path.join(root,`restored-${label}.sqlite`));
  }
  const restored=open('restored');
  assert.deepEqual([accepted,pending].map(item=>state(restored.store,item)),before);
  assert.deepEqual(restored.outbox.describe(accepted.proofId),ackBefore);
  assert.deepEqual(restored.outbox.describe(pending.proofId),pendingBefore);
  const {runId,requestId,nodeId,attempt}=accepted.task;
  const ack=await restored.host.readHistoricalAck({namespace:'staging-backup',runId,requestId,nodeId,attempt,
    receiptHash:ackBefore.receiptHash});
  assert.equal(ack.acceptedRevision,ackBefore.acceptedRevision);
  const recovered=await restored.outbox.deliver(pending.proofId);
  assert.equal(recovered.status,'succeeded');
  const restoredProof=restored.outbox.describe(pending.proofId);
  assert.equal(restoredProof.signatureHash,pendingBefore.signatureHash);
  assert.equal(restoredProof.state,'ACKED');
  assert.deepEqual(state(live.store,pending),before[1]);
  assert.deepEqual(live.outbox.describe(pending.proofId),pendingBefore);
  console.log('P0A_BACKUP '+JSON.stringify({integrity:'ok',hashes,originalAck:ack.acceptedRevision,
    recoveredAck:restoredProof.acceptedRevision,signatureReused:true,sourceUnchanged:true}));
});
