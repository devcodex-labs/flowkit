import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Parser } from 'tar';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyRegistryBytes(bytes, metadata, manifest) {
  assert.equal(metadata.name, '@devcodex-labs/flowkit'); assert.equal(metadata.version, manifest.version);
  assert.equal(manifest.name, metadata.name); assert.equal(sha256(bytes), manifest.sha256, 'Public tarball differs from reviewed candidate');
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(metadata.dist?.integrity ?? '');
  assert.ok(match, 'Missing supported registry dist.integrity');
  assert.equal(createHash(match[1]).update(bytes).digest('base64'), match[2], 'Registry integrity mismatch');
}
export async function archiveFiles(bytes) {
  assert.ok(bytes.length <= 4 * 1024 * 1024, 'Archive too large');
  const raw = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const files = new Map(), errors = [];
  await new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true }); parser.on('error', reject); parser.on('end', resolve);
    parser.on('ignoredEntry', item => errors.push(`Ignored archive member ${item.path}`));
    parser.on('entry', entry => {
      const name = entry.path.startsWith('package/') ? entry.path.slice(8) : '';
      if (!name || entry.type !== 'File' || path.posix.isAbsolute(name) || /[\\\0]/.test(name) || name.split('/').some(x => !x || x === '..' || x === '.') || files.has(name)) {
        errors.push(`Invalid archive member ${entry.path}`); entry.resume(); return;
      }
      const chunks = []; files.set(name, null); entry.on('data', chunk => chunks.push(chunk)); entry.on('end', () => files.set(name, Buffer.concat(chunks))); entry.resume();
    }); parser.end(raw);
  });
  assert.equal(errors.length, 0, errors.join('\n')); assert.ok(files.has('package.json')); return files;
}
export async function verifyInstalledArchive(installed, bytes) {
  const expected = await archiveFiles(bytes);
  async function list(dir, prefix = '') {
    const result = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === 'node_modules') continue;
      assert.ok(!entry.isSymbolicLink(), `Installed link ${entry.name}`);
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) result.push(...await list(path.join(dir, entry.name), name));
      else { assert.ok(entry.isFile()); result.push(name); }
    } return result;
  }
  assert.deepEqual((await list(installed)).sort(), [...expected.keys()].sort(), 'Installed package file set differs');
  for (const [file, content] of expected) assert.equal(sha256(await readFile(path.join(installed, file))), sha256(content), `Installed bytes differ: ${file}`);
  return { files: expected.size, sha256: sha256(bytes) };
}
