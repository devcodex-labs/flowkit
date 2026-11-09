import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from '../validation-process.mjs';
import { verifyRegistryBytes, archiveFiles, sha256 } from './package-proof.mjs';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) { const key = process.argv[i]; assert.ok(['--version', '--manifest', '--evidence'].includes(key) && process.argv[i + 1] && !args[key]); args[key] = process.argv[i + 1]; }
assert.ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args['--version'] ?? '')); assert.ok(args['--manifest']); assert.ok(process.env.npm_execpath, 'Use npm run docs:private-package');
const manifest = JSON.parse(await readFile(args['--manifest'], 'utf8')); assert.equal(manifest.version, args['--version']);
const base = await realpath(tmpdir()), temporary = await mkdtemp(path.join(base, 'flowkit-private-'));
let evidence;
async function npm(parameters) { const r = await runProcess(process.execPath, [process.env.npm_execpath, ...parameters, '--registry=https://npm.pkg.github.com/', '--cache', path.join(temporary, 'cache')], { cwd: temporary, timeout: 120000, maxBuffer: 2 * 1024 * 1024 }); if (r.error) throw r.error; return r; }
try {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Private package verification requires NODE_AUTH_TOKEN');
  const spec = `@devcodex-labs/flowkit@${args['--version']}`;
  let metadata;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await npm(['view', spec, '--json', '--prefer-online']);
    if (r.status === 0) { metadata = JSON.parse(r.stdout); break; }
    if (!/E404/.test(r.stderr + r.stdout) || attempt === 5) throw new Error(`Exact private package version unavailable: ${r.stderr || r.stdout}`);
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  const packed = await npm(['pack', spec, '--json', '--ignore-scripts', '--pack-destination', temporary]); assert.equal(packed.status, 0, packed.stderr);
  const info = JSON.parse(packed.stdout); assert.equal(info.length, 1); assert.equal(info[0].filename, manifest.filename);
  const bytes = await readFile(path.join(temporary, info[0].filename)); verifyRegistryBytes(bytes, metadata, manifest);
  const archive = await archiveFiles(bytes), pkg = JSON.parse(archive.get('package.json').toString('utf8'));
  assert.equal(pkg.name, metadata.name); assert.equal(pkg.version, metadata.version);
  evidence = { passed: true, node: process.version, platform: process.platform, version: pkg.version, registry: 'https://npm.pkg.github.com/', integrity: metadata.dist.integrity, tarballSha256: sha256(bytes), manifestSha256: sha256(await readFile(args['--manifest'])) };
} catch (error) { evidence = { passed: false, error: error.message }; process.exitCode = 1; }
finally {
  assert.equal(path.dirname(temporary), base); assert.ok(path.basename(temporary).startsWith('flowkit-private-')); await rm(temporary, { recursive: true, force: true });
  if (args['--evidence']) { await mkdir(path.dirname(path.resolve(args['--evidence'])), { recursive: true }); await writeFile(args['--evidence'], JSON.stringify(evidence, null, 2) + '\n'); }
  console.log(JSON.stringify(evidence));
}
