import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, context } from './author-host-fixture.mjs';

async function setup(t, overrides) {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowkit-author-host-'));
  const result = await fixture(path.join(directory, 'author.sqlite'), overrides);
  t.after(async () => { await result.host.close({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }); });
  return { ...result, directory };
}
async function candidate(f) {
  const draft = await f.start();
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect' }, context);
}

test('I1 installed core performs actual parse/Plan/compile/review and atomically saves exact approved three-file candidate', async t => {
  const f = await setup(t); await f.register();
  const start = await f.start(); assert.equal(f.calls.length, 0);
  const input = { draftId: start.id, expectedStateVersion: start.stateVersion, turnId: 'turn', input: 'Inspect' };
  const ready = await f.host.advanceTurn(input, context);
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.deepEqual(Object.keys(ready.candidate.files), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  assert.equal(ready.reviewReceipt.qualified, true);
  const calls = f.calls.length;
  const replay = await f.host.advanceTurn(input, context); assert.deepEqual(replay, ready); assert.equal(f.calls.length, calls);
  await assert.rejects(f.host.advanceTurn({ ...input, contextSnapshot: { changed: true } }, context), /different bound material/);
  const review = await f.host.reviewCandidate({ draftId: ready.id, candidateHash: ready.candidate.hash, previousHash: null }, context);
  assert.equal(review.receipt.reviewRef, ready.reviewReceipt.reviewRef);
  const approval = { draftId: ready.id, expectedStateVersion: (await f.host.readDraft({ draftId: ready.id }, context)).stateVersion,
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: review.receipt.reviewRef, approvalRef: 'user-approved' };
  await assert.rejects(f.host.recordApproval(approval, context), /explicit user approval/);
  f.approvals.set(approval.approvalRef, ready.candidate.hash);
  const approved = await f.host.recordApproval(approval, context);
  const publication = { ...approval, expectedStateVersion: approved.stateVersion, publicationId: 'save-1' };
  await assert.rejects(f.host.publish({ ...publication, candidateHash: 'wrong' }, context), /exact review/);
  const saved = await f.host.publish(publication, context); assert.equal(saved.status, 'saved'); assert.equal(saved.discovery, 'pending');
  assert.equal(saved.collectionSnapshot, undefined);
  const replaySave = await f.host.publish(publication, context); assert.equal(replaySave.currentActive, ready.candidate.hash);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'), { readOnly: true });
  try {
    const durable = JSON.parse(db.prepare('SELECT payload FROM fk_author_drafts WHERE draft_id=?').get(ready.id).payload);
    assert.equal(durable.savedReceipt.candidateHash, ready.candidate.hash);
    assert.equal(durable.savedReceipt.collectionSnapshot.skills[0].hash, ready.candidate.hash);
    assert.equal(db.prepare('SELECT count(*) AS total FROM fk_author_versions').get().total, 1);
    const turn = JSON.parse(db.prepare('SELECT payload FROM fk_author_turns').get().payload);
    assert.equal(turn.budget.used.requests, 4); assert.equal(turn.budget.repairs.length, 0);
  } finally { db.close(); }
});

test('I1 rejects wrong namespace, unowned file and opaque unobserved execution without modifying foreign bytes', async t => {
  const f = await setup(t);
  const draft = await f.start();
  await assert.rejects(f.host.readDraft({ draftId: draft.id }, { ...context, namespace: 'other' }), /namespace/);
  const { createWorkflowAuthorHost } = await import('../../dist/host.mjs');
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, namespace: 'other' }), /namespace or schema differs/);
  const foreign = path.join(f.directory, 'foreign.sqlite');
  const db = new DatabaseSync(foreign); db.exec('CREATE TABLE users (id INTEGER)'); db.close();
  const before = await readFile(foreign);
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, storageFile: foreign }), /no such table|namespace|schema/);
  assert.deepEqual(await readFile(foreign), before);
  const invalid = path.join(f.directory, 'not-a-database'); await writeFile(invalid, 'user material');
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, storageFile: invalid }), /database/);
  assert.equal((await readFile(invalid)).toString(), 'user material');
});

test('I1 finite per-turn request budget stops before extra model dispatch', async t => {
  const f = await setup(t, { budgetPolicy: { maxRequests: 1 } });
  const ready = await candidate(f);
  assert.equal(ready.status, 'needs-revision'); assert.equal(f.calls.length, 1); assert.equal(ready.candidate, undefined);
  assert.match(JSON.stringify(ready.diagnostics), /budget/);
});

test('I1 opaque Intent, invalid TaskV2 envelope, unqualified review and shared technical repair limits never publish', async t => {
  for (const failure of ['opaque', 'envelope', 'review', 'repair']) {
    const f = await setup(t);
    if (failure === 'opaque') f.options.execution.createSession = async () => ({ intentRuntime: { parse: async () => ({}) }, runtime: { runAgentTask: async () => ({}), validateResult: () => [] } });
    if (failure === 'envelope') {
      const request = f.options.execution.request;
      f.options.execution.request = async input => input.stage === 'agent' ? { status: 'succeeded', result: { rawText: '{}' } } : request(input);
    }
    if (failure === 'review') f.options.authorization.observeReview = async () => null;
    if (failure === 'repair') {
      const request = f.options.execution.request;
      f.options.execution.request = async input => input.prepared?.task.node.id !== 'semantic-review' && input.stage === 'agent' ?
        (f.calls.push(input), { status: 'succeeded', result: { rawText: 'broken' }, events: [] }) : request(input);
    }
    const result = await candidate(f);
    assert.notEqual(result.status, 'candidate-ready', failure);
    assert.ok(!result.reviewReceipt, failure);
    const current = await f.host.readDraft({ draftId: result.id }, context);
    await assert.rejects(f.host.publish({ draftId: result.id, expectedStateVersion: current.stateVersion,
      candidateHash: result.candidate?.hash ?? 'missing', previousHash: null, reviewRef: 'fake', approvalRef: 'fake', publicationId: 'fake' }, context), /exact review/);
    if (failure === 'repair') assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'plan-repair').length, 2);
  }
});

test('I1 a real SQLite fault after formal version writes rolls back active, version and draft receipt together', async t => {
  const f = await setup(t); await f.register();
  const ready = await candidate(f);
  f.approvals.set('user', ready.candidate.hash);
  const identity = { draftId: ready.id, candidateHash: ready.candidate.hash, previousHash: null,
    reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'user' };
  const approved = await f.host.recordApproval({ ...identity, expectedStateVersion: (await f.host.readDraft({ draftId: ready.id }, context)).stateVersion }, context);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'));
  try {
    db.exec("CREATE TRIGGER cut_saved BEFORE UPDATE ON fk_author_drafts WHEN NEW.status='saved' BEGIN SELECT RAISE(ABORT, 'cut-after-version'); END;");
    const input = { ...identity, expectedStateVersion: approved.stateVersion, publicationId: 'atomic' };
    await assert.rejects(f.host.publish(input, context), /cut-after-version/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_versions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_active').get().n, 0);
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).savedReceipt, undefined);
    db.exec('DROP TRIGGER cut_saved');
    assert.equal((await f.host.publish(input, context)).status, 'saved');
  } finally { db.close(); }
});

test('I3 precise Host approval registration and publication share a single rollback boundary', async t => {
  const f = await setup(t); await f.register(); const ready = await candidate(f);
  const input = { draftId: ready.id, expectedStateVersion: ready.stateVersion, publicationId: 'atomic-approval',
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'user' };
  f.approvals.set('user', ready.candidate.hash);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'));
  try {
    db.exec("CREATE TRIGGER cut_approval_save BEFORE UPDATE ON fk_author_drafts WHEN NEW.status='saved' BEGIN SELECT RAISE(ABORT, 'cut-approved-save'); END;");
    await assert.rejects(f.host.publish(input, context), /cut-approved-save/);
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).approvalReceipt, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_versions').get().n, 0);
    db.exec('DROP TRIGGER cut_approval_save');
    assert.equal((await f.host.publish(input, context)).status, 'saved');
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).approvalReceipt.approvalRef, 'user');
  } finally { db.close(); }
});

test('I3 owner-specific authorization covers read, cancel, settle, discard and every model/Graph/document port', async t => {
  const f = await setup(t); const draft = await f.start();
  const other = { ...context, principalId: 'other' };
  let allowed = true;
  f.options.authorization.authorize = async ({ ownerScope, requestContext }) => allowed && (!ownerScope || ownerScope.principalId === requestContext.principalId);
  for (const name of ['readDraft', 'cancelTurn', 'settleTurn', 'discard']) {
    await assert.rejects(f.host[name]({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'none', candidateHash: null }, other), /denied/);
  }
  const raw = f.options.execution.request;
  f.options.execution.request = async input => { const result = await raw(input); allowed = false; return result; };
  await assert.rejects(f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'revoke', input: 'Inspect' }, context), /denied/);
  assert.equal(f.calls.length, 1);
});
