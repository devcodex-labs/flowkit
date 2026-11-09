import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, symlink, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../scripts/build.mjs';
import { packageFiles } from '../../scripts/package-files.mjs';
import { validatePackage } from '../../scripts/check-package.mjs';
import { runProcess } from '../../scripts/validation-process.mjs';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const packed = ['package.json', 'README.md', ...packageFiles.map(([, output]) => output)];
async function fixture(t) {
  const base = path.resolve(tmpdir()), directory = await mkdtemp(path.join(base, 'flowkit-package-'));
  t.after(async () => { assert.equal(path.dirname(directory), base); assert.ok(path.basename(directory).startsWith('flowkit-package-')); await rm(directory, { recursive: true, force: true }); });
  for (const file of ['package.json', 'package-lock.json', 'README.md', ...packageFiles.map(([source]) => source)]) {
    const target = path.join(directory, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(repository, file), target);
  }
  await build(directory); return directory;
}

test('a clean build removes stale derived files and ships exact source bytes with an executable CLI', async t => {
  const directory = await fixture(t); const source = await readFile(path.join(directory, 'src/cli.mjs'));
  await writeFile(path.join(directory, 'dist/stale.mjs'), 'old output'); await build(directory);
  await assert.rejects(access(path.join(directory, 'dist/stale.mjs')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(directory, 'src/cli.mjs')), source);
  assert.deepEqual(await readFile(path.join(directory, 'dist/cli.mjs')), source);
  await writeFile(path.join(directory, 'src/internal.d.ts'), 'export interface InternalOnly {}');
  if (process.platform !== 'win32') assert.ok((await stat(path.join(directory, 'dist/cli.mjs'))).mode & 0o111);
  assert.deepEqual(await validatePackage(directory, packed), { files: packed.length, modules: packageFiles.length, licensePresent: false });
});
test('build rejects a linked dist without touching the linked target', async t => {
  const directory = await fixture(t), outside = path.join(directory, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'preserve'); await rm(path.join(directory, 'dist'), { recursive: true });
  await symlink(outside, path.join(directory, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(build(directory), /linked dist/); assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'preserve');
  await assert.rejects(validatePackage(directory, packed), /Invalid package directory/);
});
test('build validates missing input before removing existing outputs', async t => {
  const directory = await fixture(t); await writeFile(path.join(directory, 'dist/keep'), 'old'); await rm(path.join(directory, 'src/cli.mjs'));
  await assert.rejects(build(directory), { code: 'ENOENT' }); assert.equal(await readFile(path.join(directory, 'dist/keep'), 'utf8'), 'old');
});
test('package validation rejects leaked files, stale output and missing declarations', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'dist/debug.log'), 'leak'); await assert.rejects(validatePackage(directory, packed), /Unexpected or missing/);
  await rm(path.join(directory, 'dist/debug.log')); await writeFile(path.join(directory, 'dist/cli.mjs'), 'stale'); await assert.rejects(validatePackage(directory, packed), /Stale output/);
  await build(directory); await rm(path.join(directory, 'dist/index.d.ts')); await assert.rejects(validatePackage(directory, packed), /Unexpected or missing/);
});
test('package validation catches nested static import closure failures and uncovered source modules', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'src/cli.mjs'), "#!/usr/bin/env node\nasync function later(){return import('./missing.mjs')}\nvoid later;\n"); await build(directory);
  await assert.rejects(validatePackage(directory, packed), /Missing packaged import/);
  await writeFile(path.join(directory, 'src/new.mjs'), 'export {};'); await assert.rejects(validatePackage(directory, packed), /manifest does not cover/);
});
test('package validation rejects wrong exports, bin lock drift and a mismatched npm pack list', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'package.json'); const original = await readFile(filename, 'utf8');
  for (const mutate of [pkg => { pkg.exports['./internal'] = './dist/cli.mjs'; }, pkg => { pkg.exports['.'] = { import: './dist/index.mjs', types: './dist/compiler-api.d.ts', default: './dist/index.mjs' }; }, pkg => { pkg.bin.flowkit = './src/cli.mjs'; }]) {
    const pkg = JSON.parse(original); mutate(pkg); await writeFile(filename, JSON.stringify(pkg)); await assert.rejects(validatePackage(directory, packed));
  }
  await writeFile(filename, original);
  await assert.rejects(validatePackage(directory, [...packed, 'sources/original.zip']), /Tarball contents/);
  await assert.rejects(validatePackage(directory, packed.filter(file => file !== 'dist/cli.mjs')), /Tarball contents/);
});

test('declaration closure catches import types and reference paths without treating string literals as dependencies', async t => {
  const directory = await fixture(t), declaration = path.join(directory, 'types/compiler-api.d.ts'), original = await readFile(declaration, 'utf8');
  for (const extra of ["export type Missing = import('./missing.js').X;", '/// <reference path="./missing.d.ts" />']) {
    await writeFile(declaration, extra + '\n' + original); await build(directory);
    await assert.rejects(validatePackage(directory, packed), /Missing packaged import/);
  }
  await writeFile(declaration, original + '\nexport type Text = "import(\'./not-a-dependency.js\')";'); await build(directory);
  await validatePackage(directory, packed);
});

test('validation timeout terminates a waiting shell and its child before temporary cleanup', async t => {
  const directory = await fixture(t), marker = path.join(directory, 'child.pid');
  await writeFile(path.join(directory, 'hang.mjs'), "import fs from 'node:fs';fs.writeFileSync(process.env.FLOWKIT_CHILD_PID,String(process.pid));setInterval(()=>{},1000);");
  const env = { ...process.env, FLOWKIT_TEST_NODE: process.execPath, FLOWKIT_HANG_FILE: path.join(directory, 'hang.mjs'), FLOWKIT_CHILD_PID: marker };
  let pid;
  let result;
  try {
  if (process.platform === 'win32') {
    await writeFile(path.join(directory, 'hang.cmd'), '@"%FLOWKIT_TEST_NODE%" "%FLOWKIT_HANG_FILE%"\r\n');
    result = await runProcess(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'hang.cmd'], { cwd: directory, env, timeout: 1800 });
  } else {
    await writeFile(path.join(directory, 'hang.sh'), '"$FLOWKIT_TEST_NODE" "$FLOWKIT_HANG_FILE" &\nwait\n');
    result = await runProcess('sh', ['hang.sh'], { cwd: directory, env, timeout: 1800 });
  }
  assert.equal(result.error?.code, 'ETIMEDOUT'); pid = Number(await readFile(marker, 'utf8')); assert.ok(pid > 0);
  let stopped = false;
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; stopped = true; }
  if (!stopped && process.platform === 'linux') {
    // A killed child may await reaping by the WSL init process; a zombie cannot run or hold file handles.
    try { stopped = /^State:\s+Z\b/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; stopped = true; }
  }
  assert.equal(stopped, true, 'The validation child is still running');
  await rm(directory, { recursive: true }); await assert.rejects(access(directory), { code: 'ENOENT' });
  } finally {
    try { pid ??= Number(await readFile(marker, 'utf8')); if (pid > 0) process.kill(pid, 'SIGKILL'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
});
