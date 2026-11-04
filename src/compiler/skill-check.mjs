import path from 'node:path';
import { stat } from 'node:fs/promises';
import { diagnostic } from './source.mjs';

const localPath = value => typeof value === 'string' && value.endsWith('.md') &&
  value.split('/').every(segment => segment.length > 0 && !/[^A-Za-z0-9_.-]/.test(segment) && segment !== '.' && segment !== '..');

/** Inspect raw segments before URL parsing can normalize dot segments or backslashes. */
function remoteURL(value) {
  if (typeof value !== 'string' || /[\\?#\s]/.test(value)) return null;
  const match = /^https:\/\/([^/]+)\/(.+)$/i.exec(value);
  if (!match || match[1].includes('@') || !localPath(match[2])) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

/** Accept a single canonical digest, with correct terminal padding or no padding. */
export function validIntegrity(value) {
  if (typeof value !== 'string') return false;
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0] !== value) return false;
  const bytes = Buffer.from(match[2], 'base64');
  const canonical = bytes.toString('base64');
  return bytes.length === { sha256: 32, sha384: 48, sha512: 64 }[match[1]] &&
    (match[2] === canonical || match[2] === canonical.replace(/=+$/, ''));
}

/** Static reference checks never fetch or read Skill content. */
export async function checkSkills(literal, context) {
  const diagnostics = [];
  if (!Array.isArray(literal.definition.nodes)) return diagnostics;
  for (const [index, node] of literal.definition.nodes.entries()) {
    const pointer = `/nodes/${index}`;
    if (literal.constructors.get(pointer).kind !== 'node') continue;
    const explicit = Object.hasOwn(node, 'skill');
    const field = explicit ? 'skill' : 'agent';
    const report = (code, message, key = field) => diagnostics.push(diagnostic(context.source, code, message,
      literal.locations.get(`${pointer}/${key}`) ?? literal.locations.get(pointer), node.id));
    const hasIntegrity = Object.hasOwn(node, 'integrity');
    let reference;
    if (explicit) reference = node.skill;
    else if (typeof node.agent === 'string' && node.agent.length) {
      // Validate the agent's raw segments before joining; never normalize away traversal.
      if (!localPath(`${node.agent}.md`)) { report('FK_C052', 'Invalid mapped agent path'); continue; }
      reference = `${context.skillsRoot.replace(/\/$/, '')}/${node.agent}.md`;
    } else {
      if (hasIntegrity) report('FK_C058', 'Integrity requires an explicit HTTPS skill', 'integrity');
      continue;
    }
    const candidate = explicit ? reference : context.skillsRoot;
    const remote = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) &&
      (explicit || !/^[A-Za-z]:[\\/]/.test(candidate));
    if (remote) {
      const url = remoteURL(reference);
      if (!url) report('FK_C052', 'Invalid HTTPS Skill URL');
      else if (!context.remoteSkillHosts.includes(url.host) &&
        !(!url.port && context.remoteSkillHosts.includes(`${url.hostname}:443`))) report('FK_C057', 'Remote Skill host is not allowed');
      if (hasIntegrity) {
        if (!explicit || !url || !validIntegrity(node.integrity)) report('FK_C058', 'Invalid integrity or use location', 'integrity');
      } else if (url) report('FK_C059', 'Remote Skill has no integrity');
    } else {
      if (hasIntegrity) report('FK_C058', 'Integrity requires an explicit HTTPS skill', 'integrity');
      // Absolute local skillsRoot is a host option, unlike a relative DSL skill reference.
      const valid = explicit ? localPath(reference) : localPath(`${node.agent}.md`);
      if (!valid) { report('FK_C052', 'Invalid relative Skill path'); continue; }
      if (context.skillCheck) {
        try {
          const target = explicit ? path.resolve(context.projectRoot, reference)
            : path.resolve(context.projectRoot, context.skillsRoot, `${node.agent}.md`);
          if (!(await stat(target)).isFile()) report('FK_C051', 'Local Skill is not a file');
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) report('FK_C051', 'Local Skill is missing');
          else throw error;
        }
      }
    }
  }
  return diagnostics;
}
