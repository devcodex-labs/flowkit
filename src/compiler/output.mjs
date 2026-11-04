import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const writers = new Map();

/** Windows may reject overlapping replacements; serialize the same resolved output pair in this process. */
export function writeArtifacts(entries) {
  const target = path.resolve(entries[0][0]);
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const publish = () => replaceArtifacts(entries);
  const current = (writers.get(key) ?? Promise.resolve()).then(publish, publish);
  writers.set(key, current);
  const release = () => { if (writers.get(key) === current) writers.delete(key); };
  current.then(release, release);
  return current;
}

/** Prepare every file before replacing any target; each rename is atomic, the pair is not a transaction. */
async function replaceArtifacts(entries) {
  const pending = new Set();
  let primary;
  try {
    const prepared = [];
    for (const [target, text] of entries) {
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx');
      pending.add(temporary);
      let failure;
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      catch (error) { failure = { error }; }
      try { await handle.close(); }
      catch (error) { failure ??= { error }; }
      if (failure) throw failure.error;
      prepared.push([temporary, target]);
    }
    for (const [temporary, target] of prepared) {
      await rename(temporary, target);
      pending.delete(temporary);
    }
  } catch (error) { primary = { error }; }
  for (const temporary of pending) {
    try { await unlink(temporary); }
    catch (error) { if (error.code !== 'ENOENT') primary ??= { error }; }
  }
  if (primary) throw primary.error;
}
