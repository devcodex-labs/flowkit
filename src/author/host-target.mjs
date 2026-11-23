import { authorError } from './host-budget.mjs';
import { checkCandidate } from './standard-artifact.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';

export const authorIdentity = value => artifactDigest(JSON.stringify(value, (_key, item) => item && typeof item === 'object' &&
  !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));

/** Compare already validated SemVer values, ignoring build metadata. */
export function isNewerWorkflowVersion(next, previous) {
  const parts = version => {
    const [, core, prerelease] = version.match(/^([^-+]+)(?:-([^+]+))?/);
    return [core.split('.').map(BigInt), prerelease?.split('.')];
  };
  const [nextCore, nextPre] = parts(next);
  const [previousCore, previousPre] = parts(previous);
  for (const [i, number] of nextCore.entries()) {
    if (number !== previousCore[i]) return number > previousCore[i];
  }
  if (!nextPre || !previousPre) return !nextPre && !!previousPre;
  for (const [i, value] of nextPre.entries()) {
    const base = previousPre[i];
    if (base === undefined) return true;
    if (value === base) continue;
    const numeric = /^\d+$/.test(value), baseNumeric = /^\d+$/.test(base);
    if (numeric !== baseNumeric) return baseNumeric;
    return numeric ? BigInt(value) > BigInt(base) : value > base;
  }
  return false;
}

export function sameSignedWorkflowOrigin(left, right) {
  return !!left?.issuer && left.issuer === right?.issuer &&
    left.collectionId === right.collectionId && left.skillId === right.skillId;
}

/** Snapshot data without invoking accessors. SDK and MCP consumers share this JSON boundary. */
export function authorInput(value, maxBytes) {
  let members = 0;
  function copy(item, depth = 0, active = new Set()) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || depth > 32 || active.has(item) ||
      !Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item))) throw authorError('author-input', 'Author input must be bounded JSON data');
    active.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item), result = Array.isArray(item) ? [] : {};
    if (Object.getOwnPropertySymbols(item).length || Object.entries(descriptors).some(([key, descriptor]) =>
      !(Array.isArray(item) && key === 'length') && (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) ||
      Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) throw authorError('author-input', 'Author input cannot contain getters, symbols, hidden JSON members or sparse arrays');
    for (const key of Object.keys(item)) {
      if (++members > 10000 || !Object.hasOwn(descriptors[key], 'value')) throw authorError('author-input', 'Author input cannot contain getters or excessive members');
      const child = descriptors[key].value;
      if (child !== undefined) Object.defineProperty(result, key, { value: copy(child, depth + 1, active), enumerable: true, writable: true, configurable: true });
    }
    active.delete(item); return result;
  }
  const result = copy(value);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw authorError('author-size', 'Author input byte limit exceeded');
  return result;
}

/** Display names never select an update target. The Host must pin the actual previous identity. */
export function authorTarget(input, store) {
  const operation = input.operation ?? 'create';
  if (!['create', 'update', 'import'].includes(operation)) throw authorError('author-target', 'Choose create, update or import');
  if (operation === 'import' && input.targetRef && input.importSource?.mode !== 'new-collection') {
    throw authorError('author-target', 'Only a cross-collection import can pin an existing Workflow version');
  }
  if (operation !== 'update' && !(operation === 'import' && input.targetRef)) {
    if (operation === 'create' && input.targetRef) throw authorError('author-target', 'Create cannot replace a pinned previous version');
    if (operation === 'create' && input.target?.skillId && store.readActive(input.collectionId, input.target.skillId)) {
      throw authorError('author-target', 'New Skill ID is already occupied');
    }
    return { operation, previous: null };
  }
  const ref = input.targetRef;
  if (!ref || ref.collectionId !== input.collectionId || !ref.skillId || !ref.baseArtifactHash || !ref.baseVersion) {
    throw Object.assign(authorError('author-target', 'Update requires an exact TargetRef; choose a matching Skill explicitly'),
      { options: store.readCollectionMetadata(input.collectionId, { limit: 10001 })?.skills.map(item => ({
        skillId: item.manifest.skillId, name: item.manifest.name, hash: item.hash, version: item.manifest.version })) ?? [], recommended: 'select-existing' });
  }
  const previous = store.readActive(ref.collectionId, ref.skillId);
  if (!previous || previous.manifest.artifactHash !== ref.baseArtifactHash || previous.manifest.version !== ref.baseVersion || previous.manifest.kind === 'professional') throw authorError('author-target', 'Pinned Workflow baseline is missing, changed or a different Skill kind');
  checkCandidate(previous);
  if (store.readActive(ref.collectionId, ref.skillId)?.hash !== previous.hash) throw authorError('author-conflict', 'Active target changed; review and rebase explicitly');
  if (input.target?.skillId && input.target.skillId !== ref.skillId || input.target?.version === ref.baseVersion) {
    throw authorError('author-target', 'Update preserves Skill ID and needs an unused version');
  }
  return { operation, previous };
}
