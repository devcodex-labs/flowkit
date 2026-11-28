import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { allowedSkillHost } from '../shared/skill-ref.mjs';
import { localTextResource, remoteTextResource, taskIntegrity } from '../shared/task-spec.mjs';
import { readRemoteSkill, skillError } from './skill-remote.mjs';

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function readRegularResource(target, limit, signal, root) {
  signal?.throwIfAborted();
  const parents = [];
  if (root) {
    if (target === root || !contained(root, target)) throw skillError('FK_R011', 'Resource escapes its authorized root');
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      const stat = await lstat(parent, { bigint: true });
      if (!stat.isDirectory() || await realpath(parent) !== parent) throw skillError('FK_R011', 'Resource parent is not an authorized directory');
      parents.push([parent, stat]);
      if (parent === root) break;
    }
  }
  async function checkParents() {
    for (const [parent, prior] of parents) {
      const now = await lstat(parent, { bigint: true });
      if (!now.isDirectory() || now.dev !== prior.dev || now.ino !== prior.ino ||
          now.birthtimeNs !== prior.birthtimeNs || await realpath(parent) !== parent) {
        throw skillError('FK_R011', 'Resource parent changed during reading');
      }
    }
  }
  const expected = await lstat(target, { bigint: true });
  if (!expected.isFile()) throw skillError('FK_R011', 'Resource is not a regular file');
  const file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat({ bigint: true });
    // Windows can omit the volume serial in the path stat while providing it on the open handle.
    const sameDevice = stat.dev === expected.dev ||
      (process.platform === 'win32' && expected.dev === 0n && stat.birthtimeNs === expected.birthtimeNs);
    if (!stat.isFile() || !sameDevice || stat.ino !== expected.ino) {
      throw skillError('FK_R011', 'Resource changed before it could be read');
    }
    if (root && process.platform === 'linux') {
      const opened = await realpath('/proc/self/fd/' + file.fd);
      if (opened !== target) throw skillError('FK_R011', 'Opened resource differs from the authorized path');
    }
    await checkParents();
    if (stat.size > limit) throw skillError('FK_R014', `Resource exceeds ${limit} bytes`);
    const chunks = [];
    let received = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit - received + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      received += bytesRead;
      if (received > limit) throw skillError('FK_R014', `Resource exceeds ${limit} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    if (root) {
      const after = await file.stat({ bigint: true });
      const current = await lstat(target, { bigint: true });
      if (current.ino !== expected.ino || current.dev !== expected.dev || !current.isFile() ||
          after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
        throw skillError('FK_R011', 'Resource changed during reading');
      }
      await checkParents();
    }
    return Buffer.concat(chunks, received);
  } finally {
    await file.close();
  }
}

async function readLocal(uri, projectRoot, limit, signal) {
  if (typeof projectRoot !== 'string' || !projectRoot || !localTextResource(uri)) {
    throw skillError('FK_R011', 'Description resource requires an authorized root and relative text path');
  }
  const root = await realpath(projectRoot);
  const target = await realpath(path.resolve(root, uri));
  if (!contained(root, target)) throw skillError('FK_R011', 'Description resource escapes the authorized root');
  return readRegularResource(target, limit, signal);
}

async function readRemote(ref, url, policy, options, budget, limit, signal) {
  const authorize = async (target, readSignal) => {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname) || !allowedSkillHost(target, options.remoteSkillHosts ?? []) ||
        typeof policy.authorizeRemote !== 'function' ||
        !await policy.authorizeRemote(target.href, readSignal)) {
      throw skillError('FK_R012', 'Description resource origin is not authorized');
    }
  };
  if (typeof policy.fetch !== 'function') {
    throw skillError('FK_R012', 'Remote description requires a host transport enforcing destination policy');
  }
  if (!ref.integrity && !await policy.isImmutableResource?.(url.href)) {
    throw skillError('FK_R013', 'Remote description requires a digest or a host-verified immutable reference');
  }
  return readRemoteSkill(url, ref.integrity, { fetch: policy.fetch, signal }, {
    maxBytes: limit, timeoutMs: Math.max(1, Math.min(10000, (budget.deadlineMs ?? Infinity) - Date.now())), authorize,
    parseRemote: remoteTextResource, validLocal: localTextResource, textOnly: true, rawBytes: true
  });
}

/** Resolve authorized descriptions once per activation; bind exact identities and declared role order. */
export async function createDescriptionResources(refs, policy, options, budget, signal) {
  const resources = [];
  let total = 0;
  for (const ref of refs) {
    budget.check();
    const limit = Math.min(budget.maxResourceBytes, budget.maxTotalResourceBytes - total);
    if (limit <= 0) throw skillError('FK_R014', 'Total description resource budget exhausted');
    if (ref.integrity !== undefined && !taskIntegrity(ref.integrity)) {
      throw skillError('FK_R013', 'Description integrity is not a sha256 digest');
    }
    const url = remoteTextResource(ref.uri);
    const bytes = url ? await readRemote(ref, url, policy, options, budget, limit, signal) :
      await readLocal(ref.uri, policy.projectRoot, limit, signal);
    budget.check();
    total += bytes.length;
    const digest = createHash('sha256').update(bytes).digest();
    if (ref.integrity && !digest.equals(Buffer.from(ref.integrity.slice('sha256-'.length), 'base64'))) {
      throw skillError('FK_R013', `Description resource digest differs: ${ref.uri}`);
    }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (cause) { throw skillError('FK_R014', `Description resource is not valid UTF-8: ${ref.uri}`, cause); }
    const role = ref.role ?? 'reference';
    if (role === 'instruction' && !content.trim()) throw skillError('FK_R014', 'Required instruction resource is empty');
    resources.push(Object.freeze({ uri: ref.uri, role, content, byteLength: bytes.length, digest: `sha256:${digest.toString('hex')}` }));
  }
  return Object.freeze(resources);
}
