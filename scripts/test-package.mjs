import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, realpath, lstat, readdir, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validatePackage } from './check-package.mjs';
import { runProcess } from './validation-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = await realpath(tmpdir()), temporary = await mkdtemp(path.join(base, 'flowkit-consumer-'));
const records = [];
async function execute(name, args, cwd, expected = 0, executable = process.execPath, env = process.env) {
  const result = await runProcess(executable, args, { cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024, env });
  records.push({ name, args, exitCode: result.status, expected, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null });
  assert.equal(result.error, undefined, name); assert.equal(result.status, expected, `${name}\n${result.stdout}\n${result.stderr}`); return result.stdout;
}
let evidence;
try {
  const npm = process.env.npm_execpath; assert.ok(npm, 'Use npm run test:package to select the active npm CLI');
  const packs = JSON.parse(await execute('pack', [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root));
  assert.equal(packs.length, 1); const packed = packs[0];
  const packageCheck = await validatePackage(root, packed.files.map(file => file.path));
  // Windows Node22.13 can crash loading TypeScript itself from Unicode paths, even for an empty file.
  const tarball = path.join(temporary, packed.filename), consumer = path.join(temporary, 'consumer workspace'); await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await execute('install', [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', tarball, 'typescript@5.7.3', '@types/node@22.13.0'], consumer);
  const installed = path.join(consumer, 'node_modules/@devcodex/flowkit');
  assert.ok((await lstat(installed)).isDirectory() && !(await lstat(installed)).isSymbolicLink());
  assert.equal(path.resolve(await realpath(installed)), path.resolve(installed), 'Consumer package must be an installed copy');
  async function files(directory, prefix = '') {
    const result = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!item.isSymbolicLink()); const name = path.posix.join(prefix, item.name);
      if (item.isDirectory()) result.push(...await files(path.join(directory, item.name), name)); else { assert.ok(item.isFile()); result.push(name); }
    }
    return result;
  }
  const members = await files(installed); assert.deepEqual(members.sort(), packed.files.map(file => file.path).sort());
  for (const member of members) assert.deepEqual(await readFile(path.join(installed, member)), await readFile(path.join(root, member)), `Installed bytes differ: ${member}`);
  for (const name of ['consumer.mjs', 'consumer.cjs', 'consumer.ts', 'consumer-dom.ts', 'consumer-invalid.ts']) await copyFile(path.join(root, 'tests/package', name), path.join(consumer, name));
  await execute('esm-sdk', ['consumer.mjs'], consumer);
  await execute('cjs', ['consumer.cjs'], consumer);
  const runtime = path.join(temporary, 'runtime'); await mkdir(runtime);
  const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';
  await copyFile(process.execPath, path.join(runtime, runtimeName));
  if (process.platform !== 'win32') { const { chmod } = await import('node:fs/promises'); await chmod(path.join(runtime, runtimeName), 0o755); }
  const env = { ...process.env, PATH: runtime + path.delimiter + process.env.PATH };
  await writeFile(path.join(consumer, 'flowkit.config.mjs'), `if(process.version!==${JSON.stringify(process.version)})throw new Error('Wrong bin Node version');export default {trace:true,mermaid:false};`);
  const compiled = path.join(consumer, 'sample.compiled.mjs'), expectedCode = await readFile(compiled);
  await rm(compiled);
  let compiledTime;
  for (const command of ['compile', 'check']) {
    const output = process.platform === 'win32'
      ? await execute(`bin-${command}`, ['/d', '/s', '/c', `node_modules\\.bin\\flowkit.cmd ${command} sample.workflow.ts --trace --no-mermaid`], consumer, 0, process.env.ComSpec ?? 'cmd.exe', env)
      : await execute(`bin-${command}`, [command, 'sample.workflow.ts', '--trace', '--no-mermaid'], consumer, 0, path.join(consumer, 'node_modules/.bin/flowkit'), env);
    assert.equal(output, ''); assert.deepEqual(await readFile(compiled), expectedCode);
    const { stat } = await import('node:fs/promises'); const modified = (await stat(compiled)).mtimeMs;
    if (command === 'compile') compiledTime = modified; else assert.equal(modified, compiledTime);
  }
  await execute('node-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022', '--types', 'node', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], consumer);
  const rejected = await execute('invalid-types', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022', '--types', 'node', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer-invalid.ts'], consumer, 2);
  assert.match(rejected, /TS2307/); assert.ok((rejected.match(/error TS/g) ?? []).length >= 2);
  await writeFile(path.join(consumer, 'tsconfig.dom.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: 'ES2022', lib: ['ES2022', 'DOM'], types: [], module: 'NodeNext', moduleResolution: 'NodeNext' }, files: ['consumer-dom.ts'] }));
  await execute('minimum-typescript', [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.dom.json'], consumer);
  evidence = { schemaVersion: 'FlowkitPackageConsumerV1', node: process.version, platform: process.platform, tarball: packed.filename,
    sha256: createHash('sha256').update(await readFile(tarball)).digest('hex'), packageCheck,
    typescript: JSON.parse(await readFile(path.join(consumer, 'node_modules/typescript/package.json'), 'utf8')).version,
    nodeTypes: JSON.parse(await readFile(path.join(consumer, 'node_modules/@types/node/package.json'), 'utf8')).version,
    consumerIsInstalledCopy: true, records, passed: true };
} catch (error) {
  console.error(JSON.stringify({ schemaVersion: 'FlowkitPackageConsumerFailureV1', node: process.version, records, error: error.message }));
  throw error;
} finally {
  assert.equal(path.dirname(temporary), base); assert.ok(path.basename(temporary).startsWith('flowkit-consumer-'));
  await rm(temporary, { recursive: true, force: true }); await assert.rejects(access(temporary), { code: 'ENOENT' });
}
console.log(JSON.stringify({ ...evidence, temporaryCleanup: true }));
