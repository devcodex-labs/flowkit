import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, context } from './author-host-fixture.mjs';
import { authorIdentity } from '../../src/author/host-target.mjs';
import { planCollectionGeneration, materializeCollectionGeneration } from '../../src/author/generation.mjs';
import { planCollectionRename } from '../../src/author/collections.mjs';

async function setup(t, behavior = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-discovery-')); let mapping = null, switches = 0;
  const discovery = { root: path.join(dir, 'owned'), async readMapping() { return structuredClone(mapping); },
    async compareAndSetMapping({ expected, next }) {
      switches++;
      if (authorIdentity(mapping) === authorIdentity(expected)) mapping = structuredClone(next);
      if (behavior.lostAck) { behavior.lostAck = false; throw new Error('controlled lost acknowledgement after Host CAS'); }
    },
    async readReferences({ generationId }) { return { generationId, evidenceRef: 'controlled-closed-admission',
      referenced: behavior.referenced ?? false, closedForNewRuns: behavior.closedForNewRuns ?? true }; } };
  if (behavior.noCas) delete discovery.compareAndSetMapping;
  const f = await fixture(path.join(dir, 'author.sqlite'), { discovery });
  t.after(async () => { await f.host.close({ mode: 'cancel' }); await rm(dir, { recursive: true, force: true }); });
  await f.register();
  return { ...f, dir, behavior, discovery, mapping: () => structuredClone(mapping), switches: () => switches,
    store: f.host.createMcpOptions().store };
}
async function approved(f, id, extra = {}) {
  const start = await f.start({ requestId: id, target: { name: id, description: id, version: '1.0.0' }, ...extra });
  const ready = await f.host.advanceTurn({ draftId: start.id, expectedStateVersion: start.stateVersion, turnId: 'turn', input: 'Inspect' }, context);
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  f.approvals.set(id, ready.candidate.hash);
  const input = { draftId: ready.id, expectedStateVersion: ready.stateVersion, candidateHash: ready.candidate.hash,
    previousHash: ready.previousHash, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: id };
  const result = await f.host.recordApproval(input, context);
  return { ready, input: { ...input, expectedStateVersion: result.stateVersion, publicationId: id } };
}

test('I4 S117/S120/S121: durable exact paths, full-tree hashes and mapping readback recover a lost CAS acknowledgement; missing CAS stays pending', async t => {
  const f = await setup(t, { lostAck: true }), a = await approved(f, 'inspect');
  const saved = await f.host.publish(a.input, context); assert.equal(saved.discovery, 'pending');
  const firstRoot = f.mapping().discoveryRoot; assert.ok(firstRoot);
  const recovered = await f.host.publish(a.input, context); assert.equal(recovered.discovery, 'active');
  assert.equal(recovered.generation.discoveryRoot, firstRoot); assert.equal(f.switches(), 1);
  assert.equal(recovered.generation.skills, undefined); assert.equal(recovered.collectionSnapshot, undefined);
  assert.deepEqual((await readdir(path.join(recovered.generation.directory, 'skills', 'inspect'))).sort(), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  const g = await setup(t, { noCas: true }), b = await approved(g, 'inspect');
  assert.equal((await g.host.publish(b.input, context)).discovery, 'pending'); assert.equal(g.switches(), 0);
});

test('I4 S39/S41/S59/S113/S116/S122/S146: saved A replay never reactivates it after B; a whole-collection change supersedes the old snapshot', async t => {
  const f = await setup(t), a = await approved(f, 'inspect');
  const savedA = await f.host.publish(a.input, context); assert.equal(savedA.discovery, 'active');
  const b = await approved(f, 'update', { operation: 'update', targetRef: { collectionId: 'team', skillId: a.ready.candidate.manifest.skillId,
    baseArtifactHash: a.ready.candidate.manifest.artifactHash, baseVersion: '1.0.0' },
    target: { name: 'inspect', description: 'Updated', version: '1.0.1' } });
  const savedB = await f.host.publish(b.input, context); assert.equal(savedB.discovery, 'active');
  const winner = f.mapping(); const replay = await f.host.publish(a.input, context);
  assert.equal(replay.discovery, 'superseded'); assert.equal(replay.currentActive, b.ready.candidate.hash); assert.deepEqual(f.mapping(), winner);
  await assert.rejects(f.host.publish({ ...b.input, candidateHash: a.ready.candidate.hash }, context), /different material|exact review/);
  const c = await approved(f, 'other'); assert.equal((await f.host.publish(c.input, context)).discovery, 'active');
  assert.equal((await f.host.publish(b.input, context)).discovery, 'superseded');
  assert.equal(f.mapping().operationId, f.store.authorTransaction(s => s.readDraft(c.ready.id)).publications.other.operationId);
});

test('I4 S63/S64: rename binds all active Skill hashes and publication rejects a renamed collection after review', async t => {
  const f = await setup(t); const a = await approved(f, 'inspect');
  const makePlan = () => planCollectionRename({ id: 'team', name: 'renamed' }, [f.store.readCollectionMetadata('team').collection], {
    directoryOwner: () => null, previewMigration: () => ({ expectedSnapshotHash: authorIdentity(f.store.readCollectionMetadata('team')),
      workflowReferences: [], mcpResources: [], hostMapping: null }) });
  const stale = makePlan(); await f.host.publish(a.input, context);
  await assert.rejects(f.host.createMcpOptions().applyCollectionPlan(stale, 'rename', context), /snapshot changed/);
  const pending = await approved(f, 'other');
  await f.host.createMcpOptions().applyCollectionPlan(makePlan(), 'rename', context);
  await assert.rejects(f.host.publish(pending.input, context), /Collection.*changed|collection.*changed/);
  assert.equal(f.store.readCollectionMetadata('team').collection.id, 'team');
  assert.equal(f.store.readVersion('team', a.ready.candidate.manifest.skillId, a.ready.candidate.hash).hash, a.ready.candidate.hash);
});

test('I4 S118/S119/S40: only verified owned partial staging resumes; fixed-path collisions and changed completed bytes are retained', async t => {
  const f = await setup(t); const a = await approved(f, 'inspect'); await f.host.publish(a.input, context);
  const snapshot = f.store.readCollection('team');
  const plan = planCollectionGeneration(snapshot, f.discovery.root, { namespace: 'test', publicationId: 'fixed', operationId: 'scoped-fixed',
    generationId: randomUUID(), snapshotHash: authorIdentity(f.store.readCollectionMetadata('team')) });
  const complete = await materializeCollectionGeneration(snapshot, f.discovery.root, plan);
  await rename(plan.complete, plan.staging);
  await rm(path.join(plan.staging, '.flowkit-generation.json'));
  await rm(path.join(plan.staging, 'team-workflows', 'skills', 'inspect', 'workflow.mmd'));
  const resumed = await materializeCollectionGeneration(snapshot, f.discovery.root, plan);
  assert.equal(resumed.discoveryRoot, complete.discoveryRoot);
  await writeFile(path.join(plan.complete, 'user.txt'), 'retain-user-material');
  await assert.rejects(materializeCollectionGeneration(snapshot, f.discovery.root, plan), /user-owned/);
  assert.equal(await readFile(path.join(plan.complete, 'user.txt'), 'utf8'), 'retain-user-material');
  const conflict = planCollectionGeneration(snapshot, f.discovery.root, { ...plan, generationId: randomUUID() });
  await mkdir(conflict.staging); await writeFile(path.join(conflict.staging, 'user.txt'), 'occupied');
  await assert.rejects(materializeCollectionGeneration(snapshot, f.discovery.root, conflict));
  assert.equal(await readFile(path.join(conflict.staging, 'user.txt'), 'utf8'), 'occupied');
});

test('I4 S123/S124: cleanup retains referenced or modified generations and removes only an unmapped drained exact generation', async t => {
  const f = await setup(t, { referenced: true }), a = await approved(f, 'inspect');
  const saved = await f.host.publish(a.input, context);
  const cleanup = async () => f.host.discard({ draftId: a.ready.id,
    expectedStateVersion: (await f.host.readDraft({ draftId: a.ready.id }, context)).stateVersion,
    candidateHash: a.ready.candidate.hash, generationId: saved.generation.generationId }, context);
  await assert.rejects(cleanup(), /referenced/); assert.ok(f.mapping());
  f.behavior.referenced = false;
  const user = path.join(saved.generation.discoveryRoot, 'user.txt'); await writeFile(user, 'keep');
  await assert.rejects(cleanup(), /user-owned/); assert.equal(f.mapping(), null); assert.equal(await readFile(user, 'utf8'), 'keep');
  await rm(user); const result = await cleanup(); assert.equal(result.status, 'saved');
  assert.equal((await f.host.publish(a.input, context)).discovery, 'removed'); assert.equal(f.mapping(), null);
  await assert.rejects(readFile(path.join(saved.generation.directory, 'SKILL.md')), { code: 'ENOENT' });
  assert.equal(f.store.readActive('team', a.ready.candidate.manifest.skillId).hash, a.ready.candidate.hash);
});
