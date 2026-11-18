import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, lstat, readdir, rename, open, realpath } from 'node:fs/promises';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { collectionSkill } from './collections.mjs';
import { checkCandidate } from './standard-artifact.mjs';
import { checkProfessionalSkill } from './professional-skills.mjs';
import { validateSkillName } from './skill-document.mjs';

const OWNER = '.flowkit-owner.json', MARKER = '.flowkit-generation.json';
const text = value => JSON.stringify(value) + '\n';
function bodies(snapshot) {
  const { collection, skills } = snapshot;
  validateSkillName(collection.name);
  if (collection.directory !== collection.name || !collection.id || typeof collection.rootSkill !== 'string') throw new Error('Generation collection identity differs');
  const result = { [collection.directory + '/SKILL.md']: collection.rootSkill };
  for (const candidate of skills) {
    if (candidate.manifest.kind === 'professional') checkProfessionalSkill(candidate); else checkCandidate(candidate);
    if (candidate.manifest.collectionId !== collection.id) throw new Error('Generation Skill belongs to another collection');
    const selected = collectionSkill(collection, { id: candidate.manifest.skillId, name: candidate.manifest.name });
    for (const [file, body] of Object.entries(candidate.files)) {
      const name = selected.directory + '/' + file;
      if (Object.hasOwn(result, name)) throw new Error('Generation contains a duplicate file');
      result[name] = body;
    }
  }
  return result;
}
const ownerRecord = plan => ({ schemaVersion: 1, namespace: plan.namespace, collectionId: plan.collectionId,
  publicationId: plan.publicationId, operationId: plan.operationId, generationId: plan.generationId, snapshotHash: plan.snapshotHash,
  manifestHash: plan.manifestHash, files: plan.files });
const completeRecord = plan => ({ collectionId: plan.collectionId, files: plan.files, manifestHash: plan.manifestHash,
  ownerHash: plan.ownerHash, namespace: plan.namespace, publicationId: plan.publicationId, generationId: plan.generationId, snapshotHash: plan.snapshotHash });

/** Prepare every identity/path/hash before filesystem mutation. The caller durably stores this plan. */
export function planCollectionGeneration(snapshot, hostOwnedRoot, { namespace, publicationId, operationId, generationId, snapshotHash }) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(generationId) || !namespace || !publicationId || !snapshotHash) throw new Error('Generation needs exact Host-owned scope and identity');
  const root = realpathSync.native(hostOwnedRoot), files = Object.fromEntries(Object.entries(bodies(snapshot)).map(([name, body]) => [name, artifactDigest(body)]));
  const entries = Object.values(bodies(snapshot));
  if (entries.length > 10000 || entries.reduce((size, body) => size + Buffer.byteLength(body), 0) > 128 * 1024 * 1024) throw new Error('Generation exceeds its file/byte capacity');
  const plan = { namespace, publicationId, operationId, generationId, collectionId: snapshot.collection.id, snapshotHash, root,
    staging: path.join(root, '.flowkit-stage-' + generationId), complete: path.join(root, 'flowkit-collection-' + generationId), files,
    manifestHash: artifactDigest(JSON.stringify({ collectionId: snapshot.collection.id, files })) };
  const owner = text(ownerRecord(plan));
  if (Buffer.byteLength(owner) > 1024 * 1024) throw new Error('Generation ownership record exceeds capacity');
  plan.ownerHash = artifactDigest(owner); plan.markerHash = artifactDigest(text(completeRecord(plan)));
  return plan;
}

async function exists(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function exact(file, expected, maximum) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('Generation contains an unowned or oversized file');
  const bytes = await readFile(file);
  if (bytes.length > maximum || artifactDigest(bytes) !== expected) throw new Error('Generation contains modified or incomplete bytes; retain it for reconciliation');
}
async function inspect(directory, plan, complete) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Generation path is not an owned directory');
  await exact(path.join(directory, OWNER), plan.ownerHash, 1024 * 1024);
  const seen = new Set(), pending = ['']; let visits = 0, total = 0;
  while (pending.length) {
    const relative = pending.pop();
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (++visits > 20000 || entry.isSymbolicLink()) throw new Error('Generation inspection exceeded its ownership boundary');
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!Object.keys(plan.files).some(file => file.startsWith(name + '/'))) throw new Error('Generation contains a user-owned directory');
        pending.push(name); continue;
      }
      if (name === OWNER) continue;
      if (name === MARKER) { await exact(path.join(directory, name), plan.markerHash, 1024 * 1024); seen.add(name); continue; }
      if (!Object.hasOwn(plan.files, name)) throw new Error('Generation contains a user-owned file');
      const file = path.join(directory, name), fileStat = await lstat(file); total += fileStat.size;
      if (total > 128 * 1024 * 1024) throw new Error('Generation inspection exceeds the byte budget');
      await exact(file, plan.files[name], 128 * 1024 * 1024); seen.add(name);
    }
  }
  if ((complete || seen.has(MARKER)) && (!seen.has(MARKER) || Object.keys(plan.files).some(file => !seen.has(file)))) throw new Error('Completed generation is incomplete');
}
async function writeExact(file, body) {
  const previous = await exists(file);
  if (previous) { await exact(file, artifactDigest(body), Buffer.byteLength(body)); return; }
  const handle = await open(file, 'wx');
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
}
async function directories(root, relative) {
  let directory = root;
  for (const part of relative.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    try { await mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Generation directory was replaced');
  }
}

/** Resume only verified owned filesystem staging, never a model Run or unknown directory. */
export async function materializeCollectionGeneration(snapshot, hostOwnedRoot, plan, signal) {
  const root = await realpath(hostOwnedRoot);
  const expected = planCollectionGeneration(snapshot, root, plan);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error('Persisted generation plan differs from the frozen snapshot/root');
  if (await exists(plan.complete)) await inspect(plan.complete, plan, true);
  else {
    const prior = await exists(plan.staging);
    if (prior) await inspect(plan.staging, plan, false);
    else { await mkdir(plan.staging); await writeExact(path.join(plan.staging, OWNER), text(ownerRecord(plan))); }
    for (const [name, body] of Object.entries(bodies(snapshot))) {
      signal?.throwIfAborted(); await directories(plan.staging, name); await writeExact(path.join(plan.staging, name), body);
    }
    await writeExact(path.join(plan.staging, MARKER), text(completeRecord(plan)));
    await inspect(plan.staging, plan, true);
    try { await rename(plan.staging, plan.complete); }
    catch (error) { if (!(await exists(plan.complete))) throw error; }
    await inspect(plan.complete, plan, true);
  }
  return { discoveryRoot: plan.complete, collectionId: plan.collectionId,
    directory: path.join(plan.complete, snapshot.collection.directory), manifestHash: plan.manifestHash,
    generationId: plan.generationId, snapshotHash: plan.snapshotHash,
    skills: snapshot.skills.map(candidate => ({ id: candidate.manifest.skillId, hash: candidate.hash })) };
}
