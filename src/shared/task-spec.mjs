import { validIntegrity } from './skill-ref.mjs';

export const TASK_FIELDS = Object.freeze(['description', 'descriptionRefs', 'requiredSkills']);
export const DESCRIPTION_MAX_BYTES = 262144;

/** SemVer 2.0 validation without coercing identifiers to bounded JS numbers. */
export function isSemVer(value) {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && match[0] === value && (!match[4] || match[4].split('.').every(part => !/^\d+$/.test(part) || part === '0' || part[0] !== '0'));
}

export function hasTaskSpec(node) {
  return TASK_FIELDS.some(key => Object.hasOwn(node, key));
}

export function localTextResource(uri) {
  return typeof uri === 'string' && /\.(md|markdown|txt)$/i.test(uri) &&
    uri.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
}

export function remoteTextResource(uri) {
  if (typeof uri !== 'string' || /[\\?#\s]/.test(uri)) return null;
  const parts = /^https:\/\/([^/]+)\/(.+)$/i.exec(uri);
  if (!parts || parts[1].includes('@') || !localTextResource(parts[2])) return null;
  try {
    const url = new URL(uri);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function taskIntegrity(value) {
  return typeof value === 'string' && value.startsWith('sha256-') && validIntegrity(value);
}
