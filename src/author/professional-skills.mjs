import { collectionSkill } from './collections.mjs';
import { artifactDigest, professionalSkillFileHashes } from '../shared/artifact-identity.mjs';
import { isSemVer } from '../shared/task-spec.mjs';
import { skillDocument, validateSkillName } from './skill-document.mjs';
import { publishReviewedCandidate } from './standard-artifact.mjs';

const resourceFolders = new Set(['references', 'scripts', 'assets']);

function professionalResource(file) {
  const [root, ...segments] = file.split('/');
  return resourceFolders.has(root) && segments.length > 0 && segments.every(segment =>
    /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(segment) && !['skills', 'skill.md'].includes(segment.toLowerCase()) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment));
}

/** Build one Professional Skill candidate under the same collection namespace. */
export function prepareProfessionalSkill(collection, { id, name, version, description, body, resources = {} }) {
  const { collectionId, skillId } = collectionSkill(collection, { id, name });
  if (!isSemVer(version) || typeof body !== 'string' || !body.trim() ||
    Object.entries(resources).some(([file, content]) => !professionalResource(file) || typeof content !== 'string')) {
    throw new TypeError('Professional Skill requires a version, body and portable resource paths');
  }
  const files = Object.freeze({ 'SKILL.md': skillDocument(name, description, body),
    ...Object.fromEntries(Object.entries(resources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
  const fileHashes = Object.freeze(professionalSkillFileHashes(files));
  const manifest = Object.freeze({ kind: 'professional', collectionId, skillId, name, version,
    description, files: fileHashes, digest: artifactDigest(JSON.stringify(fileHashes)) });
  const candidate = Object.freeze({ files, manifest, hash: artifactDigest(JSON.stringify(manifest)) });
  checkProfessionalSkill(candidate);
  return candidate;
}

export function checkProfessionalSkill({ files, manifest, hash }) {
  validateSkillName(manifest.name);
  const names = Object.keys(files);
  const identity = value => typeof value === 'string' && value.trim() && !/\s/.test(value);
  const entry = skillDocument(manifest.name, manifest.description, '');
  const native = manifest.format === 'codex-native';
  if (manifest.kind !== 'professional' || (manifest.format !== undefined && !native) ||
    !identity(manifest.collectionId) || !identity(manifest.skillId) ||
    !isSemVer(manifest.version) || !Object.hasOwn(files, 'SKILL.md') ||
    names.length !== new Set(names.map(name => name.toLowerCase())).size ||
    names.length !== Object.keys(manifest.files).length ||
    names.some(file => file !== 'SKILL.md' && !professionalResource(file) || typeof files[file] !== 'string' ||
      artifactDigest(files[file]) !== manifest.files[file]) ||
    (!native && !files['SKILL.md'].startsWith(entry.slice(0, -1))) ||
    manifest.digest !== artifactDigest(JSON.stringify(manifest.files)) || hash !== artifactDigest(JSON.stringify(manifest))) {
    throw new TypeError('Professional Skill candidate bytes or manifest differ');
  }
}

export function publishProfessionalSkill(candidate, receipts, host) {
  if (candidate.manifest.format === 'codex-native') throw new TypeError('An existing native Skill stays in its Host catalog');
  return publishReviewedCandidate(candidate, receipts, host, checkProfessionalSkill);
}

/** Resolve an exact Skill only from the receiving Host's authorized source. */
export async function resolveTrustedProfessionalPin(store, pin, { collectionId, resolve, scope }) {
  const local = pin.source === 'collection:' + collectionId;
  const readLocal = local && store.readProfessionalVersion;
  const resolved = resolve ? await resolve(pin, scope) : readLocal && {
    source: pin.source, authorized: true, candidate: store.readProfessionalVersion(collectionId, pin.id, pin.version)
  };
  if (resolved?.authorized !== true || !resolved.candidate?.manifest || resolved.source !== pin.source) return null;
  const { candidate } = resolved;
  const { collectionId: origin, skillId, version, digest } = candidate.manifest;
  if ((candidate.manifest.format === 'codex-native' && !pin.source.startsWith('codex-skill:')) ||
      skillId !== pin.id || version !== pin.version || digest !== pin.digest ||
      pin.source.startsWith('collection:') && pin.source !== 'collection:' + origin) return null;
  try { checkProfessionalSkill(candidate); } catch { return null; }
  return { logicalId: skillId, resolvedVersion: version, digest, source: pin.source, files: { ...candidate.files } };
}

/** Search the authorized collection’s second layer. Read a body only after its metadata matched. */
export async function planProfessionalSkills(collection, node, host, { maxPages, maxBodies }) {
  if (node.professionalNeeds.length === 0) return { reuse: [], unmatched: [], conflicts: [] };
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(maxBodies) || maxBodies < 1) {
    throw new TypeError('Discovery requires Host-supplied page and body budgets');
  }
  const reuse = new Map();
  const matches = new Map(node.professionalNeeds.map(need => [need.id, []]));
  if (matches.size !== node.professionalNeeds.length) throw new TypeError('Professional needs must have unique IDs');
  const seenCursors = new Set();
  let cursor = null;
  let bodies = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await host.listProfessionalMetadata({ collectionId: collection.id, cursor });
    for (const item of result.items) {
      if (item.collectionId !== collection.id || item.kind !== 'professional' || resourceFolders.has(item.name)) continue;
      const scope = collectionSkill(collection, item);
      if (item.path !== `${scope.directory}/SKILL.md` || !isSemVer(item.version) ||
        typeof item.digest !== 'string' || item.digest.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(item.digest)) continue;
      const relevant = node.professionalNeeds.filter(need => host.matchesMetadata(need, item) === true);
      if (!relevant.length) continue;
      if (bodies === maxBodies) throw new Error('Professional Skill discovery exhausted its body budget');
      bodies++;
      const body = await host.readProfessionalSkill({ ...scope, version: item.version, digest: item.digest });
      for (const need of relevant) {
        if (await host.confirmApplicability(need, body, item) === true) matches.get(need.id).push(item);
      }
    }
    cursor = result.nextCursor;
    if (cursor === null) {
      const unmatched = [];
      const conflicts = [];
      for (const need of node.professionalNeeds) {
        const items = matches.get(need.id);
        if (items.length === 0) unmatched.push(need);
        else if (items.length > 1) conflicts.push({ need, candidates: items.map(({ id, name, version }) => ({ id, name, version })) });
        else {
          const { id, version, digest } = items[0];
          reuse.set(id, { nodeId: node.id, id, version, digest });
        }
      }
      return { reuse: [...reuse.values()], unmatched, conflicts };
    }
    if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) throw new Error('Invalid Professional Skill discovery cursor');
    seenCursors.add(cursor);
  }
  throw new Error('Professional Skill discovery exhausted its page budget');
}
