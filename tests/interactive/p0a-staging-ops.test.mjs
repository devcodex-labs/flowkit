import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from '../security/p0a-ops-fixture.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-staging-ops-'));
  const resources=[];
  t.after(async()=>{
    for (const resource of resources.reverse()) resource.close();
    await rm(root,{recursive:true,force:true});
  });
  return {root,resources,program:await compileOpsWorkflow(root)};
}

function makeHost(f,store,keys,overrides={}) {
  return createTrustedInteractiveHost({store,runtime:opsRuntime,allowedInputKeys:['question'],
    trustedPublicKeys:{proof:keys.publicKey},trustedArtifacts:[f.program.programIdentity.artifactHash],
    disclosurePolicyId:'p0a-staging-ops',authorizeDisclosure:()=>true,...overrides});
}

async function makeTask(f,host,startKey) {
  const frame=await host.start(opsStart(f.program,startKey));
  assert.equal(frame.status,'waiting');
  return host.getPublicAgentTask({runId:frame.runId});
}

function signTask(task,outbox,keys,startKey) {
  const {runId,requestId,nodeId,attempt}=task;
  const answer='ready';
  const call={threadId:'fixture',turnId:'turn-'+startKey,callId:'call-'+startKey,tool:'flowkit_submit',args:{requestId,answer}};
  return outbox.record({task,started:call,callback:call,modelPid:process.pid},
    {runId,requestId,nodeId,attempt,kind:'agent-result',result:{answer}},keys.privateKey);
}

function snapshot(store,{runId,requestId}) {
  return {checkpoint:store.load(runId),journal:store.listJournal(runId),receipt:store.getReceipt(runId,requestId)};
}

test('test admission stays paused for every Store until the inventory has confirmed revocation',async t=>{
  const f=await fixture(t);
  const oldKeys=generateKeyPairSync('ed25519'),nextKeys=generateKeyPairSync('ed25519');
  const oldHash=sha256Bytes(oldKeys.publicKey.export({type:'spki',format:'der'}));
  const names=['store-a','store-b','store-c'];
  const approval=new Set(['store-a','store-c']);
  const confirmed=new Set();
  const inventory=new Map();
  for (const namespace of names) {
    const store=createSqliteCheckpointStore(path.join(f.root,namespace+'.sqlite'),{namespace});
    const oldHost=makeHost(f,store,oldKeys);
    const newHost=makeHost(f,store,nextKeys,{authorizeKeyRevocation:()=>approval.has(namespace)});
    const outbox=openCodexOutbox({database:path.join(f.root,namespace+'-outbox.sqlite'),store,host:oldHost});
    f.resources.push(store,outbox);
    const task=await makeTask(f,oldHost,'old-in-flight');
    const proof=await signTask(task,outbox,oldKeys,'old-in-flight');
    inventory.set(namespace,{store,newHost,outbox,task,proof});
  }
  const revoke=async namespace=>{
    assert.equal(await inventory.get(namespace).newHost.revokeKey(oldHash),true);
    confirmed.add(namespace);
  };
  // Every test admission goes through this gate. It represents one deployed inventory only.
  const admit=(namespace,key)=>{
    if (confirmed.size!==inventory.size) throw Object.assign(new Error('Test admission paused'),{code:'STAGING_PAUSED'});
    return inventory.get(namespace).newHost.start(opsStart(f.program,key));
  };
  const snapshots=()=>[...inventory.values()].map(({store,task})=>snapshot(store,task));
  const before=snapshots();
  const first=await Promise.allSettled(names.map(revoke));
  assert.deepEqual(first.map(result=>result.status),['fulfilled','rejected','fulfilled']);
  assert.equal(first[1].reason.code,'FK_I_HOST_DENIED');
  for (const namespace of names) assert.throws(()=>admit(namespace,'before-resume'),{code:'STAGING_PAUSED'});
  assert.deepEqual(snapshots(),before);
  approval.add('store-b');
  await revoke('store-b');
  for (const namespace of names) {
    const {outbox,proof}=inventory.get(namespace);
    await assert.rejects(outbox.deliver(proof),{code:'FK_I_PROVENANCE_REJECTED'});
    assert.equal((await admit(namespace,'after-resume')).status,'waiting');
  }
  assert.deepEqual(snapshots(),before);
  console.log('P0A_STAGING '+JSON.stringify({case:'admission-pause',inventory:names,
    firstRoundDenied:['store-b'],blockedAdmissions:names.length,reopenedAdmissions:names.length,rejectedOldProofs:names.length}));
});

function post(port,event) {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify(event);
    const req=request({hostname:'127.0.0.1',port,path:'/capacity',method:'POST',agent:false,
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},
      signal:AbortSignal.timeout(15000)},res=>{
      let data='';
      res.setEncoding('utf8').on('data',part=>{data+=part;});
      res.on('error',reject);
      res.on('end',()=>{
        try {resolve({status:res.statusCode,body:JSON.parse(data)});}
        catch(error) {reject(error);}
      });
    });
    req.on('error',reject);
    req.end(body);
  });
}

test('paced capacity load delivers recorded alerts to a separate loopback process',async t=>{
  const f=await fixture(t);
  const alertFile=path.join(f.root,'alerts.ndjson');
  const receiver=fork(new URL('../security/p0a-staging-alert-receiver.mjs',import.meta.url),[alertFile],{execArgv:[]});
  const closed=once(receiver,'exit');
  t.after(async()=>{
    if (receiver.connected) receiver.disconnect();
    const timer=setTimeout(()=>receiver.kill(),5000);
    try {assert.deepEqual(await closed,[0,null]);}
    finally {clearTimeout(timer);}
  });
  const [{pid,port}]=await Promise.race([once(receiver,'message',{signal:AbortSignal.timeout(15000)}),
    closed.then(()=>{throw new Error('Alert receiver exited before ready');})]);
  assert.equal(pid,receiver.pid);
  assert.notEqual(pid,process.pid);
  const keys=generateKeyPairSync('ed25519');
  const storeFile=path.join(f.root,'load.sqlite');
  const outboxFile=path.join(f.root,'load-outbox.sqlite');
  const store=createSqliteCheckpointStore(storeFile,{namespace:'load'});
  let now=Date.now(),delivery,sequence=0;
  const host=makeHost(f,store,keys,{now:()=>now});
  const cap=16,batches=8;
  const outbox=openCodexOutbox({database:outboxFile,store,host,now:()=>now,maxRecords:cap,retentionMs:1000,
    authorizeCleanup:()=>({allowed:true,heldRunIds:[]}),
    onCapacity(event) {delivery=post(port,{...event,sequence:++sequence});},
  });
  f.resources.push(store,outbox);
  async function sampleDisk() {
    const sizes=await Promise.all([storeFile,outboxFile].flatMap(file=>['','-wal','-shm'].map(suffix=>
      stat(file+suffix).then(info=>info.size,error=>{if(error.code==='ENOENT')return 0;throw error;}))));
    return sizes.reduce((sum,size)=>sum+size,0);
  }
  const expected=[];
  const samples=[];
  const started=performance.now();
  for (let batch=1;batch<=batches;batch++) {
    for (let index=0;index<cap;index++) {
      const key=`${batch}-${index}`;
      const task=await makeTask(f,host,key);
      const proof=await signTask(task,outbox,keys,key);
      assert.equal((await outbox.deliver(proof)).status,'succeeded');
      await sleep(10);
    }
    const key=`over-${batch}`;
    const pending=await makeTask(f,host,key);
    const before=snapshot(store,pending);
    await assert.rejects(signTask(pending,outbox,keys,key),{code:'FK_OUTBOX_CAPACITY'});
    assert.deepEqual(snapshot(store,pending),before);
    const event={receiverPid:pid,sequence:batch,namespace:'load',records:cap,maxRecords:cap};
    assert.deepEqual(await delivery,{status:202,body:event});
    expected.push(event);
    const fullBytes=await sampleDisk();
    now+=1001;
    const cleanup=await outbox.cleanup({namespace:'load',subjectId:'test-operator',reasonCode:'STAGING_TEST'});
    assert.equal(cleanup.deleted,cap);
    assert.equal(outbox.usage().records,0);
    samples.push({batch,fullBytes,afterCleanupBytes:await sampleDisk()});
  }
  const saved=(await readFile(alertFile,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(saved,expected);
  console.log('P0A_STAGING '+JSON.stringify({case:'recorded-alert-load',senderPid:process.pid,receiverPid:pid,
    accepted:batches*cap,elapsedMs:Math.round(performance.now()-started),receipts:saved,samples}));
});
