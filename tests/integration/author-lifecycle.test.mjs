import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, symlink, link, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createWorkflowAuthorHost } from '../../dist/host.mjs';
import { fixture, context, intent } from './author-host-fixture.mjs';

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-author-life-'));
  const file = path.join(dir, 'author.sqlite'), f = await fixture(file, overrides), releases = [], hosts = [f.host];
  t.after(async () => { for (const release of releases) release(); for (const host of hosts.reverse()) {
    const closed = await host.close({ mode: 'cancel', timeoutMs: 1000 }); assert.equal(closed.closed, true, JSON.stringify(closed));
  } await rm(dir, { recursive: true, force: true }); });
  return { ...f, dir, file, releases, hosts };
}
async function latest(f, draft) { return f.host.readDraft({ draftId: draft.id }, context); }
async function advance(f, draft, extra = {}) {
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: (await latest(f, draft)).stateVersion,
    turnId: 'turn', input: 'Inspect', ...extra }, context);
}
function database(file, operation) { const db = new DatabaseSync(file); try { return operation(db); } finally { db.close(); } }
const turnRecord = (file, id = 'turn') => database(file, db => JSON.parse(db.prepare('SELECT payload FROM fk_author_turns WHERE turn_id=?').get(id).payload));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for the owned test operation');
}

test('I4 S130: missing finite Host capacities, invalid zero values and unsupported timer ranges fail before opening a store', async t => {
  const f = await setup(t); const missing = { ...f.options, storageFile: path.join(f.dir, 'missing.sqlite') }; delete missing.capacity;
  await assert.rejects(createWorkflowAuthorHost(missing), /finite.*capacities/);
  for (const capacity of [{ ...f.options.capacity, maxPhysicalExecutions: 0 }, { ...f.options.capacity, maxReceiptBytes: 0 }]) {
    await assert.rejects(createWorkflowAuthorHost({ ...missing, capacity }), /positive/);
  }
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, budgetPolicy: { durationMs: Number.MAX_SAFE_INTEGER } }), /timer range/);
});

test('I4 S31/S67/S111: two SQLite connections admit one execution and same-turn in-flight reads never dispatch twice', async t => {
  const f = await setup(t); const second = await fixture(f.file); f.hosts.push(second.host);
  const draft = await f.start(); let release;
  const barrier = new Promise(resolve => { release = resolve; }); f.releases.push(release);
  const raw = f.options.execution.request;
  f.options.execution.request = async input => { if (input.stage === 'intent') await barrier; return raw(input); };
  const input = { draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect' };
  const running = f.host.advanceTurn(input, context);
  await until(async () => (await latest(f, draft)).status === 'running');
  const duplicate = await second.host.advanceTurn(input, context); assert.equal(duplicate.status, 'running'); assert.equal(second.calls.length, 0);
  await assert.rejects(second.host.advanceTurn({ ...input, turnId: 'different' }, context), /stateVersion/);
  release(); const ready = await running; assert.equal(ready.status, 'candidate-ready'); assert.equal(f.calls.length, 4);
  const replay = await second.host.advanceTurn(input, context); assert.deepEqual(replay, ready); assert.equal(second.calls.length, 0);
});

test('R-01 S28/S33/S104: committed turns stay immutable through review, approval and publication', async t => {
  const f = await setup(t);
  await f.register();
  const draft = await f.start();
  const input = { draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect' };
  const ready = await f.host.advanceTurn(input, context);
  assert.equal(ready.status, 'candidate-ready');
  const stored = turnRecord(f.file);
  const assertCommitted = async status => {
    const before = await latest(f, draft);
    assert.equal(before.status, status);
    for (const decision of ['confirm-no-effect', 'confirm-result', 'abandon']) {
      await assert.rejects(f.host.settleTurn({ draftId: draft.id, expectedStateVersion: before.stateVersion,
        turnId: input.turnId, decision, evidenceRef: 'controlled-observation' }, context), { code: 'FKA_SETTLEMENT_INVALID' });
    }
    assert.deepEqual(await latest(f, draft), before);
    assert.deepEqual(turnRecord(f.file), stored);
    assert.deepEqual(await f.host.advanceTurn(input, context), ready);
    assert.equal(f.calls.length, 4);
  };
  await assertCommitted('candidate-ready');
  const binding = { draftId: draft.id, expectedStateVersion: ready.stateVersion, candidateHash: ready.candidate.hash,
    previousHash: ready.previousHash, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'approved' };
  f.approvals.set(binding.approvalRef, binding.candidateHash);
  const approved = await f.host.recordApproval(binding, context);
  await assertCommitted('approved');
  await f.host.publish({ ...binding, expectedStateVersion: approved.stateVersion, publicationId: 'save' }, context);
  await assertCommitted('saved');
});

test('R-02 S35/S128: retries share the physical slot across connections and retain the reference while the slot is occupied', async t => {
  const overrides = { capacity: { maxPhysicalExecutions: 1 } };
  const f = await setup(t, overrides);
  const other = await fixture(f.file, overrides);
  f.hosts.push(other.host);
  const raw = f.options.execution.request;
  f.options.execution.request = async () => { throw new Error('controlled no-effect transport failure'); };
  const retryDraft = await f.start({ requestId: 'retry-draft' });
  const failed = await advance(f, retryDraft, { turnId: 'retry-turn' });
  assert.equal(failed.status, 'failed');
  const settled = await f.host.settleTurn({ draftId: retryDraft.id, expectedStateVersion: failed.stateVersion,
    turnId: 'retry-turn', decision: 'confirm-no-effect', evidenceRef: 'controlled-no-effect' }, context);
  assert.ok(settled.retryRef);
  f.options.execution.request = raw;

  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.releases.push(release);
  other.options.execution.request = async () => { entered(); await barrier; return structuredClone(intent); };
  const occupyingDraft = await other.start({ requestId: 'occupying-draft' });
  const occupying = advance(other, occupyingDraft, { turnId: 'occupying-turn' });
  await started;
  const retryInput = { draftId: retryDraft.id, expectedStateVersion: settled.stateVersion, turnId: 'retry-turn', input: 'Inspect',
    kind: 'retry', retryRef: settled.retryRef };
  const assertBlocked = async () => {
    await assert.rejects(f.host.advanceTurn(retryInput, context), { code: 'FKA_INFLIGHT' });
    assert.equal((await latest(f, retryDraft)).stateVersion, settled.stateVersion);
    assert.equal(turnRecord(f.file, 'retry-turn').retryRef, settled.retryRef);
    assert.equal(f.calls.length, 0);
  };
  try {
    await assertBlocked();
    await other.host.cancelTurn({ draftId: occupyingDraft.id, expectedStateVersion: (await latest(other, occupyingDraft)).stateVersion,
      turnId: 'occupying-turn' }, context);
    await occupying;
    assert.equal((await latest(other, occupyingDraft)).physicalOutstanding.length, 1);
    await assertBlocked();
  } finally { release(); await occupying; }
  await until(async () => !(await latest(other, occupyingDraft)).physicalOutstanding.length);
  const ready = await f.host.advanceTurn(retryInput, context);
  assert.equal(ready.status, 'candidate-ready');
  assert.deepEqual(await f.host.advanceTurn(retryInput, context), ready);
  assert.equal(f.calls.length, 4);
  assert.equal(turnRecord(f.file, 'retry-turn').budget.deadlineMs, settled.budget.deadlineMs);
});

test('I4 S32/S99/S100/S101/S128: durable cancellation fences first, retains the physical slot, saves new input and rejects late candidate writes', async t => {
  const f = await setup(t, { capacity: { maxPhysicalExecutions: 1 } }); let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; }); f.releases.push(release);
  const raw = f.options.execution.request; let first = true;
  f.options.execution.request = async input => {
    if (first) { first = false; f.calls.push(input); entered(); await barrier; return structuredClone(intent); }
    return raw(input);
  };
  const draft = await f.start(), running = advance(f, draft); await started;
  const cancelled = await f.host.cancelTurn({ draftId: draft.id, expectedStateVersion: (await latest(f, draft)).stateVersion, turnId: 'turn' }, context);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(turnRecord(f.file).executionToken, null);
  await running;
  const queued = await advance(f, draft, { turnId: 'next', input: 'Inspect again' });
  assert.equal(queued.outcome, 'blocked-by-inflight'); assert.deepEqual(queued.pendingTurnIds, ['next']); assert.equal(f.calls.length, 1);
  await assert.rejects(f.host.settleTurn({ draftId: draft.id, expectedStateVersion: (await latest(f, draft)).stateVersion, turnId: 'turn',
    decision: 'confirm-no-effect', evidenceRef: 'not-yet-done' }, context), /outstanding/);
  release(); await until(async () => !(await latest(f, draft)).physicalOutstanding.length);
  assert.equal((await latest(f, draft)).candidate, undefined); assert.equal(turnRecord(f.file).result, undefined);
  const next = await advance(f, draft, { turnId: 'next', input: 'Inspect again' }); assert.equal(next.status, 'candidate-ready'); assert.equal(f.calls.length, 5);
  const before = next.stateVersion;
  const completedCancel = await f.host.cancelTurn({ draftId: draft.id, expectedStateVersion: before, turnId: 'next' }, context);
  assert.equal(completedCancel.status, 'candidate-ready'); assert.equal(completedCancel.stateVersion, before);
});

test('I4 S93/S105: an ignored physical request outlives the logical deadline and close reports it until actual completion', async t => {
  const f = await setup(t, { budgetPolicy: { durationMs: 1000 } }); let release;
  const barrier = new Promise(resolve => { release = resolve; }); f.releases.push(release);
  const realNow = Date.now.bind(Date);
  let clockOffset = 0;
  t.mock.method(Date, 'now', () => realNow() + clockOffset);
  f.options.execution.request = async () => { clockOffset = -60_000; await barrier; return structuredClone(intent); };
  const draft = await f.start(), result = await advance(f, draft);
  assert.equal(result.status, 'needs-revision'); assert.ok(result.physicalOutstanding.length);
  assert.equal(result.diagnostics[0].code, 'FKA_DEADLINE');
  clockOffset = 0;
  const closing = await f.host.close({ mode: 'cancel', timeoutMs: 20 }); assert.equal(closing.closed, false); assert.equal(closing.outstanding, 1);
  release(); await until(async () => (await f.host.close({ mode: 'drain', timeoutMs: 20 })).closed);
});

test('a deadline crossed during commit authorization fences promotion and stays expired after a clock rollback and reopen', async t => {
  const f = await setup(t);
  const realNow = Date.now.bind(Date);
  let wallTime;
  t.mock.method(Date, 'now', () => wallTime ?? realNow());
  const authorize = f.options.authorization.authorize;
  f.options.authorization.authorize = async request => {
    if (request.action === 'advance-commit') wallTime = turnRecord(f.file).budget.deadlineMs + 1;
    return authorize(request);
  };
  const draft = await f.start();
  const result = await advance(f, draft);
  assert.equal(result.status, 'reconciliation-required', JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics[0].code, 'FKA_DEADLINE');
  assert.ok(!result.candidate);
  const persisted = turnRecord(f.file);
  assert.ok(persisted.preparedResultHash);
  assert.equal(persisted.deadlineExpired, true);
  assert.equal(persisted.result, undefined);
  await f.host.close();
  wallTime = persisted.budget.deadlineMs - 1;
  const reopened = await createWorkflowAuthorHost(f.options);
  f.hosts.push(reopened);
  const recovered = await reopened.readDraft({ draftId: draft.id }, context);
  const settled = await reopened.settleTurn({ draftId: draft.id, expectedStateVersion: recovered.stateVersion, turnId: 'turn',
    decision: 'confirm-no-effect', evidenceRef: 'expired-turn-had-no-effect' }, context);
  assert.equal(settled.retryRef, null);
  assert.equal(settled.budget.deadlineMs, persisted.budget.deadlineMs);
  assert.equal(f.calls.length, 4);
});

test('a retry first observed after expiry stays ineligible after a wall-clock rollback', async t => {
  const f = await setup(t);
  const realNow = Date.now.bind(Date);
  let wallTime;
  t.mock.method(Date, 'now', () => wallTime ?? realNow());
  f.options.execution.request = async () => { throw new Error('Fixture model unavailable'); };
  const draft = await f.start();
  const failed = await advance(f, draft);
  const proof = await f.host.settleTurn({ draftId: draft.id, expectedStateVersion: failed.stateVersion, turnId: 'turn',
    decision: 'confirm-no-effect', evidenceRef: 'fixture-known-no-effect' }, context);
  assert.ok(proof.retryRef);
  const retry = { draftId: draft.id, expectedStateVersion: proof.stateVersion, turnId: 'turn',
    kind: 'retry', retryRef: proof.retryRef, input: 'Inspect' };
  wallTime = proof.budget.deadlineMs + 1;
  await assert.rejects(f.host.advanceTurn(retry, context), { code: 'FKA_SETTLEMENT_INVALID' });
  assert.equal(turnRecord(f.file).deadlineExpired, true);
  await f.host.close();
  wallTime = proof.budget.deadlineMs - 1;
  const reopened = await createWorkflowAuthorHost(f.options);
  f.hosts.push(reopened);
  await assert.rejects(reopened.advanceTurn(retry, context), { code: 'FKA_SETTLEMENT_INVALID' });
  assert.equal(turnRecord(f.file).attemptHistory, undefined);
});

test('I4 S33/S102/S104/S114: a persisted completed result survives a real candidate-commit fault and trusted settlement promotes it without rerunning', async t => {
  const f = await setup(t);
  database(f.file, db => db.exec("CREATE TRIGGER cut_candidate BEFORE UPDATE ON fk_author_drafts WHEN NEW.status='candidate-ready' BEGIN SELECT RAISE(ABORT, 'cut-candidate-commit'); END;"));
  const draft = await f.start(), failed = await advance(f, draft);
  assert.equal(failed.status, 'reconciliation-required', JSON.stringify(failed.diagnostics));
  const persisted = turnRecord(f.file); assert.ok(persisted.preparedResult.state.candidate); assert.equal(f.calls.length, 4);
  const verified = f.options.authorization.verifySettlement;
  f.options.authorization.verifySettlement = async binding => ({ ...await verified(binding), attemptId: 'wrong' });
  const input = { draftId: draft.id, expectedStateVersion: failed.stateVersion, turnId: 'turn', decision: 'confirm-result', evidenceRef: 'actual-completed-result' };
  await assert.rejects(f.host.settleTurn(input, context), /exact attempt/);
  f.options.authorization.verifySettlement = verified; database(f.file, db => db.exec('DROP TRIGGER cut_candidate'));
  const settled = await f.host.settleTurn(input, context); assert.equal(settled.result.status, 'candidate-ready');
  assert.equal(settled.result.candidate.hash, persisted.preparedResult.state.candidate.hash); assert.equal(f.calls.length, 4);
});

test('I4 S34/S95/S145: killing the owned reservation worker preserves charged budget and requires proof before an explicit same-turn retry', async t => {
  const f = await setup(t); await f.host.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./author-crash-worker.mjs', import.meta.url)), f.file], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false; child.once('exit', () => { exited = true; }); child.stderr.resume();
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const ready = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', chunk => { output += chunk; const line = output.split('\n')[0]; if (line.endsWith('}')) resolve(JSON.parse(line)); }); child.once('error', reject);
  });
  assert.equal(ready.pid, child.pid); const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; assert.equal(exited, true);
  const resumed = await fixture(f.file); f.hosts.push(resumed.host);
  const recovered = await resumed.host.readDraft({ draftId: ready.draftId }, context); assert.equal(recovered.status, 'reconciliation-required');
  const reservation = turnRecord(f.file, 'crash-turn'); assert.equal(reservation.budget.used.requests, 1);
  assert.equal(Object.values(reservation.budget.reservations)[0].status, 'reserved');
  const settled = await resumed.host.settleTurn({ draftId: ready.draftId, expectedStateVersion: recovered.stateVersion, turnId: 'crash-turn',
    decision: 'confirm-no-effect', evidenceRef: 'owned-worker-exited-before-provider' }, context);
  const result = await resumed.host.advanceTurn({ draftId: ready.draftId, expectedStateVersion: settled.stateVersion, turnId: 'crash-turn',
    kind: 'retry', retryRef: settled.retryRef, input: 'Inspect' }, context);
  assert.equal(result.status, 'candidate-ready', JSON.stringify(result.diagnostics));
  const after = turnRecord(f.file, 'crash-turn'); assert.equal(after.budget.used.requests, 5); assert.equal(after.budget.deadlineMs, reservation.budget.deadlineMs);
});

test('I4 S110/S112: a directory alias reads the same store identity while hard links and wrong schema are rejected before mutation', async t => {
  const f = await setup(t); const draft = await f.start(), alias = path.join(f.dir, 'alias');
  await symlink(f.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = await fixture(path.join(alias, 'author.sqlite')); f.hosts.push(aliased.host);
  assert.equal((await aliased.host.readDraft({ draftId: draft.id }, context)).storeId, draft.storeId);
  const hard = path.join(f.dir, 'hard.sqlite'); await link(f.file, hard); const before = await readFile(f.file);
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, storageFile: hard }), /Hard-linked/);
  assert.deepEqual(await readFile(f.file), before); await unlink(hard);
});

test('I5 S115: an actual process kill after the saved transaction and before publish returns recovers the original operation without duplicate writes', async t => {
  const f = await setup(t); await f.host.close();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./author-crash-worker.mjs', import.meta.url)), f.file, 'publication'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false; child.once('exit', () => { exited = true; }); child.stderr.resume();
  t.after(() => { if (!exited) child.kill('SIGKILL'); });
  const ready = await new Promise((resolve, reject) => {
    let output = ''; child.stdout.on('data', chunk => { output += chunk; const line = output.split('\n')[0]; if (line.endsWith('}')) resolve(JSON.parse(line)); }); child.once('error', reject);
  });
  assert.equal(ready.pid, child.pid); const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  const recovered = await fixture(f.file); f.hosts.push(recovered.host);
  const result = await recovered.host.publish(ready.publication, context);
  assert.equal(result.status, 'saved'); assert.equal(result.candidateHash, ready.publication.candidateHash); assert.equal(recovered.calls.length, 0);
  assert.equal(database(f.file, db => db.prepare('SELECT count(*) AS count FROM fk_author_versions').get().count), 1);
  assert.equal((await recovered.host.readDraft({ draftId: ready.publication.draftId }, context)).savedReceipt.publicationId, ready.publication.publicationId);
});

test('I4 S49/S125/S126/S127/S129: default discard retains bodies; explicit unreferenced cleanup leaves replay-denying tombstones', async t => {
  const f = await setup(t, { capacity: { maxDrafts: 2, maxPendingCandidates: 1 }, retention: { policyRef: 'owned-retention', idempotencyRetentionMs: 60000 } });
  const first = await f.start(), ready = await advance(f, first);
  const second = await f.start({ requestId: 'second', target: { name: 'second', description: 'Second', version: '1.0.0' } });
  await assert.rejects(advance(f, second), /Pending candidate capacity/);
  const discarded = await f.host.discard({ draftId: first.id, expectedStateVersion: ready.stateVersion, candidateHash: ready.candidate.hash }, context);
  assert.ok(discarded.candidate); await assert.rejects(f.start({ requestId: 'third' }), /Retained draft capacity/);
  const expired = await f.host.discard({ draftId: first.id, expectedStateVersion: discarded.stateVersion, candidateHash: ready.candidate.hash,
    purgeBody: true, retentionPolicyRef: 'owned-retention' }, context);
  assert.equal(expired.status, 'expired'); assert.equal(expired.candidate, undefined);
  await assert.rejects(f.start(), /expired/);
  await assert.rejects(advance(f, first), /expired/);
  assert.equal((await f.start({ requestId: 'third' })).status, 'draft');
  const next = await advance(f, second); assert.equal(next.status, 'candidate-ready');
});
