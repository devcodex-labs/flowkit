import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { allowedSkillHost } from '../shared/skill-ref.mjs';
import { localTextResource, remoteTextResource, taskIntegrity } from '../shared/task-spec.mjs';
import { readRemoteSkill, skillError } from './skill-remote.mjs';

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readLocal(uri, projectRoot, limit) {
  if (typeof projectRoot !== 'string' || !projectRoot || !localTextResource(uri)) {
    throw skillError('FK_R011', 'Description resource requires an authorized root and relative text path');
  }
  const root = await realpath(projectRoot);
  const target = await realpath(path.resolve(root, uri));
  if (!contained(root, target)) throw skillError('FK_R011', 'Description resource escapes the authorized root');
  const file = await open(target, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw skillError('FK_R011', 'Description resource is not a regular file');
    if (stat.size > limit) throw skillError('FK_R014', `Description resource ${uri} has ${stat.size} bytes, maximum ${limit}`);
    const chunks = [];
    let received = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit - received + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      received += bytesRead;
      if (received > limit) throw skillError('FK_R014', `Description resource ${uri} exceeds ${limit} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, received);
  } finally {
    await file.close();
  }
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
    maxBytes: limit, timeoutMs: Math.max(1, Math.min(10000, budget.deadlineMs - Date.now())), authorize,
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
      await readLocal(ref.uri, policy.projectRoot, limit);
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
