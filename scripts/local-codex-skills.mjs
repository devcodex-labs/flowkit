import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rename, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { artifactDigest, professionalSkillFileHashes } from '../src/shared/artifact-identity.mjs';
import { validateSkillName } from '../src/author/skill-document.mjs';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const optionalStat = file => lstat(file).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxAlternativeBodies = 4;

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

async function nativeCandidate(entry, file, collection) {
  const directory = path.dirname(file);
  const files = {};
  let total = 0;
  async function add(relative) {
    const candidate = path.join(directory, relative);
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(directory, await realpath(candidate)) ||
        stat.size > 262144 || Object.keys(files).length >= 64 || (total += stat.size) > 1048576) {
      throw new Error('Codex Skill files are not within the portable text resource budget');
    }
    const bytes = await readFile(candidate);
    if (bytes.length !== stat.size) throw new Error('Codex Skill changed during reading');
    files[relative] = text.decode(bytes);
  }
  async function walk(relative) {
    const root = path.join(directory, relative);
    const stat = await optionalStat(root);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex Skill resources contain an unowned link');
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

  async function list(signal) {
    const page = await readCatalog(cwd, signal);
    if (page.errors?.length || !Array.isArray(page.skills)) throw new Error('Codex reported an incomplete Skill catalog');
    const entries = [];
    for (const entry of page.skills) {
      if (entry.scope !== 'repo' || !path.isAbsolute(entry.path) || !entry.description) continue;
      const file = await realpath(entry.path);
      if (!inside(cwd, file) && !inside(root, file)) continue;
      const managed = inside(root, file);
      const source = managed ? 'collection:' + collection.id : 'codex-skill:' + artifactDigest(file).slice(7);
      entries.push({ entry, file, source, managed });
    }
    return entries;
  }

  return {
    discovery: {
      root,
      readMapping: ({ signal }) => withMapping(async () => {
        const mapping = await mapped();
        if (!mapping) return null;
        const page = await readCatalog(cwd, signal);
        if (!page.skills?.some(skill => path.resolve(skill.path) === path.join(mapping.target, 'SKILL.md'))) {
          throw new Error('Codex has not observed the active collection mapping');
        }
        return mapping.receipt;
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
    async search({ id, description, verifyApplicability, signal }) {
      try {
        const entries = await list(signal);
        const normalize = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
        const purpose = normalize(description);
        const preferred = [], alternatives = [];
        for (const item of entries) {
          const { entry } = item;
          const group = entry.name === id || normalize(entry.description) === purpose ? preferred : alternatives;
          group.push(item);
        }
        let occupied = false;
        for (const group of [preferred, alternatives]) {
          if (group === alternatives && group.length > maxAlternativeBodies) return { complete: false };
          const matches = [];
          for (const { entry, file, source, managed } of group) {
            signal?.throwIfAborted();
            const stored = managed ? readManaged?.(entry.name) : undefined;
            if (managed && stored?.manifest.kind !== 'professional') continue;
            if (stored && stored.manifest.files['SKILL.md'] !== artifactDigest(await readFile(file))) return { complete: false };
            const candidate = stored ?? await nativeCandidate(entry, file, collection);
            occupied ||= entry.name === id;
            const applicable = await verifyApplicability({ id, description }, candidate);
            if (typeof applicable !== 'boolean') return { complete: false };
            if (applicable) matches.push({ candidate, source, approved: true });
          }
          if (matches.length) return { complete: true, occupied, matches };
        }
        return { complete: true, occupied, matches: [] };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { complete: false };
      }
    },
    async resolve(pin, scope) {
      if (!pin.source?.startsWith('codex-skill:')) return null;
      try {
        const found = (await list(scope?.signal)).find(item => item.source === pin.source && item.entry.name === pin.id);
        if (!found) return null;
        const candidate = await nativeCandidate(found.entry, found.file, collection);
        if (candidate.manifest.version !== pin.version || candidate.manifest.digest !== pin.digest) return null;
        return { candidate, source: found.source, authorized: true };
      } catch (error) {
        if (scope?.signal?.aborted) throw error;
        return null;
      }
    }
  };
}
