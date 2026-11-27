import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const writers = new Map();
const outputAdmissions = new Map();

/** Bind compilation output to its resolved directory and refuse a different source's existing artifact. */
export function writeArtifacts(entries, paths) {
  return serializeOutput(entries[0][0], () => writeMappedArtifacts(entries, paths), outputAdmissions);
}

async function writeMappedArtifacts(entries, { outDir, source }) {
  await mkdir(outDir, { recursive: true });
  const root = await realpath(outDir);
  const relative = path.relative(outDir, path.dirname(entries[0][0]));
  let directory = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    const child = path.join(directory, segment);
    await mkdir(child).catch(error => { if (error.code !== 'EEXIST') throw error; });
    directory = await realpath(child);
    const inside = path.relative(root, directory);
    if (path.isAbsolute(inside) || inside === '..' || inside.startsWith('..' + path.sep)) {
      throw new TypeError('Compilation output escapes outDir');
    }
  }
  const outputs = entries.map(([name, content]) => [path.join(directory, path.basename(name)), content]);
  const target = outputs[0][0];
  return serializeOutput(target, async () => {
    const lock = target + '.flowkit-write-lock';
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Compilation output lock is still held: ' + lock +
            '. Confirm that no compiler owns it before removing an abandoned lock.', { cause: error }), { code: error.code });
        }
        await delay(20);
      }
    }
    let failed = false;
    try {
      const stat = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat) {
        if (!stat.isFile()) throw Object.assign(new TypeError('Compilation output is not a regular file'),
          { code: stat.isDirectory() ? 'EISDIR' : 'EEXIST' });
        const file = await open(target, 'r');
        try {
          const buffer = Buffer.alloc(4096);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const header = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 3);
          if (header[2] !== '// source: ' + source) throw new TypeError('Compilation output belongs to a different source');
        } finally { await file.close(); }
      }
      return await replaceArtifacts(outputs);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await rmdir(lock).catch(error => { if (!failed) throw error; });
    }
  });
}

/** Share the complete inspect/replace critical section with dump writers. */
export function serializeOutput(filename, publish, slots = writers) {
  const target = path.resolve(filename);
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const current = (slots.get(key) ?? Promise.resolve()).then(publish, publish);
  slots.set(key, current);
  const release = () => { if (slots.get(key) === current) slots.delete(key); };
  current.then(release, release);
  return current;
}

/** Prepare every file before replacing any target; each rename is atomic, the pair is not a transaction. */
export async function replaceArtifacts(entries) {
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
