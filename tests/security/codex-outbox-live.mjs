import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {appendFileSync,mkdirSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createPublicKey,verify} from 'node:crypto';
import {createSqliteCheckpointStore} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';

const [exe,cwd,root,profile='isolated',suite='original']=process.argv.slice(2);
assert.ok([exe,cwd,root].every(path.isAbsolute));
assert.ok(['original','followup'].includes(suite));
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
    const publicKey=createPublicKey(readFileSync(path.join(dir,'proof.public.pem')));
    const get=db.prepare('SELECT * FROM delivery WHERE proof_id=?');
    const rows=proofs.map(proof=>{
      const row=get.get(proof.proofId);
      assert.ok(row);
      const receipt=JSON.parse(Buffer.from(row.receipt).toString('utf8'));
      assert.equal(row.receipt_hash,sha256Bytes(row.receipt));
      assert.equal(row.receipt_hash,proof.receiptHash);
      assert.equal(sha256Bytes(row.statement),proof.statementHash);
      assert.equal(sha256Bytes(row.signature),proof.signatureHash);
      assert.ok(verify(null,row.statement,publicKey,row.signature));
      assert.equal(receipt.runId,setup.runId);
      assert.equal(receipt.requestId,setup.requestId);
      return {proofId:proof.proofId,state:row.state,receiptHash:row.receipt_hash,...receipt.result,
        acceptedRevision:row.accepted_revision,statementHash:proof.statementHash,signatureHash:proof.signatureHash};
    });
    return {status:cp.status,revision:cp.revision,answer:cp.state.answer,artifact:cp.state.artifact,
      checkpointHash:journal.at(-1).checkpointHash,checkpointDigest:sha256Bytes(canonicalBytes(cp)),
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
  if (cut) {
    const {rows,...storeBefore}=before;
    const {rows:finalRows,...storeAfter}=after;
    assert.deepEqual(storeAfter,storeBefore);
  }
  const recoveredSnapshot=bytes?inspectSnapshot(dir,artifact):null;
  if (snapshot) assert.deepEqual(recoveredSnapshot,{...snapshot,state:'acked',acceptedRevision:winner.acceptedRevision});
  log('followup-passed',{label,after,snapshot:recoveredSnapshot});
  return {after,snapshot:recoveredSnapshot};
}

try {
  const result=suite==='followup'?{
    afterCas:await crashCase('after-cas',{cut:'after-cas'}),
    file256:await crashCase('file-262144',{bytes:262144}),
    fileNearLimit:await crashCase('file-2093056',{bytes:2093056}),
  }:await originalSuite();
  console.log(JSON.stringify({passed:true,profile,suite,...result}));
} finally {
  for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
}
