import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes, safeJSONSnapshot, sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';

const hash = bytes => sha256Bytes(Buffer.from(bytes));
const artifactBytes = Buffer.from('// verified compiler bytes fixture\nexport const v = 1;\n');
const identity = {
  artifactHash:hash(artifactBytes), sourceHash:'sha256:' + 'a'.repeat(64),
  programAbiVersion:1, semanticsVersion:'interactive-state-machine-v1',
  implementedStage:'P0-A',
};
const checkpoint = (namespace, runId, state = {}) => ({
  schemaVersion:1, namespace, runId, revision:0, status:'running',
  artifactHash:identity.artifactHash, blockId:'gate::enter', phase:'enter',
  state, controlStack:[], candidate:null,
});
const next = (cp, status = 'running') => ({
  ...cp, revision:cp.revision + 1,
  status, phase:'route', blockId:'gate::route',
});

// Module teardown runs after every test-specific DatabaseSync.close() hook.
// Windows cannot unlink SQLite files while any connection still owns them.
const temporaryDirectories = [];
after(async () => {
  for (const dir of temporaryDirectories) await rm(dir, {recursive:true, force:true});
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-m3-'));
  temporaryDirectories.push(dir);
  return path.join(dir, 'checkpoint.db');
}

test('M3 canonical JSON uses stable key order and preserves prototype keys only as data', () => {
  const a = canonicalBytes(JSON.parse('{"z":1,"ä":2,"a":{"y":1,"x":2},"__proto__":{"safe":true}}'));
  const b = canonicalBytes(JSON.parse('{"__proto__":{"safe":true},"a":{"x":2,"y":1},"z":1,"ä":2}'));
  assert.equal(a.toString('hex'), b.toString('hex'));
  const copied = safeJSONSnapshot(JSON.parse('{"__proto__":{"safe":true}}'));
  assert.ok(Object.hasOwn(copied, '__proto__'));
  assert.equal({}.safe, undefined);
  assert.equal(copied.__proto__.safe, true);
});

test('M3 rejects invalid JSON before any SQLite mutation: accessor, proxy, cycle, -0, nonfinite and limits', async t => {
  const file = await fixture(t);
  const store = createSqliteCheckpointStore(file, {namespace:'tenant-a'});
  t.after(() => store.close());
  store.putArtifact({bytes:artifactBytes, programIdentity:identity});
  const start = store.createRun({startKey:'key', checkpoint:checkpoint('tenant-a','r')});
  const before = canonicalBytes(start.checkpoint).toString('hex');
  const invalid = [
    {bad:undefined},
    {bad:NaN},
    {bad:Infinity},
    {bad:-0},
    {bad:BigInt(1)},
    {bad:'\ud800'},
    {bad: new Date()},
    {bad:new Proxy({ok:true},{})},
    {bad:'x'.repeat(2*1024*1024+1)},
  ];
  const cycle = {}; cycle.self = cycle; invalid.push(cycle);
  const accessor = {};
  Object.defineProperty(accessor,'bad',{get(){throw Error('getter ran');},enumerable:true});
  invalid.push(accessor);
  for (const value of invalid) {
    assert.throws(() => store.compareAndSwap({
      runId:'r', expectedRevision:0, nextCheckpoint:{...next(start.checkpoint), state:value},
      transitionId:'tx-invalid',
    }), error => error instanceof Error);
    assert.equal(canonicalBytes(store.load('r')).toString('hex'), before);
    assert.equal(store.listJournal('r').length,1);
  }
});

test('M3 registers immutable exact artifact bytes, isolates tenants, and prevents deletion of referenced programs', async t => {
  const file = await fixture(t);
  const a = createSqliteCheckpointStore(file,{namespace:'tenant-a'});
  const b = createSqliteCheckpointStore(file,{namespace:'tenant-b'});
  t.after(()=>{a.close();b.close()});
  assert.throws(() => a.putArtifact({bytes:Buffer.from('different'),programIdentity:identity}),/PROGRAM_MISMATCH/);
  a.putArtifact({bytes:artifactBytes,programIdentity:identity});
  b.putArtifact({bytes:artifactBytes,programIdentity:identity});
  const copy = a.getArtifact(identity.artifactHash);
  copy.bytes.fill(0);
  assert.deepEqual(a.getArtifact(identity.artifactHash).bytes,artifactBytes);
  assert.equal(a.getArtifact('sha256:' + 'b'.repeat(64)), null);
  a.createRun({startKey:'same-key',checkpoint:checkpoint('tenant-a','same-id',{from:'a'})});
  b.createRun({startKey:'same-key',checkpoint:checkpoint('tenant-b','same-id',{from:'b'})});
  assert.equal(a.load('same-id').state.from,'a');
  assert.equal(b.load('same-id').state.from,'b');
  assert.throws(() => b.createRun({startKey:'wrong',checkpoint:checkpoint('tenant-a','foreign')}),/INVALID_CHECKPOINT/);
  assert.throws(() => b.compareAndSwap({
    runId:'only-a',expectedRevision:0,nextCheckpoint:checkpoint('tenant-a','only-a'),
    transitionId:'t',
  }),/RUN_NOT_FOUND/);
  assert.throws(()=>a.deleteArtifact(identity.artifactHash),/ARTIFACT_IN_USE/);
  assert.throws(()=>b.deleteArtifact(identity.artifactHash),/ARTIFACT_IN_USE/);
});

test('M3 idempotent start fingerprints tenant + artifact + initial state + options, rejecting conflicts without writes', async t => {
  const file=await fixture(t);
  const store=createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>store.close());
  store.putArtifact({programIdentity:identity,bytes:artifactBytes});
  const one=store.createRun({startKey:'daily',startIntent:{policy:'v1'},checkpoint:checkpoint('n','r-1',{a:1,b:2})});
  assert.equal(one.created,true);
  const retry=store.createRun({startKey:'daily',startIntent:{policy:'v1'},
    checkpoint:checkpoint('n','new-id',{b:2,a:1})});
  assert.equal(retry.created,false);
  assert.equal(retry.checkpoint.runId,'r-1');
  assert.equal(retry.checkpoint.startIntentHash,one.checkpoint.startIntentHash);
  for (const changed of [
    {startKey:'daily',startIntent:{policy:'v2'},checkpoint:checkpoint('n','r-3',{a:1,b:2})},
    {startKey:'daily',startIntent:{policy:'v1'},checkpoint:checkpoint('n','r-4',{a:3,b:2})},
  ]) {
    assert.throws(()=>store.createRun(changed),/START_CONFLICT/);
  }
  assert.throws(()=>store.createRun({startKey:'different',checkpoint:checkpoint('n','r-1')}),/RUN_CONFLICT/);
  assert.deepEqual(store.load('r-1'),one.checkpoint);
  assert.equal(store.listJournal('r-1').length,1);
});

test('M3 CAS atomically advances revision and hash-chained Journal; stale/duplicate writes are no-ops', async t => {
  const file = await fixture(t);
  const store = createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>store.close());
  store.putArtifact({programIdentity:identity,bytes:artifactBytes});
  const initial=store.createRun({startKey:'start',checkpoint:checkpoint('n','r')}).checkpoint;
  const first=store.compareAndSwap({
    runId:'r',expectedRevision:0,nextCheckpoint:next(initial),transitionId:'t1',
    journalEntry:{kind:'move',blockId:'gate::route'},
  });
  assert.equal(first.committed,true);
  const stale=store.compareAndSwap({
    runId:'r',expectedRevision:0,nextCheckpoint:next(initial),transitionId:'another',
    journalEntry:{kind:'move'},
  });
  assert.equal(stale.committed,false);
  assert.deepEqual(stale.checkpoint, first.checkpoint);
  const terminal=store.compareAndSwap({
    runId:'r',expectedRevision:1,nextCheckpoint:next(first.checkpoint,'succeeded'),transitionId:'t2',
    journalEntry:{kind:'terminal',status:'succeeded'},
  });
  assert.equal(terminal.committed,true);
  assert.throws(()=>store.compareAndSwap({
    runId:'r',expectedRevision:2,nextCheckpoint:next(terminal.checkpoint),transitionId:'t3',
  }),/TERMINAL_IMMUTABLE/);
  assert.throws(()=>store.compareAndSwap({
    runId:'r',expectedRevision:2,nextCheckpoint:{...next(terminal.checkpoint),artifactHash:hash('different')},
    transitionId:'t4',
  }),/TERMINAL_IMMUTABLE|PROGRAM_MISMATCH/);
  const history=store.listJournal('r');
  assert.deepEqual(history.map(v=>v.revision),[0,1,2]);
  assert.equal(history[1].previousHash,history[0].entryHash);
  assert.equal(history[2].previousHash,history[1].entryHash);
  assert.equal(history[2].checkpointHash,sha256Bytes(canonicalBytes(terminal.checkpoint)));
  assert.equal(store.load('r').revision,2);
});

test('M3 a duplicate transition ID rolls back Checkpoint and Journal in the same transaction',async t=>{
  const file=await fixture(t);
  const store=createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>store.close());
  store.putArtifact({programIdentity:identity,bytes:artifactBytes});
  const initial=store.createRun({startKey:'k',checkpoint:checkpoint('n','r')}).checkpoint;
  store.compareAndSwap({runId:'r',expectedRevision:0,nextCheckpoint:next(initial),transitionId:'tx'});
  const before=store.load('r');
  assert.throws(()=>store.compareAndSwap({
    runId:'r',expectedRevision:1,nextCheckpoint:next(before),transitionId:'tx',
  }),/UNIQUE|constraint/i);
  assert.deepEqual(store.load('r'),before);
  assert.deepEqual(store.listJournal('r').map(x=>x.revision),[0,1]);
});

test('M3 a separate SQLite connection observes committed data after process/connection restart',async t=>{
  const file=await fixture(t);
  const first=createSqliteCheckpointStore(file,{namespace:'n'});
  first.putArtifact({programIdentity:identity,bytes:artifactBytes});
  const initial=first.createRun({startKey:'s',checkpoint:checkpoint('n','r')}).checkpoint;
  const updated=first.compareAndSwap({runId:'r',expectedRevision:0,nextCheckpoint:next(initial),transitionId:'t'});
  assert.equal(updated.committed,true);
  first.close();
  const second=createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>second.close());
  assert.deepEqual(second.load('r'),updated.checkpoint);
  assert.equal(second.listJournal('r').length,2);
});

test('M3 two real OS processes racing at the same revision cannot both commit',async t=>{
  const file=await fixture(t);
  const store=createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>store.close());
  store.putArtifact({programIdentity:identity,bytes:artifactBytes});
  const initial=store.createRun({startKey:'k',checkpoint:checkpoint('n','r')}).checkpoint;
  const moduleUrl=new URL('../../src/interactive/sqlite-store.mjs',import.meta.url).href;
  const script=[
    'import {createSqliteCheckpointStore} from ' + JSON.stringify(moduleUrl) + ';',
    'const [file, cpJson, transitionId] = process.argv.slice(1);',
    'const store = createSqliteCheckpointStore(file,{namespace:"n"});',
    'const cp=JSON.parse(cpJson);',
    'const next={...cp,revision:1,phase:"route",blockId:"gate::route"};',
    'const r=store.compareAndSwap({runId:"r",expectedRevision:0,nextCheckpoint:next,transitionId});',
    'console.log(r.committed ? "WIN" : "LOSE"); store.close();',
  ].join('\n');
  const run=(name)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,file,JSON.stringify(initial),name],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',data=>{stdout+=data});
    child.stderr.on('data',data=>{stderr+=data});
    child.on('error',reject);
    child.on('close',code=>code===0 ? resolve(stdout.trim()) : reject(Error(stderr)));
  });
  const results=await Promise.all([run('p1'),run('p2')]);
  assert.deepEqual(results.sort(),['LOSE','WIN']);
  assert.equal(store.load('r').revision,1);
  assert.equal(store.listJournal('r').length,2);
});

test('M3 a tampered checkpoint row is rejected, not replayed or silently repaired',async t=>{
  const file=await fixture(t);
  const store=createSqliteCheckpointStore(file,{namespace:'n'});
  store.putArtifact({programIdentity:identity,bytes:artifactBytes});
  store.createRun({startKey:'s',checkpoint:checkpoint('n','r')});
  store.close();
  const db=new DatabaseSync(file);
  db.prepare('UPDATE fk_i_runs SET checkpoint_json = ? WHERE namespace = ? AND run_id = ?')
    .run('{"malicious":true}','n','r');
  db.close();
  const reopened=createSqliteCheckpointStore(file,{namespace:'n'});
  t.after(()=>reopened.close());
  assert.throws(()=>reopened.load('r'),/STORE_CORRUPT/);
});
