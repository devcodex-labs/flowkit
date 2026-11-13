import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {createServer,request} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from '../security/p0a-ops-fixture.mjs';

async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-p0a-ops-'));
  const resources=[];
  t.after(async()=>{
    for (const resource of resources.reverse()) resource.close();
    await rm(root,{recursive:true,force:true});
  });
  return {root,resources,program:await compileOpsWorkflow(root)};
}

function openStore(f,namespace,keys,now,permissions={}) {
  const file=path.join(f.root,namespace+'.sqlite');
  const store=createSqliteCheckpointStore(file,{namespace});
  const host=createTrustedInteractiveHost({store,runtime:opsRuntime,now,
    trustedPublicKeys:{proof:keys.publicKey},trustedArtifacts:[f.program.programIdentity.artifactHash],
    allowedInputKeys:['question'],disclosurePolicyId:'p0a-ops-fixture',authorizeDisclosure:()=>true,...permissions});
  f.resources.push(store);
  return {file,store,host};
}

function inputFor(task,answer,callId) {
  const {runId,requestId,nodeId,attempt}=task;
  const call={threadId:'test-transport',turnId:'test-'+callId,callId,tool:'flowkit_submit',args:{requestId,answer}};
  return {evidence:{task,started:call,callback:call,modelPid:process.pid},
    receipt:{runId,requestId,nodeId,attempt,kind:'agent-result',result:{answer}}};
}

async function makeTask(f,host,startKey) {
  const frame=await host.start(opsStart(f.program,startKey));
  assert.equal(frame.status,'waiting');
  return host.getPublicAgentTask({runId:frame.runId});
}

function progress(store,task) {
  return {checkpoint:store.load(task.runId),journal:store.listJournal(task.runId),
    receipt:store.getReceipt(task.runId,task.requestId)};
}

test('all entries in the test Store inventory must confirm revocation before resuming',async t=>{
  const f=await fixture(t);
  const oldKeys=generateKeyPairSync('ed25519');
  const nextKeys=generateKeyPairSync('ed25519');
  const oldHash=sha256Bytes(oldKeys.publicKey.export({type:'spki',format:'der'}));
  const inventory=[];
  for (const namespace of ['store-a','store-b','store-c']) {
    const {file,store,host}=openStore(f,namespace,oldKeys,Date.now,{authorizeReceiptAudit:()=>true});
    let approved=namespace!=='store-b';
    const nextHost=createTrustedInteractiveHost({store,runtime:opsRuntime,
      trustedPublicKeys:{proof:nextKeys.publicKey},trustedArtifacts:[f.program.programIdentity.artifactHash],
      allowedInputKeys:['question'],disclosurePolicyId:'p0a-ops-fixture',authorizeDisclosure:()=>true,
      authorizeKeyRevocation:()=>approved});
    const outbox=openCodexOutbox({database:path.join(f.root,namespace+'-outbox.sqlite'),store,host});
    f.resources.push(outbox);
    const accepted=await makeTask(f,host,'completed');
    const done=inputFor(accepted,'ready','accepted');
    const completedProof=await outbox.record(done.evidence,done.receipt,oldKeys.privateKey);
    const complete=await outbox.deliver(completedProof);
    const history=outbox.describe(completedProof);
    const pending=await makeTask(f,host,'in-flight');
    const deferred=inputFor(pending,'ready','in-flight');
    const signed=await outbox.record(deferred.evidence,deferred.receipt,oldKeys.privateKey);
    inventory.push({namespace,file,store,host,nextHost,outbox,accepted,complete,history,pending,signed,
      original:progress(store,pending),approve:()=>{approved=true;}});
  }
  const rotate=item=>item.nextHost.revokeKey(oldHash);
  const first=await Promise.allSettled(inventory.map(rotate));
  assert.deepEqual(first.map(item=>item.status),['fulfilled','rejected','fulfilled']);
  assert.equal(first[1].reason.code,'FK_I_HOST_DENIED');
  const held=inventory.filter((_,index)=>first[index].status!=='fulfilled').map(item=>item.namespace);
  assert.deepEqual(held,['store-b']);
  assert.equal((await inventory[1].host.resume({runId:inventory[1].pending.runId})).status,'waiting');
  inventory[1].approve();
  assert.equal(await rotate(inventory[1]),true);
  for (const item of inventory) {
    assert.equal(await rotate(item),false);
    await assert.rejects(item.outbox.deliver(item.signed),{code:'FK_I_PROVENANCE_REJECTED'});
    assert.deepEqual(progress(item.store,item.pending),item.original);
    const {runId,requestId,nodeId,attempt}=item.accepted;
    const ack=await item.host.readHistoricalAck({namespace:item.namespace,runId,requestId,nodeId,attempt,
      receiptHash:item.history.receiptHash});
    assert.equal(ack.acceptedRevision,item.complete.acceptedRevision);
    const newTask=await makeTask(f,item.nextHost,'new-policy');
    assert.notEqual(item.store.load(newTask.runId).policyHash,item.original.checkpoint.policyHash);
  }
  console.log('P0A_OPS '+JSON.stringify({case:'inventory-revocation',stores:inventory.map(item=>item.namespace),
    firstAttemptHold:held,confirmed:inventory.length,rejectedDeferred:inventory.length,historicalAcks:inventory.length}));
});

test('bounded Outbox load sends capacity alarms to a loopback HTTP receiver',async t=>{
  const f=await fixture(t);
  const clock={now:Date.now()};
  const keys=generateKeyPairSync('ed25519');
  const {file,store,host}=openStore(f,'load',keys,()=>clock.now);
  const acceptedEvents=[];
  const delivery=[];
  const server=createServer(async(req,res)=>{
    let data='';
    for await (const chunk of req) data+=chunk;
    if (req.method!=='POST' || req.url!=='/capacity') {res.writeHead(404).end();return;}
    acceptedEvents.push(JSON.parse(data));
    res.writeHead(202).end();
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const database=path.join(f.root,'load-outbox.sqlite');
  const outbox=openCodexOutbox({database,store,host,now:()=>clock.now,maxRecords:16,retentionMs:1000,
    authorizeCleanup:({subjectId})=>({allowed:subjectId==='fixture-operator',heldRunIds:[]}),
    onCapacity(event) {
      delivery.push(new Promise((resolve,reject)=>{
        const body=JSON.stringify(event);
        const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/capacity',method:'POST',agent:false,
          headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
          signal:AbortSignal.timeout(15000)},response=>{
          response.on('error',reject);
          response.on('end',()=>resolve(response.statusCode));
          response.resume();
        });
        req.on('error',reject);
        req.end(body);
      }));
    }});
  f.resources.push(outbox);
  const physical=async()=>{
    const items=await Promise.all([file,database].flatMap(name=>[name,name+'-wal',name+'-shm'])
      .map(name=>stat(name).then(info=>info.size,error=>{if(error.code!=='ENOENT')throw error;return 0;})));
    return items.reduce((sum,size)=>sum+size,0);
  };
  const started=performance.now();
  const samples=[];
  for (let batch=0;batch<6;batch++) {
    for (let index=0;index<16;index++) {
      const id=`${batch}-${index}`;
      const task=await makeTask(f,host,id);
      const input=inputFor(task,'ready',id);
      const proof=await outbox.record(input.evidence,input.receipt,keys.privateKey);
      assert.equal((await outbox.deliver(proof)).status,'succeeded');
    }
    const pending=await makeTask(f,host,'overflow-'+batch);
    const before=progress(store,pending);
    const input=inputFor(pending,'ready','overflow-'+batch);
    await assert.rejects(outbox.record(input.evidence,input.receipt,keys.privateKey),{code:'FK_OUTBOX_CAPACITY'});
    assert.deepEqual(progress(store,pending),before);
    assert.equal(await delivery.at(-1),202);
    const {records,bytes}=outbox.usage();
    assert.equal(records,16);
    const peakPhysical=await physical();
    clock.now+=1001;
    const cleanup=await outbox.cleanup({namespace:'load',subjectId:'fixture-operator',reasonCode:'LAB_RETENTION'});
    assert.equal(cleanup.deleted,16);
    assert.equal(outbox.usage().records,0);
    samples.push({batch,logicalBytes:bytes,peakSamplePhysical:peakPhysical,afterCleanupPhysical:await physical()});
  }
  assert.equal(acceptedEvents.length,6);
  assert.ok(acceptedEvents.every(item=>item.namespace==='load'&&item.records===16&&item.maxRecords===16));
  console.log('P0A_OPS '+JSON.stringify({case:'bounded-load',accepted:96,capacityRejections:6,httpAccepted:6,
    elapsedMs:Math.round(performance.now()-started),samples}));
});

async function verifyGenesisCut(t,side) {
  const f=await fixture(t);
  const file=path.join(f.root,'crash.sqlite');
  const moduleUrl=new URL('../../src/interactive/index.mjs',import.meta.url).href;
  const fixtureUrl=new URL('../security/p0a-ops-fixture.mjs',import.meta.url).href;
  const worker=`import {writeSync} from 'node:fs';
import {createInteractiveCoordinator,createSqliteCheckpointStore} from ${JSON.stringify(moduleUrl)};
import {opsRuntime,opsStart} from ${JSON.stringify(fixtureUrl)};
const [file,bytes,identity,side]=process.argv.slice(1);
const db=createSqliteCheckpointStore(file,{namespace:'genesis'});
const store={...db,createRun(args){
  if (side==='after') db.createRun(args);
  writeSync(1,JSON.stringify({side,runId:args.checkpoint.runId})+'\\n');
  process.kill(process.pid,'SIGKILL');
}};
await createInteractiveCoordinator({store,runtime:opsRuntime}).start(opsStart({programBytes:Buffer.from(bytes,'base64'),programIdentity:JSON.parse(identity)},'stable-start'));`;
  const child=spawn(process.execPath,['--input-type=module','-e',worker,file,f.program.programBytes.toString('base64'),
    JSON.stringify(f.program.programIdentity),side],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',chunk=>{stdout+=chunk;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const [exitCode,signal]=await once(child,'close');
  assert.ok(stdout.trim(),stderr);
  const cut=JSON.parse(stdout);
  assert.equal(cut.side,side);
  assert.ok(cut.runId);
  assert.ok(signal==='SIGKILL'||(process.platform==='win32'&&exitCode!==0));
  const {createInteractiveCoordinator}=await import('../../src/interactive/index.mjs');
  const store=createSqliteCheckpointStore(file,{namespace:'genesis'});
  f.resources.push(store);
  const checkpoint=store.load(cut.runId);
  const journal=store.listJournal(cut.runId);
  // R5 SQLite pins the artifact through the Run's foreign key.
  const readback=new DatabaseSync(file,{readOnly:true});
  let retains;
  try {
    retains=readback.prepare('SELECT artifact_hash FROM fk_i_runs WHERE namespace=? AND run_id=?')
      .all('genesis',cut.runId).map(row=>row.artifact_hash);
  } finally {readback.close();}
  if (side==='before') {
    assert.ok(!checkpoint);
    assert.deepEqual(journal,[]);
    assert.deepEqual(retains,[]);
  } else {
    assert.equal(checkpoint.revision,0);
    assert.equal(journal.length,1);
    assert.equal(journal[0].revision,0);
    assert.deepEqual(retains,[f.program.programIdentity.artifactHash]);
  }
  const api=createInteractiveCoordinator({store,runtime:opsRuntime});
  const first=await api.start(opsStart(f.program,'stable-start'));
  const second=await api.start(opsStart(f.program,'stable-start'));
  assert.equal(first.status,'waiting');
  assert.equal(second.runId,first.runId);
  assert.equal(second.pending.requestId,first.pending.requestId);
  assert.equal(second.revision,first.revision);
  assert.equal(store.load(first.runId).receiptCount,0);
  if (side==='after') assert.equal(first.runId,cut.runId);
  else assert.ok(!store.load(cut.runId));
  console.log('P0A_OPS '+JSON.stringify({case:'genesis-'+side+'-commit',exitCode,signal,runId:first.runId,
    revision:first.revision,journalRows:store.listJournal(first.runId).length}));
}

test('real process termination before Genesis leaves no Run or Journal',t=>verifyGenesisCut(t,'before'));
test('real process termination immediately after durable Genesis allows idempotent reopening',t=>verifyGenesisCut(t,'after'));
