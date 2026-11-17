import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectionSkill } from './collections.mjs';
import { checkProfessionalSkill } from './professional-skills.mjs';
import { validateSkillName } from './skill-document.mjs';
import { checkCandidate } from './standard-artifact.mjs';

/** Materialize one approved store snapshot. The Host chooses which completed generation to advertise. */
export async function stageCollectionForDiscovery(store, collectionId, hostOwnedRoot) {
  const snapshot = store.readCollection(collectionId);
  if (!snapshot) throw new Error('The Host has no approved collection with this ID');
  const { collection, skills } = snapshot;
  validateSkillName(collection.name);
  if (collection.id !== collectionId || collection.name !== collection.directory) throw new Error('Collection identity differs');
  const root = path.resolve(hostOwnedRoot);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, '.flowkit-stage-'));
  const complete = path.join(root, `flowkit-collection-${randomUUID()}`);
  try {
    const entries = path.join(staging, collection.directory, 'skills');
    await mkdir(entries, { recursive: true });
    await writeFile(path.join(staging, collection.directory, 'SKILL.md'), collection.rootSkill, { flag: 'wx' });
    for (const candidate of skills) {
      if (candidate.manifest.kind === 'professional') checkProfessionalSkill(candidate);
      else checkCandidate(candidate);
      const { skillId, collectionId: owner, name } = candidate.manifest;
      if (owner !== collectionId) throw new Error('Workflow belongs to a different collection');
      const workflow = collectionSkill(collection, { id: skillId, name });
      const directory = path.join(staging, workflow.directory);
      await mkdir(directory);
      for (const [file, body] of Object.entries(candidate.files)) {
        const target = path.join(directory, file);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body, { flag: 'wx' });
      }
    }
    await rename(staging, complete);
    return { discoveryRoot: complete, collectionId, directory: path.join(complete, collection.directory),
      skills: skills.map(candidate => ({ id: candidate.manifest.skillId, hash: candidate.hash })) };
  } catch (error) {
    if (path.dirname(staging) === root && path.basename(staging).startsWith('.flowkit-stage-')) {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}
