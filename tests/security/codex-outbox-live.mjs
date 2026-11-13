import {encodeCheckpoint} from '../../src/interactive/checkpoint.mjs';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {appendFileSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
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
assert.ok(['original','followup','signing','revocation'].includes(suite));
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

async function acceptLive(dir,setup,label,cut,answer) {
  const worker=launch('outbox-worker',dir,label,{cut,answer});
  const proof=await waitFor(worker,'signed');
  assert.equal(proof.requestId,setup.requestId);
  const delivery=waitFor(worker,'delivered');
  worker.child.send('deliver');
  assert.equal((await delivery).state,'ACKED');
  assert.equal((await worker.closed).code,0);
  return proof;
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
  const result=suite==='followup'?{
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
