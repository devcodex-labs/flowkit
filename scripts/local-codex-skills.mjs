import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { artifactDigest, professionalSkillFileHashes } from '../src/shared/artifact-identity.mjs';
import { validateSkillName } from '../src/author/skill-document.mjs';
import { readRegularResource } from '../src/runtime/task-resources.mjs';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const optionalStat = file => lstat(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const nativeSource = file => 'codex-skill:' + artifactDigest(file).slice(7);

/** Ask a separate Codex App Server for its native catalog, without waiting on the calling agent. */
function codexSkills(workspace, signal) {
  const timeout = AbortSignal.timeout(15000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  effectiveSignal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: effectiveSignal
    });
    let result, failure;
    const stop = error => {
      failure ??= error;
      child.stdin.end();
      if (error) child.kill();
    };
    const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    child.stderr.resume();
    child.stdin.on('error', error => { if (!result) stop(error); });
    child.on('error', error => { failure ??= error; });
    createInterface({ input: child.stdout }).on('line', line => {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024) return stop(new Error('Codex Skill catalog exceeds the local read budget'));
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.id) return;
      if (message.error) return stop(new Error('Codex Skill catalog is unavailable'));
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'skills/list', params: { cwds: [workspace], forceReload: true } });
      } else if (message.id === 2) {
        result = message.result?.data?.[0];
        stop();
      }
    });
    child.once('close', code => {
      if (failure || !result || code || effectiveSignal.aborted) {
        reject(failure ?? effectiveSignal.reason ?? new Error('Codex Skill catalog closed without a result'));
      } else resolve(result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'flowkit-local', version: '1' } } });
  });
}

async function nativeCandidate(entry, file, collection, signal) {
  const directory = path.dirname(file);
  const files = {};
  let total = 0;
  async function add(relative) {
    const candidate = path.join(directory, relative);
    const limit = Math.min(262144, 1048576 - total);
    if (Object.keys(files).length >= 64 || limit < 1) {
      throw new Error('Codex Skill files are not within the portable text resource budget');
    }
    const bytes = await readRegularResource(candidate, limit, signal, directory);
    total += bytes.length;
    files[relative] = text.decode(bytes);
  }
  async function walk(relative) {
    const root = path.join(directory, relative);
    const stat = await optionalStat(root);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('Codex Skill resources contain an unowned link');
    }
    for (const member of await readdir(root, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(member.name) || member.isSymbolicLink()) {
        throw new Error('Codex Skill resources contain an unsupported name or link');
      }
      const child = relative + '/' + member.name;
      if (member.isDirectory()) await walk(child);
      else await add(child);
    }
  }
  validateSkillName(entry.name);
  await add('SKILL.md');
  for (const folder of ['references', 'scripts', 'assets']) await walk(folder);
  const fileHashes = professionalSkillFileHashes(files);
  const digest = artifactDigest(JSON.stringify(fileHashes));
  const manifest = { kind: 'professional', format: 'codex-native', collectionId: collection.id, skillId: entry.name,
    name: entry.name, version: '0.0.0+' + digest.slice(7, 23), description: entry.description, files: fileHashes, digest };
  return { files, manifest, hash: artifactDigest(JSON.stringify(manifest)) };
}

/** Adapt the authority of one explicitly authorized workspace to the existing publication and Skill ports. */
export async function createLocalCodexSkills({ workspace, root, collection, get, put, readManaged, readCatalog = codexSkills }) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw new TypeError('codexSkillsWorkspace must be an absolute directory');
  const cwd = await realpath(workspace);
  const agents = path.join(cwd, '.agents');
  const skills = path.join(agents, 'skills');
  for (const directory of [agents, skills]) {
    const stat = await optionalStat(directory);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Codex Skill root must be a workspace-owned directory');
  }
  await mkdir(skills, { recursive: true });
  if (!inside(cwd, await realpath(skills))) throw new Error('Codex Skills directory is outside its authorized workspace');
  await mkdir(root, { recursive: true });
  root = await realpath(root);
  const name = 'flowkit-' + artifactDigest(collection.id).slice(7, 27);
  const active = path.join(skills, name);
  const backup = path.join(path.dirname(skills), name + '.previous');
  const receiptKey = target => 'codex-skill-generation:' + artifactDigest(target);
  const sourceKey = source => 'codex-skill-source:' + source;
  let mappingWork = Promise.resolve();
  function withMapping(operation) {
    const next = mappingWork.then(operation);
    mappingWork = next.catch(() => {});
    return next;
  }
  async function readLink(link) {
    const stat = await optionalStat(link);
    if (!stat) return;
    if (!stat.isSymbolicLink()) throw new Error('Refusing to replace an existing Codex Skill directory');
    const target = await realpath(link);
    const receipt = get(receiptKey(target));
    if (!receipt || !inside(root, target)) throw new Error('Codex Skill mapping is not owned by this service');
    return { target, receipt };
  }
  async function mapped() {
    const current = await readLink(active);
    if (current) return current;
    const previous = await readLink(backup);
    if (previous) await rename(backup, active);
    return previous;
  }

  function allowedEntry(entry) {
    return entry.scope === 'repo' && typeof entry.path === 'string' && path.isAbsolute(entry.path) &&
      path.basename(entry.path).toLowerCase() === 'skill.md' && typeof entry.name === 'string' &&
      (inside(cwd, entry.path) || inside(root, entry.path));
  }

  async function managedSkill(entry, file, mapping) {
    if (!mapping || path.dirname(path.dirname(file)) !== path.join(mapping.target, 'skills')) return null;
    const stored = readManaged?.(mapping.receipt, path.basename(path.dirname(file)));
    if (!stored || stored.manifest.kind !== 'professional' || entry.name !== stored.manifest.name) return null;
    return stored;
  }

  async function resolveExact(pin, { signal } = {}) {
    if (!pin.source?.startsWith('codex-skill:')) return { status: 'unavailable' };
    try {
      const page = await readCatalog(cwd, signal);
      const remembered = get?.(sourceKey(pin.source));
      for (const entry of page.skills ?? []) {
        if (!allowedEntry(entry) || entry.name !== pin.id) continue;
        const catalogPath = path.resolve(entry.path);
        const sameCatalogPath = nativeSource(catalogPath) === pin.source || catalogPath === remembered?.catalogPath;
        let file;
        try { file = await realpath(entry.path); }
        catch (error) {
          if (sameCatalogPath && (error.code !== 'ENOENT' || entry.enabled === false)) {
            return { status: 'denied' };
          }
          continue;
        }
        if (nativeSource(file) !== pin.source && !sameCatalogPath) continue;
        if (entry.enabled === false || !inside(cwd, file) || inside(root, file) || nativeSource(file) !== pin.source) {
          return { status: 'denied' };
        }
        const candidate = await nativeCandidate(entry, file, collection, signal);
        if (candidate.manifest.version !== pin.version || candidate.manifest.digest !== pin.digest) return { status: 'denied' };
        put?.(sourceKey(pin.source), { catalogPath, file });
        return { status: 'resolved', value: { candidate, source: pin.source, authorized: true } };
      }
      // Losing catalog authorization is distinct from the installed material disappearing.
      const knownFile = remembered && (await optionalStat(remembered.catalogPath) || await optionalStat(remembered.file));
      return { status: knownFile || page.errors?.length || !Array.isArray(page.skills) ? 'denied' : 'unavailable' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: 'denied' };
    }
  }

  return {
    discovery: {
      root,
      readMapping: () => withMapping(async () => {
        const mapping = await mapped();
        return mapping?.receipt ?? null;
      }),
      observeMapping: ({ mapping, files, signal }) => withMapping(async () => {
        const physical = await mapped();
        if (!physical || JSON.stringify(physical.receipt) !== JSON.stringify(mapping)) return false;
        const page = await readCatalog(cwd, signal);
        if (page.errors?.length || !Array.isArray(page.skills)) return false;
        const observed = new Set();
        for (const entry of page.skills) {
          if (!allowedEntry(entry) || entry.enabled === false) continue;
          const file = await realpath(entry.path).catch(() => null);
          if (file && inside(physical.target, file)) observed.add(file);
        }
        return files.every(file => observed.has(path.join(mapping.discoveryRoot, file)));
      }),
      compareAndSetMapping: ({ expected, next, signal }) => withMapping(async () => {
        signal?.throwIfAborted();
        const current = await mapped();
        if (JSON.stringify(current?.receipt ?? null) !== JSON.stringify(expected)) return false;
        if (await readLink(backup)) await unlink(backup);
        if (!next) {
          if (current) await unlink(active);
          return true;
        }
        const generation = await realpath(next.discoveryRoot);
        const target = await realpath(path.join(generation, collection.directory));
        if (path.dirname(generation) !== root || path.dirname(target) !== generation ||
            !(await lstat(path.join(target, 'SKILL.md'))).isFile()) throw new Error('Codex generation is outside the publication root');
        put(receiptKey(target), next);
        const staged = path.join(path.dirname(skills), name + '.stage-' + randomUUID());
        await symlink(target, staged, process.platform === 'win32' ? 'junction' : 'dir');
        try {
          if (current) await rename(active, backup);
          await rename(staged, active);
          if (current) await unlink(backup);
        } catch (error) {
          await mapped();
          throw error;
        } finally {
          if (await optionalStat(staged)) await unlink(staged);
        }
        return true;
      })
    },
    async search({ id, description, selection, selectCandidates, verifyApplicability, signal }) {
      try {
        const page = await readCatalog(cwd, signal);
        if (page.errors?.length || !Array.isArray(page.skills)) return { complete: false };
        const mapping = await withMapping(mapped);
        const entries = new Map();
        let occupied = false;
        for (const entry of page.skills.filter(allowedEntry)) {
          occupied ||= entry.name === id;
          if (entry.enabled === false) continue;
          if (typeof entry.description !== 'string' || !entry.description.trim()) return { complete: false };
          const file = await realpath(entry.path);
          if (!inside(cwd, file) && !inside(root, file)) continue;
          if (mapping && file === path.join(mapping.target, 'SKILL.md')) continue;
          const stored = inside(root, file) ? await managedSkill(entry, file, mapping) : null;
          if (inside(root, file) && !stored) continue;
          const source = stored ? 'collection:' + collection.id : nativeSource(file);
          const logicalId = stored?.manifest.skillId ?? entry.name;
          occupied ||= logicalId === id;
          entries.set(JSON.stringify([source, logicalId]), { entry, source, file, stored, logicalId });
        }
        if (!entries.size) return { complete: true, occupied, matches: [] };
        const selected = selection && JSON.stringify(JSON.parse(selection).slice(0, 2));
        const exact = [...entries].filter(([, item]) => item.logicalId === id || item.entry.description === description).map(([key]) => key);
        const shortlist = selected && entries.has(selected) ? [selected] :
          entries.size === 1 ? [...entries.keys()] :
            await selectCandidates?.({ id, description }, [...entries].map(([key, { entry, logicalId, source }]) =>
              ({ key, id: logicalId, name: entry.name, description: entry.description, source })));
        if (!Array.isArray(shortlist) && !exact.length) return { complete: false };
        const keys = [...new Set([...(shortlist ?? []), ...exact])];
        if (keys.some(key => !entries.has(key))) return { complete: false };
        const matches = [];
        for (const key of keys) {
          signal?.throwIfAborted();
          const { entry, file, source, stored } = entries.get(key);
          const observed = await nativeCandidate(entry, file, collection, signal);
          if (stored && stored.manifest.digest !== observed.manifest.digest) return { complete: false };
          const candidate = stored ?? observed;
          const applicable = await verifyApplicability({ id, description }, candidate);
          if (typeof applicable !== 'boolean') return { complete: false };
          if (applicable) {
            if (!stored) put?.(sourceKey(source), { catalogPath: path.resolve(entry.path), file });
            matches.push({ candidate, source, approved: true });
          }
        }
        // Metadata shortlists permit positive reuse, but only a complete search proves absence.
        return { complete: matches.length > 0 || keys.length === entries.size, occupied, matches };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { complete: false };
      }
    },
    resolveExact,
    async resolve(pin, scope) { return (await resolveExact(pin, scope)).value ?? null; }
  };
}
