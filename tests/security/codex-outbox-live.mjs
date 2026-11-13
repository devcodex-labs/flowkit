import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {appendFileSync,mkdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createPublicKey,verify} from 'node:crypto';
import {createSqliteCheckpointStore} from '../../src/interactive/index.mjs';
import {sha256Bytes} from '../../src/interactive/canonical.mjs';

const [exe,cwd,root,profile='isolated']=process.argv.slice(2);
assert.ok([exe,cwd,root].every(path.isAbsolute));
mkdirSync(root,{mode:0o700});
const probe=fileURLToPath(new URL('./codex-flowkit-probe.mjs',import.meta.url));
const log=(event,data)=>appendFileSync(path.join(root,'supervisor.ndjson'),
  JSON.stringify({event,at:Date.now(),supervisorPid:process.pid,...data})+'\n');
const children=new Set();

function launch(mode,dir,label,answer) {
  const out=path.join(dir,label);
  const child=fork(probe,[exe,cwd,out,mode,profile,dir,...(answer?[answer]:[])],
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

async function offline(mode,dir,label) {
  const result=await launch(mode,dir,label).closed;
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
      return {proofId:proof.proofId,state:row.state,receiptHash:row.receipt_hash,answer:receipt.result.answer,
        acceptedRevision:row.accepted_revision,statementHash:proof.statementHash,signatureHash:proof.signatureHash};
    });
    return {status:cp.status,revision:cp.revision,answer:cp.state.answer,checkpointHash:journal.at(-1).checkpointHash,
      indexed,journalRows:journal.length,rows};
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
  assert.equal(state.journalRows,state.revision+1);
}

try {
  const raceDir=path.join(root,'race');
  mkdirSync(raceDir,{mode:0o700});
  const race=await offline('outbox-setup',raceDir,'setup');
  const contenders=['alpha','beta'].map(answer=>launch('outbox-worker',raceDir,answer,answer));
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
  const victim=launch('outbox-worker',crashDir,'victim','ready');
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
  console.log(JSON.stringify({passed:true,profile,race:afterRace,crash:afterCrash}));
} finally {
  for (const child of children) if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
}
