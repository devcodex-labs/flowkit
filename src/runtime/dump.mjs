import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { serializeOutput, replaceArtifacts } from '../compiler/output.mjs';
import { verifyWorkflowFunction, workflowFunctionText } from './load.mjs';
import { dumpChannel } from './dump-channel.mjs';

const attempts = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashPrefixCollision = (existing, expected) => existing !== expected && existing.slice(0, 12) === expected.slice(0, 12);

async function prepareDump(target, code, digest) {
  return serializeOutput(target, async () => {
    let previous;
    try { previous = await readFile(target); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (previous?.equals(Buffer.from(code))) return;
    if (previous && hashPrefixCollision(hash(previous), digest)) throw Object.assign(new Error('Dump hash prefix collision'), { code: 'EEXIST', path: target });
    await replaceArtifacts([[target, code]]);
  });
}

/** Publish and import the exact pinned file text, retaining a retry URL only after loading failed. */
export async function loadDumpWorkflow(code, filename, directory) {
  workflowFunctionText(code);
  const digest = hash(code);
  const name = path.basename(filename).replace(/(?:\.workflow\.(?:ts|js)|\.compiled\.mjs)$/, '');
  const target = path.join(directory, `${name}.${digest.slice(0, 12)}.run.mjs`);
  await prepareDump(target, code, digest);
  const base = pathToFileURL(target); base.searchParams.set('flowkit-verified', digest);
  const attempt = attempts.get(base.href) ?? 0;
  const url = new URL(base);
  if (attempt) url.searchParams.set('attempt', String(attempt));
  const channel = dumpChannel(), token = randomUUID();
  let pinned = false, workflow, failure;
  try {
    await channel.send({ op: 'pin', url: url.href, source: code, token }); pinned = true;
    workflow = verifyWorkflowFunction(await import(url.href), code);
  } catch (error) { failure = { error }; }
  finally {
    if (pinned) { try { await channel.send({ op: 'unpin', url: url.href, token }); } catch (error) { failure ??= { error }; } }
  }
  if (failure) {
    if ((attempts.get(base.href) ?? 0) === attempt) attempts.set(base.href, attempt + 1);
    throw failure.error;
  }
  return workflow;
}
