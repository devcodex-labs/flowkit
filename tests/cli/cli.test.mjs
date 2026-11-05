import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, stat, access, symlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import * as api from '@devcodex/flowkit';
import { workspace, definition, end, entry, diagnostics, configurationError } from './support.mjs';

const remote = (host = 'example.test') => `node('n',{name:'N',skill:'https://${host}/a.md',output:{type:'object'},next:'done'})`;
const agent = "node('n',{name:'N',agent:'writer',output:{type:'object'},next:'done'})";
const absent = filename => assert.rejects(access(filename), error => error.code === 'ENOENT');

test('compile writes real artifacts and check is silent, read-only, and accepts missing artifacts', async t => {
  const f = await workspace(t); const before = await readdir(f.directory);
  let result = f.invoke(['check', f.file]); assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.deepEqual(await readdir(f.directory), before);
  result = f.invoke(['compile', f.file]); assert.equal(result.status, 0); assert.equal(result.stdout, '');
  const artifact = path.join(f.directory, 'source.compiled.mjs'), diagram = path.join(f.directory, 'source.mmd');
  assert.match(await readFile(artifact, 'utf8'), /^\/\/ @generated/); assert.match(await readFile(diagram, 'utf8'), /flowchart/);
  const snapshots = await Promise.all([artifact, diagram, f.directory].map(async file => [await stat(file), file === f.directory ? null : await readFile(file)]));
  assert.equal(f.invoke(['check', f.file]).status, 0);
  for (const [index, file] of [artifact, diagram, f.directory].entries()) { assert.equal((await stat(file)).mtimeMs, snapshots[index][0].mtimeMs); if (file !== f.directory) assert.deepEqual(await readFile(file), snapshots[index][1]); }
});

test('CLI compiles and checks real TypeScript syntax without changing artifacts during check', async t => {
  const f = await workspace(t); const file = path.join(f.directory, 'typed.workflow.ts');
  await writeFile(file, definition([end]).replace(']});', ']} as const);'));
  const artifact = path.join(f.directory, 'typed.compiled.mjs');
  let before;
  for (const command of ['compile', 'check']) {
    const result = f.invoke([command, file]); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(result.stdout, '');
    if (result.stderr) assert.match(result.stderr, /^\(node:\d+\) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time\r?\n\(Use `[^\r\n]+` to show where the warning was created\)\r?\n$/);
    const code = await readFile(artifact); const modified = (await stat(artifact)).mtimeMs;
    if (before) { assert.deepEqual(code, before.code); assert.equal(modified, before.modified); }
    else { assert.match(code.toString(), /typed\.workflow\.ts/); assert.doesNotMatch(code.toString(), /\bas const\b/); before = { code, modified }; }
  }
});

test('compile errors and check mismatches are exit1 with one JSON diagnostic per line', async t => {
  const f = await workspace(t, [remote(), "terminal('done',{name:'Done',status:'bad'})"]);
  await f.config("export default {remoteSkillHosts:['example.test']};");
  const artifact = path.join(f.directory, 'source.compiled.mjs'); await writeFile(artifact, 'old');
  const rows = diagnostics(f.invoke(['compile', f.file]), 1);
  assert.ok(rows.some(row => row.code === 'FK_C059' && row.severity === 'warning'));
  assert.ok(rows.some(row => row.code === 'FK_C070' && row.severity === 'error'));
  assert.equal(await readFile(artifact, 'utf8'), 'old');
  await writeFile(f.file, definition([end]));
  const mismatch = diagnostics(f.invoke(['check', f.file]), 1).find(row => row.code === 'FK_R001');
  assert.equal(mismatch.file, artifact); assert.equal(mismatch.line, 1); assert.equal(mismatch.column, 1); assert.equal(Object.hasOwn(mismatch, 'nodeId'), false);
  assert.equal(await readFile(artifact, 'utf8'), 'old');
});

test('warning-only compile/check exit0 and never fetch or run a workflow', async t => {
  const f = await workspace(t, [remote(), end]);
  await f.config("export default {remoteSkillHosts:['example.test'],fetch(){throw new Error('Must not fetch')},runId:'ignored',dump:'ignored',signal:new AbortController().signal};");
  for (const command of ['compile', 'check']) { const rows = diagnostics(f.invoke([command, f.file]), 0); assert.deepEqual(rows.map(row => row.code), ['FK_C059']); }
  await absent(path.join(f.directory, 'ignored'));
});

test('argument errors are one text line exit2 before evaluating configuration', async t => {
  const f = await workspace(t);
  await f.config("import fs from 'node:fs/promises';await fs.writeFile(new URL('./loaded',import.meta.url),'yes');export default {}; ");
  const cases = [[], ['run', f.file], ['mermaid', f.file], ['check'], ['check', f.file, 'extra'], ['compile', f.file, '--bad\nflag'], ['check', f.file, '--out-dir'], ['check', f.file, '--trace=false'], ['check', 'a.compiled.mjs']];
  for (const args of cases) { const result = f.invoke(args); assert.equal(result.status, 2); assert.equal(result.stdout.trimEnd().split('\n').length, 1); assert.throws(() => JSON.parse(result.stdout)); }
  await absent(path.join(f.directory, 'loaded'));
});

test('missing source, directory source and output I/O failures exit2 as single text lines', async t => {
  const f = await workspace(t); await mkdir(path.join(f.directory, 'directory.workflow.js'));
  for (const file of ['missing.workflow.js', 'directory.workflow.js']) { const result = f.invoke(['check', file]); assert.equal(result.status, 2); assert.equal(result.stdout.trimEnd().split('\n').length, 1); assert.throws(() => JSON.parse(result.stdout)); }
  await mkdir(path.join(f.directory, 'source.compiled.mjs'));
  const result = f.invoke(['compile', f.file]); assert.equal(result.status, 2); assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  assert.ok((await stat(path.join(f.directory, 'source.compiled.mjs'))).isDirectory());
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('configuration syntax, missing default, nonobjects, missing dependencies and directory paths have exact exit2 shape', async t => {
  const modules = ['export default {', 'export const trace=true;', 'export default null;', 'export default [];', 'export default 1;', 'export default ()=>({});', "import './absent.mjs';export default {};"];
  for (const code of modules) { const f = await workspace(t); await f.config(code); configurationError(f.invoke(['compile', f.file])); await absent(path.join(f.directory, 'source.compiled.mjs')); }
  const f = await workspace(t); await mkdir(path.join(f.directory, 'flowkit.config.mjs')); configurationError(f.invoke(['check', f.file]));
});

test('all eleven option types and unknown keys are validated before CLI overrides', async t => {
  const invalid = ["{projectRoot:1}", "{outDir:null}", "{skillsRoot:[]}", "{skillCheck:null}", "{remoteSkillHosts:'x'}", "{remoteSkillHosts:[1]}", "{trace:'yes'}", "{mermaid:null}", "{fetch:1}", "{signal:{}}", "{runId:1}", "{dump:false}", "{filename:undefined}", "{extra:1}", "{[Symbol('x')]:1}"];
  for (const value of invalid) {
    const f = await workspace(t); await f.config('export default ' + value + ';');
    configurationError(f.invoke(['compile', f.file, '--trace', '--no-mermaid', '--out-dir', '.', '--skills-root', 'skills', '--no-skill-check', '--remote-skill-host', 'ok.test']));
    await absent(path.join(f.directory, 'source.compiled.mjs'));
  }
});

test('legal ignored runtime keys and undefined values remain valid without being used', async t => {
  const f = await workspace(t);
  await f.config("export default {projectRoot:undefined,outDir:undefined,skillsRoot:undefined,skillCheck:undefined,remoteSkillHosts:[],trace:undefined,mermaid:undefined,fetch(){throw new Error('unused')},signal:new AbortController().signal,runId:'id',dump:'never-created'};");
  const result = f.invoke(['compile', f.file]); assert.equal(result.status, 0, result.stdout); assert.equal(result.stdout, '');
  await absent(path.join(f.directory, 'never-created'));
});

test('explicit false flags override true configuration and absent flags retain configured values', async t => {
  const f = await workspace(t, [agent, end]);
  await f.config("export default {trace:false,mermaid:true,skillCheck:true,skillsRoot:'missing'};");
  let result = f.invoke(['compile', f.file, '--trace', '--no-mermaid', '--no-skill-check']); assert.equal(result.status, 0, result.stdout);
  assert.match(await readFile(path.join(f.directory, 'source.compiled.mjs'), 'utf8'), /options: trace=on/); await absent(path.join(f.directory, 'source.mmd'));
  await f.config("export default {trace:true,mermaid:false,skillCheck:false,skillsRoot:'missing'};");
  result = f.invoke(['compile', f.file, '--mermaid']); assert.equal(result.status, 0, result.stdout);
  assert.match(await readFile(path.join(f.directory, 'source.compiled.mjs'), 'utf8'), /options: trace=on/); await access(path.join(f.directory, 'source.mmd'));
});

test('the first remote host flag replaces the whole configuration array rather than appending', async t => {
  const f = await workspace(t, [remote(), end]); await f.config("export default {remoteSkillHosts:['example.test']};");
  assert.ok(diagnostics(f.invoke(['check', f.file, '--remote-skill-host', 'other.test']), 1).some(row => row.code === 'FK_C057'));
  await f.config("export default {remoteSkillHosts:['denied.test']};");
  const rows = diagnostics(f.invoke(['check', f.file, '--remote-skill-host', 'other.test', '--remote-skill-host=example.test']), 0);
  assert.deepEqual(rows.map(row => row.code), ['FK_C059']);
});

test('only invocation cwd configuration is loaded, never parent/source-directory or other extensions', async t => {
  const f = await workspace(t); const nested = path.join(f.directory, 'nested'); await mkdir(nested);
  await f.config("throw new Error('parent must not load');");
  for (const name of ['flowkit.config.js', 'flowkit.config.json']) await writeFile(path.join(nested, name), 'invalid unrelated config');
  const result = f.invoke(['check', '../source.workflow.js'], nested); assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout, '');
});

test('config import and source paths support Unicode, spaces, hash and percent characters', async t => {
  const f = await workspace(t); const directory = path.join(f.directory, '中文 # % space'); await mkdir(directory);
  await writeFile(path.join(directory, 'flowkit.config.mjs'), 'export default {mermaid:false};');
  const file = path.join(directory, '示例 空格.workflow.js'); await writeFile(file, definition([end]));
  assert.equal(f.invoke(['compile', path.basename(file)], directory).status, 0);
  await access(path.join(directory, '示例 空格.compiled.mjs')); await absent(path.join(directory, '示例 空格.mmd'));
});

test('configuration chdir cannot move relative outDir, source or inferred projectRoot fallback', async t => {
  const f = await workspace(t, [agent, end]); await mkdir(path.join(f.directory, 'other')); await mkdir(path.join(f.directory, 'skills')); await writeFile(path.join(f.directory, 'skills/writer.md'), 'instructions');
  await f.config("import {fileURLToPath} from 'node:url';process.chdir(fileURLToPath(new URL('./other/',import.meta.url)));export default {outDir:'.',mermaid:false};");
  const result = f.invoke(['compile', './source.workflow.js']); assert.equal(result.status, 0, result.stdout);
  await access(path.join(f.directory, 'source.compiled.mjs')); assert.deepEqual(await readdir(path.join(f.directory, 'other')), []);
});

test('configuration throws remain one JSON line even with hostile error formatting', async t => {
  for (const expression of ["new Error('one\\ntwo\\rthree')", 'undefined', 'Object.create(null)', "{get message(){throw new Error('getter')}}"]) {
    const f = await workspace(t); await f.config('throw ' + expression + ';'); configurationError(f.invoke(['check', f.file]));
  }
});

test('configuration error messages are read once even when their getter mutates the thrown object', async t => {
  for (const mutation of ['delete this.message', "Object.defineProperty(this,'message',{value:42})"]) {
    const f = await workspace(t);
    await f.config("throw {get message(){" + mutation + ";return 'original configuration error';}};");
    const result = f.invoke(['check', f.file]);
    assert.equal(configurationError(result).message, 'original configuration error');
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trimEnd().split('\n').length, 1);
  }
});

test('a present dangling configuration link is a load error rather than an absent optional config', async t => {
  const f = await workspace(t), target = path.join(f.directory, 'target'); await mkdir(target);
  await symlink(target, path.join(f.directory, 'flowkit.config.mjs'), process.platform === 'win32' ? 'junction' : 'dir');
  await rmdir(target);
  configurationError(f.invoke(['check', f.file]));
});

test('static compilation never imports workflow side effects and API calls never auto-load CLI configuration', async t => {
  const f = await workspace(t);
  await writeFile(path.join(f.directory, 'evil.mjs'), "import fs from 'node:fs/promises';await fs.writeFile(new URL('./executed',import.meta.url),'bad');");
  await writeFile(f.file, "import './evil.mjs';\n" + definition([end]));
  assert.ok(diagnostics(f.invoke(['compile', f.file]), 1).some(row => row.code === 'FK_C007')); await absent(path.join(f.directory, 'executed'));
  await writeFile(f.file, definition([end])); await f.config("throw new Error('CLI only');");
  assert.deepEqual((await api.compile(f.file)).diagnostics, []); assert.deepEqual(await api.check(f.file), []);
  assert.equal((await api.run(f.file, { isControlSignal: api.isControlSignal })).terminal, 'done');
});

test('bin metadata, lockfile and built entry agree, preserve shebang and add no public subpath', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.bin, { flowkit: './dist/cli.mjs' });
  assert.deepEqual(Object.keys(lock.packages[''].bin), ['flowkit']);
  assert.ok(['./dist/cli.mjs', 'dist/cli.mjs'].includes(lock.packages[''].bin.flowkit));
  const source = await readFile(new URL('../../src/cli.mjs', import.meta.url)); const built = await readFile(entry);
  assert.deepEqual(built, source); assert.ok(built.toString().startsWith('#!/usr/bin/env node\n'));
  await assert.rejects(import('@devcodex/flowkit/cli'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
