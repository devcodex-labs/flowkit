/** Check raw segments before URL parsing can erase traversal or backslashes. */
export const localSkillPath = value => typeof value === 'string' && value.endsWith('.md') &&
  value.split('/').every(segment => segment.length > 0 && !/[^A-Za-z0-9_.-]/.test(segment) && segment !== '.' && segment !== '..');

export const remoteReference = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
export const validAgentPath = value => typeof value === 'string' && value.length > 0 && localSkillPath(`${value}/_.md`);

export function remoteSkillURL(value) {
  if (typeof value !== 'string' || /[\\?#\s]/.test(value)) return null;
  const match = /^https:\/\/([^/]+)\/(.+)$/i.exec(value);
  if (!match || match[1].includes('@') || !localSkillPath(match[2])) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

/** A host without an explicit port authorizes only HTTPS port 443. */
export function normalizeHost(value) {
  if (typeof value !== 'string' || !value || /[\s/@?#\\]/.test(value)) return null;
  try {
    const url = new URL(`https://${value}/`);
    return url.username || url.password || url.pathname !== '/' ? null : url.host;
  } catch { return null; }
}

export const allowedSkillHost = (url, hosts) => hosts.some(host => normalizeHost(host) === url.host);

/** Accept one canonical digest, with correct terminal padding or no padding. */
export function validIntegrity(value) {
  if (typeof value !== 'string') return false;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0] !== value) return false;
  const bytes = Buffer.from(match[2], 'base64');
  const canonical = bytes.toString('base64');
  return bytes.length === { sha256: 32, sha384: 48, sha512: 64 }[match[1]] &&
    (match[2] === canonical || match[2] === canonical.replace(/=+$/, ''));
}
