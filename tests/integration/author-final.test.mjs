import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, context } from './author-host-fixture.mjs';
import { authorInput } from '../../src/author/host-target.mjs';
import { planNewCollection } from '../../src/author/collections.mjs';

async function setup(t, overrides) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-author-final-')), f = await fixture(path.join(dir, 'author.sqlite'), overrides);
  f.hosts = [f.host];
  t.after(async () => { for (const host of f.hosts.slice().reverse()) await host.close({ mode: 'cancel' }); await rm(dir, { recursive: true, force: true }); }); return f;
}
async function advance(f, draft, ctx = context, extra = {}) {
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect', ...extra }, ctx);
}
async function approve(f, ready, ctx = context) {
  f.approvals.set('approved', ready.candidate.hash);
  return f.host.recordApproval({ draftId: ready.id, expectedStateVersion: ready.stateVersion, candidateHash: ready.candidate.hash,
    previousHash: ready.previousHash, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'approved' }, ctx);
}
const saveInput = value => ({ draftId: value.id, expectedStateVersion: value.stateVersion, publicationId: 'saved', candidateHash: value.candidate.hash,
  previousHash: value.previousHash, reviewRef: value.reviewReceipt.reviewRef, approvalRef: 'approved' });

test('I5 S08/S51/S52/S127/S129: UTF-8 input bounds, empty goals, 16-candidate capacity and terminal discard are enforced', async t => {
  const f = await setup(t); await assert.rejects(f.start({ goal: ' ' }), /goal/);
  const value = '你好', size = Buffer.byteLength(JSON.stringify(value));
  assert.equal(authorInput(value, size), value); assert.throws(() => authorInput(value, size - 1), /byte limit/);
  const ready = [];
  for (let i = 0; i < 16; i++) ready.push(await advance(f, await f.start({ requestId: 'draft-' + i })));
  assert.ok(ready.every(value => value.status === 'candidate-ready'));
  const next = await f.start({ requestId: 'draft-16' }); await assert.rejects(advance(f, next), /Pending candidate/);
  const discarded = await f.host.discard({ draftId: ready[0].id, expectedStateVersion: ready[0].stateVersion,
    candidateHash: ready[0].candidate.hash }, context);
  await assert.rejects(advance(f, discarded, context, { turnId: 'new' }), /terminal/);
  assert.equal((await advance(f, next)).status, 'candidate-ready');
  const small = await setup(t, { capacity: { maxDraftBytes: 512 } });
  await assert.rejects(small.start(), /Draft byte capacity/);
  assert.equal(small.host.createMcpOptions().store.authorTransaction(state => state.usage()).drafts, 0);
});

test('I5 S90/S144: an approval observation delayed across a content edit cannot approve the newer candidate', async t => {
  const f = await setup(t), ready = await advance(f, await f.start()); let release, entered;
  const barrier = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { entered = resolve; });
  t.after(() => release()); const verify = f.options.authorization.verifyApproval;
  f.options.authorization.verifyApproval = async binding => { entered(); await barrier; return verify(binding); };
  const approval = approve(f, ready); const rejected = assert.rejects(approval, /stateVersion|changed/); await observed;
  const edited = await advance(f, ready, context, { turnId: 'edited', input: 'Inspect and preserve the API' });
  release(); await rejected; assert.equal(edited.approvalReceipt, null);
});

test('I5 S25: reopening under a changed Host profile projects old qualifications as stale without changing stored history', async t => {
  const f = await setup(t), approved = await approve(f, await advance(f, await f.start()));
  const reopened = await fixture(f.options.storageFile, { hostProfile: { id: 'changed-host', digest: 'sha256:' + 'b'.repeat(64) } });
  f.hosts.push(reopened.host);
  const projected = await reopened.host.readDraft({ draftId: approved.id }, context);
  assert.equal(projected.status, 'needs-review'); assert.equal(projected.reviewReceipt.qualified, false); assert.equal(projected.approvalReceipt, null);
  assert.equal((await f.host.readDraft({ draftId: approved.id }, context)).status, 'approved'); assert.equal(reopened.calls.length, 0);
  await assert.rejects(reopened.host.recordApproval({ draftId: approved.id, expectedStateVersion: approved.stateVersion,
    candidateHash: approved.candidate.hash, previousHash: null, reviewRef: approved.reviewReceipt.reviewRef, approvalRef: 'approved' }, context), /qualified exact/);
});

test('I5 S30/S50/S62/S147: cross-namespace migration preserves IDs, reports target conflict and never mutates its approved source', async t => {
  const source = await setup(t); await source.register(); const original = await advance(source, await source.start());
  await source.host.publish(saveInput(await approve(source, original)), context);
  const target = await setup(t, { namespace: 'target', resolveImportSource: async () => ({ candidate: original.candidate, sourceRef: 'approved-source' }) });
  const targetContext = { ...context, namespace: 'target' };
  target.options.authorization.verifyImport = async binding => binding.sourceHash === original.candidate.hash;
  const plan = planNewCollection({ name: 'target-workflows', source: { id: 'team' }, preserveId: true }, [], () => null);
  await target.host.createMcpOptions().applyCollectionPlan(plan, 'target-collection', targetContext);
  const input = { collectionId: 'team', requestId: 'migration', goal: 'Import approved inspection', operation: 'import',
    importSource: { sourceRef: 'approved-source', mode: 'migration' } };
  const draft = await target.host.start(input, targetContext);
  assert.equal(draft.target.skillId, original.target.skillId);
  const reviewed = await advance(target, draft, targetContext, { kind: 'review-only' });
  const approved = await approve(target, reviewed, targetContext), publish = saveInput(approved);
  const saved = await target.host.publish(publish, targetContext); assert.equal(saved.status, 'saved');
  assert.deepEqual(await target.host.publish(publish, targetContext), saved);
  const second = await target.host.start({ ...input, requestId: 'migration-again' }, targetContext);
  const again = await approve(target, await advance(target, second, targetContext, { kind: 'review-only' }), targetContext);
  await assert.rejects(target.host.publish(saveInput(again), targetContext), /Active.*changed|active.*changed/);
  assert.equal(source.host.createMcpOptions().store.readActive('team', original.target.skillId).hash, original.candidate.hash);
  assert.equal(target.host.createMcpOptions().store.readActive('team', original.target.skillId).hash, reviewed.candidate.hash);
});
