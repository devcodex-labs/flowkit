import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../validation-process.mjs';
import { verifyInstalledArchive } from './package-proof.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert.ok(['--package', '--registry-version', '--manifest', '--evidence', '--case'].includes(key) && process.argv[i + 1], `Invalid argument: ${key}`);
  assert.ok(!Object.hasOwn(options, key), `Duplicate: ${key}`); options[key] = process.argv[i + 1];
}
assert.ok(!(options['--package'] && options['--registry-version']), 'Select one package source');
if (!options['--evidence'] && process.env.FLOWKIT_DOCS_EVIDENCE) options['--evidence'] = process.env.FLOWKIT_DOCS_EVIDENCE;
const npm = process.env.npm_execpath; assert.ok(npm, 'Use npm run docs:examples');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'examples/docs/manifest.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
const temporaryBase = await realpath(tmpdir());
const temporary = await mkdtemp(path.join(temporaryBase, 'flowkit-docs-'));
const records = []; let evidence;
async function execute(name, args, cwd, expected = 0) {
  const result = await runProcess(process.execPath, args, { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  records.push({ name, args, cwd, expected, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message });
  assert.equal(result.error, undefined, name); assert.equal(result.status, expected, `${name}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  let source = options['--package'] ? path.resolve(options['--package']) : undefined;
  let tarball;
  if (options['--registry-version']) {
    assert.equal(options['--registry-version'], pkg.version, 'Private consumer version must match docs');
    source = `@devcodex-labs/flowkit@${pkg.version}`;
    const packed = JSON.parse(await execute('private-pack', [npm, 'pack', source, '--json', '--ignore-scripts', '--registry=https://npm.pkg.github.com/', '--cache', path.join(temporary, 'pack-cache'), '--pack-destination', temporary], temporary));
    tarball = path.join(temporary, packed[0].filename);
  } else if (!source) {
    const packed = JSON.parse(await execute('candidate-pack', [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
    assert.equal(packed.length, 1); source = tarball = path.join(temporary, packed[0].filename);
  } else tarball = source;
  if (options['--manifest']) {
    const expected = JSON.parse(await readFile(path.resolve(options['--manifest']), 'utf8'));
    assert.equal(expected.version, pkg.version); assert.equal(expected.name, pkg.name);
    assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), expected.sha256, 'Consumer package differs from approved release manifest');
  }
  const consumer = path.join(temporary, 'consumer'); await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execute('install', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org/', '--cache', path.join(temporary, 'install-cache'), source, 'typescript@5.0.4', '@types/node@22.13.0'], consumer);
  const installed = path.join(consumer, 'node_modules/@devcodex-labs/flowkit');
  assert.ok(!(await lstat(installed)).isSymbolicLink()); assert.equal(path.resolve(await realpath(installed)), path.resolve(installed));
  const actual = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(actual.name, pkg.name); assert.equal(actual.version, pkg.version);
  const installedProof = await verifyInstalledArchive(installed, await readFile(tarball));
  const selected = manifest.cases.filter(item => !options['--case'] || item.id === options['--case']);
  assert.ok(selected.length, 'Unknown or empty case selection');
  for (const item of selected) {
    assert.match(item.directory, /^[a-z][a-z-]*$/);
    const directory = path.join(consumer, item.directory); await mkdir(directory);
    for (const file of item.files) {
      assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'));
      const destination = path.join(directory, file); await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, 'examples/docs', item.directory, file), destination);
    }
    const flags = item.cliOptions ?? [];
    for (const file of item.workflows) {
      assert.match(file, /\.workflow\.(js|ts)$/);
      await execute(`${item.id}:compile:${file}`, [npm, 'exec', '--no', '--', 'flowkit', 'compile', file, ...flags], directory);
      await execute(`${item.id}:check:${file}`, [npm, 'exec', '--no', '--', 'flowkit', 'check', file, ...flags], directory);
      const artifact = file.replace(/\.workflow\.(js|ts)$/, '.compiled.mjs');
      assert.ok((await readFile(path.join(directory, artifact), 'utf8')).includes(pkg.version));
      assert.ok((await readFile(path.join(directory, file.replace(/\.workflow\.(js|ts)$/, '.mmd')), 'utf8')).length > 0);
    }
    for (const scenario of item.scenarios) {
      const output = await execute(`${item.id}:${scenario.entry}:${(scenario.args ?? []).join(',')}`, [scenario.entry, ...(scenario.args ?? [])], directory, scenario.exitCode ?? 0);
      if (scenario.expected !== undefined) assert.deepEqual(JSON.parse(output), scenario.expected);
      if (scenario.contains) assert.ok(output.includes(scenario.contains));
    }
    if (item.verify) await execute(`${item.id}:boundaries`, [item.verify], directory);
    if (item.id === 'E08') {
      // A sibling of the consumer cannot resolve its node_modules or source files.
      const deployment = path.join(temporary, 'deployment'); await mkdir(path.join(deployment, 'skills'), { recursive: true });
      for (const file of ['package.json', 'host.mjs', 'sample.workflow.js', 'sample.compiled.mjs', 'sample.mmd', 'skills/writer.md']) await copyFile(path.join(directory, 'deployment', file), path.join(deployment, file));
      await execute('E08:independent-install', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org/', '--cache', path.join(temporary, 'deployment-cache'), source], deployment);
      const deployedPackage = path.join(deployment, 'node_modules/@devcodex-labs/flowkit');
      assert.ok(!(await lstat(deployedPackage)).isSymbolicLink()); await verifyInstalledArchive(deployedPackage, await readFile(tarball));
      await execute('E08:independent-run', ['host.mjs'], deployment);
      const deployedSource = path.join(deployment, 'sample.workflow.js');
      const changed = await readFile(deployedSource, 'utf8') + '\n// deployment edit\n'; await writeFile(deployedSource, changed);
      await execute('E08:independent-stale-source', ['host.mjs'], deployment, 1);
      assert.ok(records.at(-1).stderr.includes('FK_R001'));
      await execute('E08:independent-recompile', [npm, 'exec', '--no', '--', 'flowkit', 'compile', 'sample.workflow.js'], deployment);
      await execute('E08:independent-check', [npm, 'exec', '--no', '--', 'flowkit', 'check', 'sample.workflow.js'], deployment);
      await execute('E08:independent-recovered', ['host.mjs'], deployment);
      await rm(deployedSource);
      await execute('E08:independent-missing-source', ['host.mjs'], deployment, 1);
      assert.ok(records.at(-1).stderr.includes('FK_R001'));
      await writeFile(deployedSource, changed); await execute('E08:independent-restored', ['host.mjs'], deployment);
    }
    if (item.types) await execute(`${item.id}:types`, [path.join(consumer, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', ...item.types], directory);
  }
  evidence = { schemaVersion: 'FlowkitDocsConsumerV1', passed: true, node: process.version, platform: process.platform, source, version: actual.version, tarballSha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), installedCopy: true, installedProof, cases: selected.map(item => item.id), records };
} catch (error) {
  evidence = { schemaVersion: 'FlowkitDocsConsumerV1', passed: false, node: process.version, platform: process.platform, error: error.message, records };
  process.exitCode = 1;
} finally {
  assert.equal(path.dirname(temporary), temporaryBase); assert.ok(path.basename(temporary).startsWith('flowkit-docs-'));
  await rm(temporary, { recursive: true, force: true }); evidence.temporaryCleanup = true;
  if (options['--evidence']) { const destination = path.resolve(options['--evidence']); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n'); }
  console.log(JSON.stringify(evidence));
}
