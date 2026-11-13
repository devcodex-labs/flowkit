import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from '../security/p0a-ops-fixture.mjs';

async function testBackup(t,fileHandoff) {
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-staging-backup-'));
  const resources=[];
  t.after(async()=>{
    for (const db of resources.reverse()) db.close();
    await rm(root,{recursive:true,force:true});
  });
  const program=await compileOpsWorkflow(root,{fileHandoff});
  const key=generateKeyPairSync('ed25519');
  const clock=Date.now();
  const bytes=fileHandoff?canonicalBytes({answer:'A'.repeat(262144-13)}):null;
  if (fileHandoff) assert.equal(bytes.length,262144);
  const open=async prefix=>{
    const storeFile=path.join(root,prefix+'-store.sqlite');
    const outboxFile=path.join(root,prefix+'-outbox.sqlite');
    const handoffFile=path.join(root,prefix+'-handoff.sqlite');
    const inbox=path.join(root,prefix+'-inbox');
    let handoff;
    if (fileHandoff) {
      await mkdir(inbox);
      handoff=createFileHandoff({database:handoffFile,inbox,now:()=>clock,
        validateArtifact:value=>canonicalBytes(value).equals(bytes)});
      resources.push(handoff);
    }
    const store=createSqliteCheckpointStore(storeFile,{namespace:'staging-backup'});
    resources.push(store);
    const runtime=fileHandoff?{...opsRuntime,validateResult(_schema,{artifact}) {
      const saved=artifact&&handoff.readSnapshot(artifact.id);
      return saved?.bytes.equals(bytes)&&saved.sha256===artifact.sha256?[]:['Expected original file bytes'];
    }}:opsRuntime;
    const host=createTrustedInteractiveHost({store,runtime,now:()=>clock,
      trustedPublicKeys:{proof:key.publicKey},trustedArtifacts:[program.programIdentity.artifactHash],
      allowedInputKeys:['question'],disclosurePolicyId:'staging-backup',authorizeDisclosure:()=>true,
      authorizeReceiptAudit:()=>true});
    const outbox=openCodexOutbox({database:outboxFile,store,host,handoff,now:()=>clock});
    resources.push(outbox);
    return {store,outbox,host,handoff,inbox,storeFile,outboxFile,handoffFile};
  };
  const live=await open('live');
  async function signed(label) {
    const {runId}=await live.host.start(opsStart(program,label));
    const task=await live.host.getPublicAgentTask({runId});
    const {requestId,nodeId,attempt}=task;
    if (fileHandoff) {
      const cp=live.store.load(runId);
      const sourceId=randomUUID();
      const file=path.join(live.inbox,sourceId+'.json');
      await writeFile(file,bytes,{flag:'wx'});
      const binding={runId,requestId,nodeId,attempt,namespace:live.store.namespace,threadId:'test-thread',
        turnId:label,programHash:cp.artifactHash,policyHash:cp.policyHash};
      const reference=await live.handoff.stage({sourceId,binding,byteLength:bytes.length,sha256:sha256Bytes(bytes)});
      await unlink(file);
      const call={tool:'flowkit_submit_file',callId:label,threadId:binding.threadId,turnId:label,arguments:reference};
      let proofId;
      const interrupted=new Error('Test stopped after durable signing');
      await assert.rejects(live.handoff.consume({started:call,callback:call,loadPending:live.store.load,
        async signAndAccept({artifact}) {
          const observed={...call,args:reference};
          proofId=await live.outbox.record({task,started:observed,callback:observed,modelPid:process.pid},
            {runId,requestId,nodeId,attempt,kind:'agent-result',result:{artifact}},key.privateKey);
          throw interrupted;
        }}),error=>error===interrupted);
      return {task,proofId,fileId:reference.id};
    }
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
  // There are no active writers across the snapshot set.
  const databases=[['store',live.storeFile],['outbox',live.outboxFile]];
  if (fileHandoff) databases.push(['handoff',live.handoffFile]);
  for (const [label,file] of databases) {
    const snapshot=path.join(root,`backup-${label}.sqlite`);
    const db=new DatabaseSync(file);
    try {db.prepare('VACUUM INTO ?').run(snapshot);} finally {db.close();}
    const checked=new DatabaseSync(snapshot,{readOnly:true});
    try {assert.equal(checked.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}
    finally {checked.close();}
    hashes[label]=createHash('sha256').update(await readFile(snapshot)).digest('hex');
    await copyFile(snapshot,path.join(root,`restored-${label}.sqlite`));
  }
  const restored=await open('restored');
  assert.deepEqual([accepted,pending].map(item=>state(restored.store,item)),before);
  assert.deepEqual(restored.outbox.describe(accepted.proofId),ackBefore);
  assert.deepEqual(restored.outbox.describe(pending.proofId),pendingBefore);
  if (fileHandoff) {
    const saved=restored.handoff.readSnapshot(pending.fileId);
    assert.equal(saved.state,'claimed');
    assert.deepEqual(saved.bytes,bytes);
    assert.deepEqual(restored.handoff.readSnapshot(accepted.fileId),live.handoff.readSnapshot(accepted.fileId));
  }
  const {runId,requestId,nodeId,attempt}=accepted.task;
  const ack=await restored.host.readHistoricalAck({namespace:'staging-backup',runId,requestId,nodeId,attempt,
    receiptHash:ackBefore.receiptHash});
  assert.equal(ack.acceptedRevision,ackBefore.acceptedRevision);
  assert.deepEqual(await restored.outbox.recover(runId),[]);
  const recovered=await restored.outbox.recover(pending.task.runId);
  assert.equal(recovered.length,1);
  const [restoredProof]=recovered;
  assert.equal(restoredProof.proofId,pending.proofId);
  assert.equal(restored.store.load(pending.task.runId).status,'succeeded');
  assert.equal(restored.store.getReceipt(pending.task.runId,pending.task.requestId).acceptedRevision,
    restoredProof.acceptedRevision);
  assert.equal(restoredProof.signatureHash,pendingBefore.signatureHash);
  assert.equal(restoredProof.state,'ACKED');
  const afterRecovery=state(restored.store,pending);
  assert.deepEqual(await restored.outbox.recover(pending.task.runId),[]);
  assert.deepEqual(state(restored.store,pending),afterRecovery);
  assert.deepEqual(state(restored.store,accepted),before[0]);
  if (fileHandoff) {
    const saved=restored.handoff.readSnapshot(pending.fileId);
    assert.deepEqual(saved.bytes,bytes);
    assert.equal(saved.state,'acked');
    assert.equal(saved.acceptedRevision,restoredProof.acceptedRevision);
    assert.equal(live.handoff.readSnapshot(pending.fileId).state,'claimed');
  }
  assert.deepEqual([accepted,pending].map(item=>state(live.store,item)),before);
  assert.deepEqual(live.outbox.describe(accepted.proofId),ackBefore);
  assert.deepEqual(live.outbox.describe(pending.proofId),pendingBefore);
  console.log('P0A_BACKUP '+JSON.stringify({integrity:'ok',hashes,originalAck:ack.acceptedRevision,
    recoveredAck:restoredProof.acceptedRevision,autoDiscovered:recovered.length,secondScan:0,
    signatureReused:true,sourceUnchanged:true,
    ...(fileHandoff?{fileBytes:bytes.length,fileSha256:sha256Bytes(bytes)}:{})}));
}

test('quiesced R5 Store and Outbox backups reopen together and recover a signed receipt',t=>testBackup(t,false));
test('quiesced R5 backup recovers a signed file receipt from its private snapshot',t=>testBackup(t,true));
