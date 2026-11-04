import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { localSkillPath, remoteReference, remoteSkillURL, allowedSkillHost, validIntegrity, validAgentPath } from '../shared/skill-ref.mjs';
import { readRemoteSkill, skillError } from './skill-remote.mjs';

const contained = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Private per-execution loader. No content or pending promise is shared across runs. */
export function createSkillLoader(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const skillsRoot = options.skillsRoot ?? 'skills';
  const hosts = [...(options.remoteSkillHosts ?? [])];
  const local = new Map(), remote = new Map();
  let canonicalRoot;
  const remember = (map, key, read) => {
    if (!map.has(key)) {
      const pending = Promise.resolve().then(read).catch(error => { map.delete(key); throw error; });
      map.set(key, pending);
    }
    return map.get(key);
  };
  async function readLocal(reference) {
    let bytes;
    try {
      canonicalRoot ??= realpath(projectRoot).catch(error => { canonicalRoot = undefined; throw error; });
      const root = await canonicalRoot;
      const target = await realpath(path.resolve(projectRoot, reference));
      if (!contained(root, target)) throw skillError('FK_R011', 'Skill escapes project root');
      bytes = await readFile(target);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw skillError('FK_R010', 'Local Skill is missing', error);
      throw error;
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (cause) { throw skillError('FK_R014', 'Skill is not valid UTF-8', cause); }
  }
  function loadSkill(reference, supplied) {
    try {
      if (supplied !== undefined && (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied))) throw skillError('FK_R011', 'Invalid Skill integrity options');
      const hasIntegrity = supplied !== undefined && Object.hasOwn(supplied, 'integrity');
      const integrity = hasIntegrity ? supplied.integrity : undefined;
      if (remoteReference(reference)) {
        let parsed;
        try { parsed = new URL(reference); } catch { throw skillError('FK_R011', 'Invalid Skill URL'); }
        if (parsed.protocol !== 'https:') throw skillError('FK_R012', 'Skill must use HTTPS');
        const url = remoteSkillURL(reference);
        if (!url || hasIntegrity && !validIntegrity(integrity)) throw skillError('FK_R011', 'Invalid Skill reference or integrity');
        if (!allowedSkillHost(url, hosts)) throw skillError('FK_R012', 'Remote Skill host is not allowed');
        return remember(remote, JSON.stringify([url.href, hasIntegrity ? integrity : null]), () => readRemoteSkill(url, integrity, options));
      }
      if (!localSkillPath(reference) || hasIntegrity) throw skillError('FK_R011', 'Invalid local Skill reference or integrity');
      // The canonical root is fixed within this loader; distinct legal aliases keep distinct keys.
      return remember(local, reference, () => readLocal(reference));
    } catch (error) { return Promise.reject(error); }
  }
  function loadSkillByAgent(agent) {
    if (!validAgentPath(agent)) return Promise.reject(skillError('FK_R011', 'Invalid agent Skill path'));
    if (remoteReference(skillsRoot) && !path.isAbsolute(skillsRoot)) return loadSkill(`${skillsRoot.replace(/\/$/, '')}/${agent}.md`);
    const target = path.resolve(projectRoot, skillsRoot, `${agent}.md`);
    const reference = path.relative(projectRoot, target).split(path.sep).join('/');
    // Host root paths may contain characters forbidden in explicit DSL references.
    return remember(local, reference, () => readLocal(reference));
  }
  return { loadSkill, loadSkillByAgent };
}
