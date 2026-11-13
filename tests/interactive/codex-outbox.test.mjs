import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
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
  assert.throws(()=>outbox.record(observed(call,{...call,turnId:'other'}),receipt,keys.privateKey),
    {code:'FK_OUTBOX_OBSERVATION'});
  const id=outbox.record(observed(),receipt,keys.privateKey);
  assert.throws(()=>outbox.record(observed(),receipt,keys.privateKey));
  const signed=outbox.describe(id);
  assert.equal(signed.state,'SIGNED');
  assert.equal(accepts,0);
  outbox.close();
  outbox=open();
  assert.deepEqual(await outbox.recover('run'),[{...signed,state:'ACKED',acceptedRevision:4}]);
  assert.deepEqual(await outbox.recover('run'),[]);
  assert.equal(accepts,1);

  const retry=outbox.record(observed({...call,callId:'retry'}),receipt,keys.privateKey);
  const expired=outbox.record(observed({...call,callId:'expired',args:{...call.args,answer:'stale'}}),
    {...receipt,result:{answer:'stale'}},keys.privateKey);
  now+=120001;
  assert.deepEqual((await outbox.recover('run')).map(row=>[row.proofId,row.state]),[[retry,'ACKED'],[expired,'BLOCKED']]);
  assert.equal(accepts,2);
});
