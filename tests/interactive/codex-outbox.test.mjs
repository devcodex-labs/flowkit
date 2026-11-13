import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';
import {sha256Bytes} from '../../src/interactive/canonical.mjs';
import {encodeAgentReceiptStatement} from '../../src/interactive/host-attestation.mjs';

test('Codex Outbox replays exact signed bytes, reconciles historical Ack and blocks expired work',async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'flowkit-outbox-'));
  const database=path.join(directory,'outbox.sqlite');
  const keys=generateKeyPairSync('ed25519');
  const pending={runId:'run',requestId:'pending',nodeId:'agent',attempt:1};
  const task={...pending,input:{question:'Answer ready'}};
  const checkpoint={namespace:'host',status:'waiting',pending,
    artifactHash:'sha256:'+'1'.repeat(64),policyHash:'sha256:'+'2'.repeat(64)};
  const receipt={...pending,kind:'agent-result',result:{answer:'ready'}};
  const call={threadId:'thread',turnId:'turn',callId:'call',tool:'flowkit_submit',
    args:{requestId:'pending',answer:'ready'}};
  let ack=null,accepts=0,now=1000;
  const store={namespace:'host',load:()=>checkpoint,getReceipt:()=>ack};
  const host={accept({receipt:supplied,attestation:{statement,signature}}) {
    assert.deepEqual(supplied,receipt);
    assert.ok(verify(null,encodeAgentReceiptStatement(statement),keys.publicKey,Buffer.from(signature,'base64url')));
    accepts++;
    ack??={digest:statement.receiptHash,nodeId:receipt.nodeId,attempt:receipt.attempt,acceptedRevision:4};
    return {acceptedRevision:ack.acceptedRevision};
  }};
  const open=()=>openCodexOutbox({database,store,host,now:()=>now});
  let outbox=open();
  t.after(()=>{outbox.close();rmSync(directory,{recursive:true,force:true});});
  const observed=(callback=call,started=callback)=>({task,modelPid:100,callback,started});
  await assert.rejects(outbox.record(observed(call,{...call,turnId:'other'}),receipt,keys.privateKey),
    {code:'FK_OUTBOX_OBSERVATION'});
  let unsigned;
  await assert.rejects(outbox.record(observed({...call,callId:'unsigned'}),receipt,keys.privateKey,{
    afterObserve(row) {unsigned=row;throw new Error('before signing');},
  }),/before signing/);
  assert.equal(unsigned.state,'OBSERVED');
  assert.equal(unsigned.statementHash,undefined);
  assert.deepEqual(await outbox.recover('run'),[]);
  assert.equal(accepts,0);
  const id=await outbox.record(observed(),receipt,keys.privateKey);
  await assert.rejects(outbox.record(observed(),receipt,keys.privateKey));
  const signed=outbox.describe(id);
  assert.equal(signed.state,'SIGNED');
  assert.equal(accepts,0);
  await assert.rejects(outbox.deliver(id,{afterAccept:()=>{throw new Error('after CAS');}}),/after CAS/);
  assert.deepEqual(outbox.describe(id),signed);
  assert.equal(ack.acceptedRevision,4);
  outbox.close();
  outbox=open();
  assert.deepEqual(await outbox.recover('run'),[{...signed,state:'ACKED',acceptedRevision:4}]);
  assert.deepEqual(await outbox.recover('run'),[]);
  assert.equal(accepts,2);

  const retry=await outbox.record(observed({...call,callId:'retry'}),receipt,keys.privateKey);
  const expired=await outbox.record(observed({...call,callId:'expired',args:{...call.args,answer:'stale'}}),
    {...receipt,result:{answer:'stale'}},keys.privateKey);
  now+=120001;
  assert.deepEqual((await outbox.recover('run')).map(row=>[row.proofId,row.state]),[[retry,'ACKED'],[expired,'BLOCKED']]);
  assert.equal(accepts,3);
});

test('file Outbox recovery verifies the claimed bytes and replays an already-recorded file Ack',async t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'flowkit-file-outbox-'));
  const inbox=path.join(directory,'inbox');
  const handoffDatabase=path.join(directory,'file.sqlite');
  const database=path.join(directory,'outbox.sqlite');
  mkdirSync(inbox);
  const handoff=createFileHandoff({database:handoffDatabase,inbox,validateArtifact:()=>true});
  const keys=generateKeyPairSync('ed25519');
  const pending={runId:'run',requestId:'request',nodeId:'agent',attempt:1};
  const binding={...pending,namespace:'host',threadId:'thread',turnId:'turn',
    programHash:'sha256:'+'1'.repeat(64),policyHash:'sha256:'+'2'.repeat(64)};
  const cp={...pending,namespace:'host',status:'waiting',pending,artifactHash:binding.programHash,policyHash:binding.policyHash};
  const bytes=Buffer.from('{"answer":"ready"}');
  const sourceId=randomUUID();
  const file=path.join(inbox,sourceId+'.json');
  writeFileSync(file,bytes);
  let ack=null,accepts=0;
  const store={namespace:'host',load:()=>cp,getReceipt:()=>ack};
  const host={accept({attestation:{statement}}) {
    accepts++;
    ack={digest:statement.receiptHash,nodeId:pending.nodeId,attempt:1,acceptedRevision:4};
    return {acceptedRevision:4};
  }};
  const outbox=openCodexOutbox({database,store,host,handoff});
  t.after(()=>{outbox.close();handoff.close();rmSync(directory,{recursive:true,force:true});});
  const reference=await handoff.stage({sourceId,binding,byteLength:bytes.length,sha256:sha256Bytes(bytes)});
  unlinkSync(file);
  const event={threadId:binding.threadId,turnId:binding.turnId,callId:'call',tool:'flowkit_submit_file'};
  const call={...event,arguments:reference};
  let proofId;
  await assert.rejects(handoff.consume({started:call,callback:call,loadPending:store.load,
    async signAndAccept({artifact}) {
      const observed={...event,args:reference};
      const receipt={...pending,kind:'agent-result',result:{artifact}};
      await assert.rejects(outbox.record({task:pending,started:observed,callback:observed,modelPid:100},
        {...receipt,result:{artifact:{...artifact,sha256:binding.programHash}}},keys.privateKey),{code:'FK_FILE_BINDING'});
      proofId=await outbox.record({task:pending,started:observed,callback:observed,modelPid:100},receipt,keys.privateKey);
      throw new Error('after signed');
    }}),/after signed/);
  const db=new DatabaseSync(handoffDatabase);
  try {
    const update=db.prepare('UPDATE file_handoff SET bytes=? WHERE id=?');
    update.run(Buffer.alloc(bytes.length),reference.id);
    await assert.rejects(outbox.recover('run'),{code:'FK_FILE_STORE'});
    assert.equal(accepts,0);
    update.run(bytes,reference.id);
  } finally {db.close();}
  await assert.rejects(outbox.deliver(proofId,{afterAccept:()=>{throw new Error('after CAS');}}),/after CAS/);
  handoff.acknowledge(reference.id,event.callId,ack.acceptedRevision);
  assert.equal((await outbox.recover('run'))[0].state,'ACKED');
  assert.deepEqual(handoff.readSnapshot(reference.id),{bytes,sha256:sha256Bytes(bytes),byteLength:bytes.length,
    state:'acked',acceptedRevision:4});
  assert.deepEqual(await outbox.recover('run'),[]);
});
