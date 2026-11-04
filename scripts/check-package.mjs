import assert from 'node:assert/strict';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'acorn';
import ts from 'typescript';
import { packageFiles } from './package-files.mjs';
import { runProcess } from './validation-process.mjs';

async function tree(root, relative, found = [], depth = 0) {
  assert.ok(depth < 8 && found.length < 256, 'Package inventory exceeded its bounded scope');
  const directory = await lstat(path.join(root, relative));
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), `Invalid package directory: ${relative}`);
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, item.name);
    assert.ok(!item.isSymbolicLink(), `Linked package file: ${name}`);
    if (item.isDirectory()) await tree(root, name, found, depth + 1);
    else { assert.ok(item.isFile(), `Invalid package entry: ${name}`); found.push(name); assert.ok(found.length <= 256, 'Package inventory exceeded its bounded scope'); }
  }
  return found.sort();
}
function imports(text, declaration) {
  if (declaration) {
    const source = ts.createSourceFile('package.d.ts', text, ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, 'Invalid declaration syntax for the minimum TypeScript version');
    const result = source.referencedFiles.map(item => item.fileName);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) result.push(node.moduleReference.expression.text);
      ts.forEachChild(node, visit);
    }
    visit(source); return result;
  }
  const result = [], pending = [parse(text, { ecmaVersion: 'latest', sourceType: 'module' })];
  while (pending.length) {
    const node = pending.pop();
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && typeof node.source?.value === 'string') result.push(node.source.value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) pending.push(child); }
      else if (value?.type) pending.push(value);
    }
  }
  return result;
}
/** Check actual output bytes and pack contents, including private relative module dependencies. */
export async function validatePackage(root, packedPaths) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.name, '@devcodex/flowkit'); assert.equal(pkg.private, true); assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22.13.0'); assert.deepEqual(pkg.dependencies, { acorn: '8.19.0' });
  assert.deepEqual(pkg.bin, { flowkit: './dist/cli.mjs' }); assert.deepEqual(lock.packages[''].bin, pkg.bin);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies); assert.equal(lock.version, pkg.version);
  assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE']);
  assert.deepEqual(Object.keys(pkg.exports), ['.', './dsl', './package.json']);
  for (const [key, types, module] of [['.', './dist/compiler-api.d.ts', './dist/index.mjs'], ['./dsl', './dist/dsl.d.ts', './dist/dsl.mjs']]) {
    assert.deepEqual(Object.keys(pkg.exports[key]), ['types', 'import', 'default']);
    assert.deepEqual(pkg.exports[key], { types, import: module, default: module });
  }
  assert.equal(pkg.exports['./package.json'], './package.json');
  const expected = packageFiles.map(([, output]) => output).sort();
  assert.deepEqual(await tree(root, 'dist'), expected, 'Unexpected or missing build output');
  const sourceFiles = [...(await tree(root, 'src')).filter(file => file.endsWith('.mjs')), ...(await tree(root, 'types')).filter(file => file.endsWith('.d.ts'))].sort();
  assert.deepEqual(sourceFiles, packageFiles.map(([source]) => source).sort(), 'Build manifest does not cover the sources');
  const members = new Set(expected);
  for (const [source, output] of packageFiles) {
    const bytes = await readFile(path.join(root, output));
    assert.deepEqual(bytes, await readFile(path.join(root, source)), `Stale output: ${output}`);
    for (const specifier of imports(bytes.toString(), output.endsWith('.d.ts'))) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) { assert.ok(Object.hasOwn(pkg.dependencies, specifier), `Unlisted dependency: ${specifier}`); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(output), specifier));
      const resolved = output.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target;
      assert.ok(members.has(resolved), `Missing packaged import: ${output} -> ${specifier}`);
    }
  }
  const cli = await readFile(path.join(root, 'dist/cli.mjs'), 'utf8'); assert.ok(cli.startsWith('#!/usr/bin/env node\n'), 'Missing CLI shebang');
  if (process.platform !== 'win32') assert.ok((await lstat(path.join(root, 'dist/cli.mjs'))).mode & 0o111, 'CLI is not executable');
  let licensePresent = false;
  try { licensePresent = (await lstat(path.join(root, 'LICENSE'))).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expectedPack = ['package.json', 'README.md', ...expected, ...(licensePresent ? ['LICENSE'] : [])].sort();
  assert.deepEqual([...packedPaths].sort(), expectedPack, 'Tarball contents differ from the package whitelist');
  return { files: expectedPack.length, modules: expected.length, licensePresent };
}
async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.ok(process.env.npm_execpath, 'Use npm run check:package so npm_execpath identifies the active npm CLI');
  const result = await runProcess(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout); const checked = await validatePackage(root, packed.files.map(file => file.path));
  console.log(JSON.stringify({ schemaVersion: 'FlowkitPackageCheckV1', ...checked, passed: true }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
