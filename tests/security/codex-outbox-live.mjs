import {encodeCheckpoint} from '../../src/interactive/checkpoint.mjs';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createPublicKey,verify} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createSqliteCheckpointStore} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';

const [exe,cwd,root,profile='isolated',suite='original']=process.argv.slice(2);
assert.ok([exe,cwd,root].every(path.isAbsolute));
assert.ok(['original','followup','signing','revocation','release-r5','ops-r5'].includes(suite));
mkdirSync(root,{mode:0o700});
const probe=fileURLToPath(new URL('./codex-flowkit-probe.mjs',import.meta.url));
const log=(event,data)=>appendFileSync(path.join(root,'supervisor.ndjson'),
  JSON.stringify({event,at:Date.now(),supervisorPid:process.pid,...data})+'\n');
const children=new Set();

function launch(mode,dir,label,{answer='',cut='',bytes}={}) {
  const out=path.join(dir,label);
  const child=fork(probe,[exe,cwd,out,mode,profile,dir,answer,cut,...(bytes?[String(bytes)]:[])],
    {stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  children.add(child);
  let stdout='',stderr='';
  child.stdout.on('data',data=>{stdout+=data;appendFileSync(out+'.stdout.log',data);});
  child.stderr.on('data',data=>{stderr+=data;appendFileSync(out+'.stderr.log',data);});
  child.on('message',data=>log('worker-message',{label,...data}));
  const closed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>{
      children.delete(child);
      const exit={pid:child.pid,code,signal};
      log('worker-exit',{label,...exit});
      resolve({...exit,stdout,stderr});
    });
  });
  log('worker-start',{label,pid:child.pid,mode,args:child.spawnargs});
  return {child,closed};
}

async function waitFor(worker,event) {
  const {child,closed}=worker;
  let listener,timer;
  try {
    return await Promise.race([
      new Promise(resolve=>{
        listener=message=>{if (message.event===event) resolve(message);};
        child.on('message',listener);
      }),
      closed.then(result=>{throw new Error('Worker exited before '+event+': '+result.stderr+' '+result.stdout);}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out waiting for '+event)),70000);}),
    ]);
  } finally {clearTimeout(timer);child.off('message',listener);}
}

async function offline(mode,dir,label,options) {
  const result=await launch(mode,dir,label,options).closed;
  assert.equal(result.code,0,result.stderr);
  return JSON.parse(result.stdout);
}

function inspect(dir,setup,proofs) {
  const db=new DatabaseSync(path.join(dir,'outbox.sqlite'),{readOnly:true});
  let store;
  try {
    store=createSqliteCheckpointStore(path.join(dir,'run.sqlite'),{namespace:'codex-proof'});
    const cp=store.load(setup.runId);
    const indexed=store.getReceipt(setup.runId,setup.requestId);
    const journal=store.listJournal(setup.runId);
    const get=db.prepare('SELECT * FROM delivery WHERE proof_id=?');
    const rows=proofs.map(proof=>{
      const row=get.get(proof.proofId);
      assert.ok(row);
      const receipt=JSON.parse(Buffer.from(row.receipt).toString('utf8'));
      assert.equal(row.receipt_hash,sha256Bytes(row.receipt));
      assert.equal(row.receipt_hash,proof.receiptHash);
      assert.equal(receipt.runId,setup.runId);
      assert.equal(receipt.requestId,setup.requestId);
      let statement;
      if (proof.statementHash) {
        statement=JSON.parse(Buffer.from(row.statement).toString('utf8'));
        const keyFile=statement.keyId==='next'?'next.public.pem':'proof.public.pem';
        const publicKey=createPublicKey(readFileSync(path.join(dir,keyFile)));
        assert.equal(sha256Bytes(row.statement),proof.statementHash);
        assert.equal(sha256Bytes(row.signature),proof.signatureHash);
        assert.ok(verify(null,row.statement,publicKey,row.signature));
      } else {
        assert.equal(row.statement,null);
        assert.equal(row.signature,null);
      }
      return {proofId:proof.proofId,state:row.state,receiptHash:row.receipt_hash,...receipt.result,
        observationHash:sha256Bytes(row.observation),acceptedRevision:row.accepted_revision,
        keyId:statement?.keyId,expiresAt:statement?.expiresAt,
        statementHash:proof.statementHash,signatureHash:proof.signatureHash};
    });
    return {status:cp.status,revision:cp.revision,policyHash:cp.policyHash,answer:cp.state.answer,artifact:cp.state.artifact,
      checkpointHash:journal.at(-1).checkpointHash,checkpointDigest:sha256Bytes(canonicalBytes(encodeCheckpoint(cp))),
      journalDigest:sha256Bytes(canonicalBytes(journal)),indexed,journalRows:journal.length,rows};
  } finally {store?.close();db.close();}
}

function pendingState(state,setup) {
  assert.equal(state.status,'waiting');
  assert.equal(state.revision,setup.revision);
  assert.equal(state.indexed,null);
  assert.ok(state.rows.every(row=>row.state==='SIGNED'));
}

function finishedState(state,winner) {
  assert.equal(state.status,'succeeded');
  assert.equal(state.indexed.digest,winner.receiptHash);
  assert.equal(state.indexed.acceptedRevision,winner.acceptedRevision);
  assert.equal(state.answer,winner.answer);
  assert.deepEqual(state.artifact,winner.artifact);
  assert.equal(state.journalRows,state.revision+1);
}

function assertSameStore(before,after) {
  const {rows:beforeRows,...storeBefore}=before;
  const {rows:afterRows,...storeAfter}=after;
  assert.deepEqual(storeAfter,storeBefore);
}

function readR5(dir,runId) {
  const db=new DatabaseSync(path.join(dir,'run.sqlite'),{readOnly:true});
  try {
    const row=db.prepare('SELECT checkpoint_json,checkpoint_hash FROM fk_i_runs WHERE namespace=? AND run_id=?')
      .get('codex-proof',runId);
    const cp=JSON.parse(row.checkpoint_json);
    assert.equal(sha256Bytes(Buffer.from(row.checkpoint_json)),row.checkpoint_hash);
    assert.equal(cp.protocolVersion,1);
    assert.equal(cp.schemaVersion,1);
    assert.equal(Object.hasOwn(cp,'artifactHash'),false);
    assert.equal(cp.program.artifactHash,cp.programRef.artifactHash);
    return cp;
  } finally {db.close();}
}

async function r5ValidationRecovery() {
  const dir=path.join(root,'r5-validate');
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup');
  const waiting=readR5(dir,setup.runId);
  assert.equal(waiting.execution.phase,'awaiting');
  assert.equal(waiting.pending[0].requestId,setup.requestId);
  const victim=launch('outbox-worker',dir,'victim',{answer:'ready',cut:'release-after-receipt'});
  const proof=await waitFor(victim,'signed');
  victim.child.send('deliver');
  const observer=path.join(dir,'victim','observer.ndjson');
  const deadline=Date.now()+30000;
  while (!existsSync(observer) || !readFileSync(observer,'utf8').includes('"event":"release-validation-barrier"')) {
    if (Date.now()>=deadline || victim.child.exitCode!==null) throw new Error('R5 validation barrier not reached');
    await delay(50);
  }
  const saved=readR5(dir,setup.runId);
  assert.equal(saved.execution.phase,'validate');
  assert.equal(saved.revision,setup.revision+1);
  assert.equal(saved.receivedSubmission.requestId,setup.requestId);
  assert.equal(saved.receivedSubmission.canonicalDigest,proof.receiptHash);
  assert.deepEqual(saved.pending,[]);
  assert.deepEqual(saved.candidate.result,{answer:'ready'});
  const before=inspect(dir,setup,[proof]);
  assert.equal(before.indexed.acceptedRevision,saved.revision);
  assert.equal(before.rows[0].state,'SIGNED');
  log('r5-validation-before-kill',{setup,proof,checkpoint:saved,before});
  assert.ok(victim.child.kill('SIGKILL'));
  assert.equal((await victim.closed).signal,'SIGKILL');
  assert.deepEqual(readR5(dir,setup.runId),saved);
  const restored=await offline('outbox-recover',dir,'restart');
  assert.equal(restored.before.revision,saved.revision);
  const after=inspect(dir,setup,[proof]);
  finishedState(after,after.rows[0]);
  assert.deepEqual(after.indexed,before.indexed);
  assert.equal(readR5(dir,setup.runId).execution.phase,'finished');
  log('r5-validation-recovered',{after,restored});
}

async function crossStoreRevocation({coordinated=false}={}) {
  const first=path.join(root,'revoke-a'),second=path.join(root,'revoke-b');
  mkdirSync(first,{mode:0o700});
  mkdirSync(second,{mode:0o700});
  const a=await offline('outbox-setup',first,'setup');
  for (const key of ['proof.public.pem','proof.private.pem']) {
    copyFileSync(path.join(first,key),path.join(second,key));
  }
  const b=await offline('outbox-setup',second,'setup',{cut:'release-shared'});
  const accepted=await acceptLive(first,a,'accepted','','alpha');
  const bWorker=launch('outbox-worker',second,'pending',{answer:'beta'});
  const inFlight=await waitFor(bWorker,'signed');
  const beforeB=inspect(second,b,[inFlight]);
  pendingState(beforeB,b);
  assert.ok(bWorker.child.kill('SIGKILL'));
  assert.equal((await bWorker.closed).signal,'SIGKILL');
  const revokeA=await offline('release-revoke',first,'revoke');
  const rejectedA=await offline('release-check',first,'check',{answer:accepted.proofId});
  assert.equal(rejectedA.ack.acceptedRevision,a.revision+1);
  const stillActive=await offline('release-check',second,'before-local-revocation',{cut:'active'});
  assert.equal(stillActive.active,true);
  if (coordinated) {
    const denied=await offline('release-revoke',second,'unauthorized-revocation',{cut:'denied'});
    assert.equal(denied.revoked,false);
    assert.equal(denied.code,'FK_I_HOST_DENIED');
    const active=await offline('release-check',second,'after-failed-revocation',{cut:'active'});
    assert.equal(active.active,true);
    log('coordinated-revocation-hold',{confirmed:['A'],missing:['B'],denied,active});
  }
  const revokeB=await offline('release-revoke',second,'revoke');
  assert.equal(revokeB.keyHash,revokeA.keyHash);
  const rejectedB=await offline('release-check',second,'check',{answer:inFlight.proofId});
  assert.equal(rejectedB.ack,null);
  assert.ok(Date.now()<inFlight.expiresAt);
  assert.deepEqual(inspect(second,b,[inFlight]),beforeB);
  log('cross-store-revocation-passed',{revokeA,rejectedA,stillActive,revokeB,rejectedB,beforeB});
  if (coordinated) log('coordinated-revocation-verified',{confirmed:['A','B'],keyHash:revokeA.keyHash});
}

async function capacityAndCleanup() {
  const dir=path.join(root,'capacity');
  mkdirSync(dir,{mode:0o700});
  const first=await offline('outbox-setup',dir,'setup',{cut:'release-cap'});
  const proof=await acceptLive(dir,first,'fill','release-cap','alpha');
  const second=await offline('outbox-next',dir,'next',{cut:'release-cap-next'});
  const before=inspect(dir,second,[]);
  for (const cut of ['release-cap-next','release-byte-next']) {
    const worker=launch('outbox-worker',dir,cut,{cut,answer:'beta'});
    const rejected=await waitFor(worker,'capacity-rejected');
    assert.equal(rejected.requestId,second.requestId);
    assert.equal(rejected.code,'FK_OUTBOX_CAPACITY');
    assert.equal(rejected.usage.records,1);
    assert.equal((await worker.closed).code,0);
    if (suite==='ops-r5') {
      const events=readFileSync(path.join(dir,cut,'observer.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
      const [alert,...other]=events.filter(event=>event.event==='outbox-capacity-alert');
      assert.ok(alert);
      assert.equal(other.length,0);
      assert.equal(alert.namespace,'codex-proof');
      assert.equal(alert.records,1);
      assert.equal(cut==='release-cap-next'?alert.maxRecords:alert.maxBytes,1);
      log('capacity-alert-verified',{cut,alert,disk:diskSample(dir)});
    }
    assert.deepEqual(inspect(dir,second,[]),before);
  }
  const held=await offline('release-clean',dir,'held',{cut:'held',answer:first.runId});
  assert.equal(held.afterUsage.records,1);
  const interrupted=await offline('release-clean',dir,'interrupted',{cut:'abort-audit'});
  assert.equal(interrupted.afterUsage.records,1);
  const recovered=await offline('release-clean',dir,'clean');
  assert.equal(recovered.afterUsage.records,0);
  assert.equal(recovered.receipt.acceptedRevision,first.revision+1);
  const ack=await offline('release-check',dir,'read-cleaned-ack',{cut:'active'});
  assert.equal(ack.ack.receiptHash,proof.receiptHash);
  const retry=await acceptLive(dir,second,'retry','release-cap-next','beta');
  const after=inspect(dir,second,[retry]);
  finishedState(after,after.rows[0]);
  log('outbox-capacity-cleanup-passed',{proof,held,interrupted,recovered,ack,after});
}

async function originalSuite() {
  const raceDir=path.join(root,'race');
  mkdirSync(raceDir,{mode:0o700});
  const race=await offline('outbox-setup',raceDir,'setup');
  const contenders=['alpha','beta'].map(answer=>launch('outbox-worker',raceDir,answer,{answer}));
  const proofs=await Promise.all(contenders.map(worker=>waitFor(worker,'signed')));
  for (const key of ['threadId','turnId','hostPid','modelPid','callId','proofId','receiptHash']) {
    assert.notEqual(proofs[0][key],proofs[1][key],key);
  }
  assert.ok(proofs.every(proof=>proof.requestId===race.requestId));
  const beforeRace=inspect(raceDir,race,proofs);
  pendingState(beforeRace,race);
  log('race-before-release',beforeRace);
  const deliveries=contenders.map(worker=>waitFor(worker,'delivered'));
  contenders.forEach(({child})=>child.send('deliver'));
  await Promise.all(deliveries);
  const afterRace=inspect(raceDir,race,proofs);
  const winners=afterRace.rows.filter(row=>row.state==='ACKED');
  assert.equal(winners.length,1);
  assert.equal(afterRace.rows.filter(row=>row.state==='CONFLICT').length,1);
  finishedState(afterRace,winners[0]);
  assert.equal(afterRace.indexed.acceptedRevision,race.revision+1);
  log('race-passed',afterRace);
  await Promise.all(contenders.map(worker=>worker.closed));

  const crashDir=path.join(root,'crash');
  mkdirSync(crashDir,{mode:0o700});
  const crash=await offline('outbox-setup',crashDir,'setup');
  const victim=launch('outbox-worker',crashDir,'victim',{answer:'ready'});
  const proof=await waitFor(victim,'signed');
  const beforeCrash=inspect(crashDir,crash,[proof]);
  pendingState(beforeCrash,crash);
  log('kill-before-cas',{victimPid:victim.child.pid,...beforeCrash});
  assert.ok(victim.child.kill('SIGKILL'));
  const killed=await victim.closed;
  assert.equal(killed.signal,'SIGKILL');
  const afterKill=inspect(crashDir,crash,[proof]);
  assert.deepEqual(afterKill,beforeCrash);
  log('signed-survived-kill',{killedPid:killed.pid,signal:killed.signal,...afterKill});
  const restarted=await offline('outbox-recover',crashDir,'restart');
  assert.equal(restarted.before.revision,crash.revision);
  assert.equal(restarted.before.receipt,null);
  assert.equal(restarted.recovered.length,1);
  assert.equal(restarted.recovered[0].proofId,proof.proofId);
  const afterCrash=inspect(crashDir,crash,[proof]);
  assert.equal(afterCrash.rows[0].state,'ACKED');
  finishedState(afterCrash,afterCrash.rows[0]);
  assert.equal(afterCrash.indexed.acceptedRevision,crash.revision+1);
  log('recovery-passed',afterCrash);
  return {race:afterRace,crash:afterCrash};
}

function inspectSnapshot(dir,artifact) {
  const inbox=path.join(dir,'inbox');
  assert.deepEqual(readdirSync(inbox),[]);
  const handoff=createFileHandoff({database:path.join(dir,'file-handoff.sqlite'),inbox,
    validateArtifact:()=>false});
  try {
    const {bytes,...snapshot}=handoff.readSnapshot(artifact.id);
    assert.equal(snapshot.byteLength,artifact.byteLength);
    assert.equal(snapshot.sha256,artifact.sha256);
    assert.deepEqual(bytes,canonicalBytes({answer:'A'.repeat(snapshot.byteLength-13)}));
    return snapshot;
  } finally {handoff.close();}
}

async function crashCase(label,{cut='',bytes}={}) {
  const dir=path.join(root,label);
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup',{bytes});
  const victim=launch('outbox-worker',dir,'victim',{answer:'ready',cut,bytes});
  const proof=await waitFor(victim,'signed');
  assert.equal(proof.hostPid,victim.child.pid);
  assert.equal(proof.requestId,setup.requestId);
  if (cut) {
    const committed=waitFor(victim,'committed');
    victim.child.send('deliver');
    assert.equal((await committed).proofId,proof.proofId);
  }
  const before=inspect(dir,setup,[proof]);
  const artifact=before.rows[0].artifact;
  assert.equal(before.rows[0].state,'SIGNED');
  assert.equal(before.rows[0].acceptedRevision,null);
  if (cut) {
    assert.equal(before.indexed.acceptedRevision,setup.revision+1);
    finishedState(before,{...before.rows[0],acceptedRevision:before.indexed.acceptedRevision});
  } else pendingState(before,setup);
  const snapshot=bytes?inspectSnapshot(dir,artifact):null;
  if (snapshot) assert.equal(snapshot.state,'claimed');
  log('followup-before-kill',{label,cut:cut||'before-cas',victimPid:victim.child.pid,before,snapshot});
  assert.ok(victim.child.kill('SIGKILL'));
  const killed=await victim.closed;
  assert.equal(killed.signal,'SIGKILL');
  assert.deepEqual(inspect(dir,setup,[proof]),before);
  if (snapshot) assert.deepEqual(inspectSnapshot(dir,artifact),snapshot);
  log('followup-kill-confirmed',{label,victimPid:killed.pid,signal:killed.signal,before,snapshot});
  const restarted=await offline('outbox-recover',dir,'restart',{bytes});
  assert.deepEqual(restarted.before.receipt,before.indexed);
  assert.equal(restarted.before.revision,before.revision);
  assert.equal(restarted.recovered.length,1);
  assert.equal(restarted.recovered[0].proofId,proof.proofId);
  const after=inspect(dir,setup,[proof]);
  const winner=after.rows[0];
  assert.equal(winner.state,'ACKED');
  finishedState(after,winner);
  assert.equal(after.indexed.acceptedRevision,setup.revision+1);
  if (cut) assertSameStore(before,after);
  const recoveredSnapshot=bytes?inspectSnapshot(dir,artifact):null;
  if (snapshot) assert.deepEqual(recoveredSnapshot,{...snapshot,state:'acked',acceptedRevision:winner.acceptedRevision});
  log('followup-passed',{label,after,snapshot:recoveredSnapshot});
  return {after,snapshot:recoveredSnapshot};
}

async function acceptLive(dir,setup,label,cut,answer,bytes) {
  const worker=launch('outbox-worker',dir,label,{cut,answer,bytes});
  const proof=await waitFor(worker,'signed');
  assert.equal(proof.requestId,setup.requestId);
  const delivery=waitFor(worker,'delivered');
  worker.child.send('deliver');
  assert.equal((await delivery).state,'ACKED');
  assert.equal((await worker.closed).code,0);
  return proof;
}

function diskSample(dir) {
  const files={};
  for (const database of ['run.sqlite','outbox.sqlite','file-handoff.sqlite']) {
    for (const suffix of ['','-wal','-shm']) {
      const name=database+suffix;
      const entry=statSync(path.join(dir,name),{throwIfNoEntry:false});
      if (entry) files[name]={length:entry.size,allocatedBytes:entry.blocks===undefined?null:entry.blocks*512};
    }
  }
  const entries=Object.values(files);
  return {files,totalLength:entries.reduce((sum,file)=>sum+file.length,0),
    totalAllocatedBytes:entries.some(file=>file.allocatedBytes===null)?null
      :entries.reduce((sum,file)=>sum+file.allocatedBytes,0)};
}

function cleanupState(dir,artifact) {
  const outbox=new DatabaseSync(path.join(dir,'outbox.sqlite'),{readOnly:true});
  const snapshot=new DatabaseSync(path.join(dir,'file-handoff.sqlite'),{readOnly:true});
  try {
    return {
      queue:outbox.prepare('SELECT proof_id,artifact,accepted_revision FROM snapshot_cleanup').all(),
      fileReceipts:outbox.prepare("SELECT COUNT(*) AS n FROM delivery WHERE json_extract(CAST(observation AS TEXT),'$.tool')='flowkit_submit_file'").get().n,
      audit:outbox.prepare('SELECT operation_id,deleted_count FROM cleanup_audit').all(),
      snapshot:snapshot.prepare('SELECT state,size,sha256,accepted_revision FROM file_handoff WHERE id=?').get(artifact.id)??null,
    };
  } finally {snapshot.close();outbox.close();}
}

async function snapshotCleanupCrash(cut,bytes) {
  const dir=path.join(root,'snapshot-'+cut);
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup',{cut:'ops-file',bytes});
  const empty=diskSample(dir);
  const proof=await acceptLive(dir,setup,'file','ops-file','ready',bytes);
  const artifact=proof.artifact;
  assert.equal(artifact.byteLength,bytes);
  assert.equal(inspectSnapshot(dir,artifact).state,'acked');
  const live=inspect(dir,setup,[proof]);
  assert.deepEqual(live.artifact,artifact);
  assert.equal(live.status,'waiting');
  const retained=await offline('ops-clean',dir,'retained',{bytes});
  assert.equal(retained.result.deleted,0);
  assert.equal(retained.result.snapshotsReclaimed,0);
  const peak=diskSample(dir);
  const clear=launch('outbox-worker',dir,'clear',{cut:'ops-clear',answer:'ready'});
  assert.equal((await clear.closed).code,0);
  const before=inspect(dir,setup,[proof]);
  assert.equal(before.status,'succeeded');
  assert.equal(before.artifact,null);
  const cleaner=launch('ops-clean',dir,'cleaner',{cut,bytes});
  const barrier=await waitFor(cleaner,'cleanup-cut');
  assert.equal(barrier.cut,cut);
  assert.equal(barrier.hostPid,cleaner.child.pid);
  const atKill=cleanupState(dir,artifact);
  assert.equal(atKill.queue.length,1);
  assert.equal(atKill.queue[0].proof_id,proof.proofId);
  assert.equal(atKill.fileReceipts,0);
  assert.equal(atKill.audit.length,1);
  assert.equal(atKill.snapshot?.state??null,cut==='after-queue'?'acked':null);
  const during=diskSample(dir);
  log('snapshot-cleanup-before-kill',{cut,artifact,barrier,atKill,during,before});
  assert.ok(cleaner.child.kill('SIGKILL'));
  const killed=await cleaner.closed;
  assert.equal(killed.signal,'SIGKILL');
  assert.deepEqual(cleanupState(dir,artifact),atKill);
  log('snapshot-cleanup-kill-confirmed',{cut,pid:killed.pid,signal:killed.signal});
  const restored=await offline('ops-clean',dir,'restart',{bytes});
  assert.equal(restored.result.deleted,0);
  assert.equal(restored.result.snapshotsReclaimed,1);
  assert.equal(restored.ack.acceptedRevision,setup.revision+1);
  assert.equal(restored.ack.receiptHash,proof.receiptHash);
  assert.deepEqual(cleanupState(dir,artifact),{...atKill,queue:[],snapshot:null});
  const again=await offline('ops-clean',dir,'repeat',{bytes});
  assert.equal(again.result.snapshotsReclaimed,0);
  assertSameStore(before,inspect(dir,setup,[]));
  const after=diskSample(dir);
  log('snapshot-cleanup-recovered',{cut,artifact,restored,again,disk:{empty,peak,during,after}});
}

async function beforeSignCase() {
  const dir=path.join(root,'before-sign');
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup');
  const victim=launch('outbox-worker',dir,'victim',{answer:'ready',cut:'before-sign'});
  const observed=await waitFor(victim,'observed');
  assert.equal(observed.hostPid,victim.child.pid);
  const before=inspect(dir,setup,[observed]);
  assert.equal(before.status,'waiting');
  assert.equal(before.revision,setup.revision);
  assert.equal(before.indexed,null);
  assert.equal(before.rows[0].state,'OBSERVED');
  log('before-sign-cut',{observed,before});
  assert.ok(victim.child.kill('SIGKILL'));
  assert.equal((await victim.closed).signal,'SIGKILL');
  assert.deepEqual(inspect(dir,setup,[observed]),before);
  const restart=await offline('outbox-recover',dir,'restart');
  assert.deepEqual(restart.recovered,[]);
  assert.deepEqual(inspect(dir,setup,[observed]),before);
  const retry=await acceptLive(dir,setup,'retry','','ready');
  for (const field of ['proofId','threadId','turnId','callId']) assert.notEqual(retry[field],observed[field],field);
  const after=inspect(dir,setup,[observed,retry]);
  assert.deepEqual(after.rows[0],before.rows[0]);
  finishedState(after,after.rows[1]);
  assert.equal(after.indexed.acceptedRevision,setup.revision+1);
  log('before-sign-passed',{observed,before,restart,retry,after});
  return {before,after};
}

async function waitPastHostSkew(proof) {
  // Wait past both the Outbox deadline and the verifier's default 5-second grace.
  const minimum=proof.expiresAt+5100;
  await delay(Math.max(0,minimum-Date.now()));
  assert.ok(Date.now()>=minimum);
}

async function expiredCase() {
  const dir=path.join(root,'expired');
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup');
  const worker=launch('outbox-worker',dir,'victim',{answer:'ready',cut:'expire'});
  const proof=await waitFor(worker,'signed');
  const before=inspect(dir,setup,[proof]);
  pendingState(before,setup);
  assert.ok(worker.child.kill('SIGKILL'));
  assert.equal((await worker.closed).signal,'SIGKILL');
  await waitPastHostSkew(proof);
  const restart=await offline('outbox-recover',dir,'restart');
  assert.equal(restart.recovered.length,1);
  const after=inspect(dir,setup,[proof]);
  assertSameStore(before,after);
  assert.deepEqual(after.rows,[{...before.rows[0],state:'BLOCKED'}]);
  log('expired-passed',{proof,before,restart,after});
  return {before,after};
}

async function rotationCase() {
  const dir=path.join(root,'rotation');
  mkdirSync(dir,{mode:0o700});
  const setup=await offline('outbox-setup',dir,'setup',{cut:'rotate-old'});
  const oldProof=await acceptLive(dir,setup,'old','rotate-old','alpha');
  const old=inspect(dir,setup,[oldProof]);
  finishedState(old,old.rows[0]);
  assert.equal(old.rows[0].keyId,'proof');
  const next=await offline('outbox-next',dir,'next-setup',{cut:'rotate-new'});
  assert.notEqual(setup.runId,next.runId);
  const nextProof=await acceptLive(dir,next,'new','rotate-new','beta');
  const newer=inspect(dir,next,[nextProof]);
  finishedState(newer,newer.rows[0]);
  assert.equal(newer.rows[0].keyId,'next');
  assert.equal(newer.policyHash,old.policyHash);
  await waitPastHostSkew(oldProof);
  const replay=await offline('outbox-replay',dir,'old-replay',{cut:'rotate-old',answer:oldProof.proofId});
  assert.equal(replay.runId,setup.runId);
  assert.equal(replay.acceptedRevision,old.indexed.acceptedRevision);
  assert.deepEqual(replay.receipt,old.indexed);
  assert.deepEqual(inspect(dir,setup,[oldProof]),old);
  assert.deepEqual(inspect(dir,next,[nextProof]),newer);
  log('rotation-passed',{oldProof,nextProof,old,newer,replay});
  return {old,newer,replay};
}

async function revocationCase() {
  const dir=path.join(root,'revocation');
  mkdirSync(dir,{mode:0o700});
  const oldRun=await offline('outbox-setup',dir,'setup',{cut:'rotate-old'});
  const oldProof=await acceptLive(dir,oldRun,'old','rotate-old','alpha');
  const accepted=inspect(dir,oldRun,[oldProof]);
  finishedState(accepted,accepted.rows[0]);
  assert.equal(accepted.rows[0].keyId,'proof');
  const pendingRun=await offline('outbox-next',dir,'pending-setup',{cut:'rotate-old-next'});
  const pendingHost=launch('outbox-worker',dir,'pending',{cut:'rotate-old-next',answer:'beta'});
  const pendingProof=await waitFor(pendingHost,'signed');
  assert.equal(pendingProof.requestId,pendingRun.requestId);
  const pending=inspect(dir,pendingRun,[pendingProof]);
  pendingState(pending,pendingRun);
  assert.ok(pendingHost.child.kill('SIGKILL'));
  assert.equal((await pendingHost.closed).signal,'SIGKILL');

  const historical=await offline('outbox-check-revocation',dir,'revoked-old',
    {cut:'revoked-old',answer:oldProof.proofId});
  const inFlight=await offline('outbox-check-revocation',dir,'revoked-pending',
    {cut:'revoked-pending',answer:pendingProof.proofId});
  assert.ok(Date.now()<pendingProof.expiresAt);
  assert.deepEqual(historical.receipt,accepted.indexed);
  assert.equal(inFlight.receipt,null);
  assert.equal(historical.outbox.state,'ACKED');
  assert.equal(inFlight.outbox.state,'SIGNED');

  const newRun=await offline('outbox-next',dir,'new-setup',{cut:'revoked-new'});
  const newProof=await acceptLive(dir,newRun,'new','revoked-new','ready');
  const newer=inspect(dir,newRun,[newProof]);
  finishedState(newer,newer.rows[0]);
  assert.equal(newer.rows[0].keyId,'next');
  assert.notEqual(newer.policyHash,accepted.policyHash);
  assert.equal(newer.policyHash,historical.configuredPolicyHash);
  assert.equal(newer.policyHash,inFlight.configuredPolicyHash);
  // Both persistent Outbox rows and the original ledger survive the failed policy change.
  assert.deepEqual(inspect(dir,oldRun,[oldProof]),accepted);
  assert.deepEqual(inspect(dir,pendingRun,[pendingProof]),pending);
  log('revocation-baseline-passed',{oldRun,pendingRun,newRun,historical,inFlight,accepted,pending,newer});
  return {historical,inFlight,newer};
}

try {
  let result;
  if (suite==='ops-r5') {
    await snapshotCleanupCrash('after-queue',262144);
    await snapshotCleanupCrash('after-unlink',2093056);
    await crossStoreRevocation({coordinated:true});
    await capacityAndCleanup();
    result={snapshotCleanupCuts:2,coordinatedRevocation:true,capacityAlerts:true};
  } else if (suite==='release-r5') {
    await r5ValidationRecovery();
    await crossStoreRevocation();
    await capacityAndCleanup();
    result={r5ValidationRecovery:true,crossStoreRevocation:true,capacityAndCleanup:true};
  } else result=suite==='followup'?{
    afterCas:await crashCase('after-cas',{cut:'after-cas'}),
    file256:await crashCase('file-262144',{bytes:262144}),
    fileNearLimit:await crashCase('file-2093056',{bytes:2093056}),
  }:suite==='signing'?{
    beforeSign:await beforeSignCase(),expired:await expiredCase(),rotation:await rotationCase(),
  }:suite==='revocation'?{
    revocation:await revocationCase(),beforeSign:await beforeSignCase(),expired:await expiredCase(),
  }:await originalSuite();
  console.log(JSON.stringify({passed:true,profile,suite,...result}));
} finally {
  for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
}
