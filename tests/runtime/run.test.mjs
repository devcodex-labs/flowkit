import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, unlink, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from '@devcodex/flowkit';
import { fixture, source, end, host, settled } from './support.mjs';

const codeIs = code => error => error.code === code;
const act = "action('a',{name:'A',action:'save',next:'done'})";
const agent = "node('n',{name:'N',agent:'a',output:{type:'object'},next:'done'})";

test('public run exposes the sixth real function and resolves actual context state without writing artifacts', async t => {
  assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal', 'run']);
  const f = await fixture(t, [act, end()]);
  const before = await readdir(f.directory); let ctx;
  const runtime = host({ runAction: async function (_a, _n, context) { assert.equal(this, runtime); ctx = context; context.state.value = 2; } });
  const initial = { value: 1 };
  assert.deepEqual(await api.run(f.file, runtime, initial, { projectRoot: f.directory, outDir: '/ignored', mermaid: true, runId: '' }),
    { status: 'succeeded', terminal: 'done', state: { value: 2 } });
  assert.equal(initial.value, 1); assert.equal(ctx.runtime, runtime); assert.equal(ctx.runId, '');
  assert.deepEqual(await readdir(f.directory), before);
});

test('successful DSL cache rereads source but skips repeat Skill existence checks, preserving separate Skill caches', async t => {
  const f = await fixture(t, [agent, end()]); await mkdir(path.join(f.directory, 'skills')); const skill = path.join(f.directory, 'skills/a.md');
  await writeFile(skill, 'one'); const seen = [];
  const runtime = host({ runAgent: async step => { seen.push(step.instruction); return {}; }, validateResult: () => [] });
  const original = fs.stat; let checks = 0;
  fs.stat = async (...args) => { if (path.resolve(String(args[0])) === skill) checks++; return original(...args); }; syncBuiltinESMExports();
  try {
    await api.run(f.file, runtime, {}, { projectRoot: f.directory }); assert.equal(checks, 1);
    await writeFile(skill, 'two'); await api.run(f.file, runtime, {}, { projectRoot: f.directory, runId: 'next', mermaid: false, fetch: async () => assert.fail('No remote') }); assert.equal(checks, 1);
    await unlink(skill);
    await assert.rejects(api.run(f.file, runtime, {}, { projectRoot: f.directory }), codeIs('FK_R010')); assert.equal(checks, 1);
    assert.ok((await api.check(f.file, { projectRoot: f.directory })).some(item => item.code === 'FK_C051')); assert.equal(checks, 2);
    await writeFile(skill, 'three'); await writeFile(f.file, source([agent, end()]).replace("name:'Runtime'", "name:'Changed'"));
    await api.run(f.file, runtime, {}, { projectRoot: f.directory }); assert.equal(checks, 3);
    assert.deepEqual(seen, ['one', 'two', 'three']);
  } finally { fs.stat = original; syncBuiltinESMExports(); }
});

test('ordered compile cache keys separate roots, hosts, trace, Skills roots, filenames and dump', async t => {
  const f = await fixture(t, [agent, end()]); const alternate = path.join(f.directory, 'other');
  for (const directory of [f.directory, alternate]) { await mkdir(path.join(directory, 'skills'), { recursive: true }); await writeFile(path.join(directory, 'skills/a.md'), 'same'); }
  const runtime = host({ runAgent: async () => ({}), validateResult: () => [] });
  const original = fs.stat; let checks = 0;
  fs.stat = async (...args) => { if (String(args[0]).endsWith(`${path.sep}a.md`)) checks++; return original(...args); }; syncBuiltinESMExports();
  try {
    const options = { projectRoot: f.directory };
    const variants = [{}, { trace: true }, { skillsRoot: path.join(f.directory, 'skills') }, { remoteSkillHosts: ['a.test', 'b.test'] },
      { remoteSkillHosts: ['b.test', 'a.test'] }, { projectRoot: alternate }, { dump: path.join(f.directory, 'dump') }];
    for (const [index, variant] of variants.entries()) { await api.run(f.file, runtime, {}, { ...options, ...variant }); assert.equal(checks, index + 1); }
    const second = path.join(f.directory, 'second.workflow.js'); await writeFile(second, await readFile(f.file));
    await api.run(second, runtime, {}, options); assert.equal(checks, variants.length + 1);
    await api.run(f.file, runtime, {}, { ...options, skillCheck: false }); assert.equal(checks, variants.length + 1);
  } finally { fs.stat = original; syncBuiltinESMExports(); }
});

test('compile failures are not cached, retain phase and all diagnostics, and precede state cloning', async t => {
  const f = await fixture(t, [agent, end()]); let cloned = 0;
  const state = Object.defineProperty({}, 'x', { enumerable: true, get() { cloned++; return 1; } });
  const runtime = host({ runAgent: async () => ({}), validateResult: () => [] });
  await assert.rejects(api.run(f.file, runtime, state, { projectRoot: f.directory }), error => error.phase === 'compile' && error.code === 'FK_C051' && error.diagnostics.length > 0);
  assert.equal(cloned, 0);
  await mkdir(path.join(f.directory, 'skills')); await writeFile(path.join(f.directory, 'skills/a.md'), 'fixed');
  await api.run(f.file, runtime, state, { projectRoot: f.directory }); assert.equal(cloned, 1);
});

test('public run keeps business rejections and creates fresh state, signal, runId and default loaders on cache hits', async t => {
  const f = await fixture(t, [act, end()]); const cause = { control: true, kind: 'host' };
  assert.equal((await settled(api.run(f.file, host({ runAction: async () => { throw cause; } }), {}, { projectRoot: f.directory }))).error, cause);
  const contexts = [], runtime = host({ runAction: async (_a, _n, ctx) => { contexts.push(ctx); ctx.state.n = 1; } });
  const signal = new AbortController().signal;
  await api.run(f.file, runtime, {}, { projectRoot: f.directory, signal });
  await api.run(f.file, runtime, {}, { projectRoot: f.directory });
  assert.notEqual(contexts[0], contexts[1]); assert.notEqual(contexts[0].state, contexts[1].state);
  assert.notEqual(contexts[0].skillLoader, contexts[1].skillLoader); assert.notEqual(contexts[0].runId, contexts[1].runId);
  assert.equal(contexts[0].signal, signal); assert.equal(contexts[1].signal, undefined);
});

test('run rejects invalid extensions and options before filesystem work or business callbacks', async () => {
  const original = fs.readFile; let reads = 0;
  fs.readFile = async (...args) => { reads++; return original(...args); }; syncBuiltinESMExports();
  try {
    for (const file of ['x.js', 'x.mjs', 'x.workflow.ts?', '', null]) await assert.rejects(api.run(file, host()), TypeError);
    for (const options of [null, { unknown: true }, { filename: 'x.workflow.js' }, { dump: false }, { signal: {} }]) await assert.rejects(api.run('x.workflow.js', host(), {}, options), TypeError);
    await assert.rejects(api.run('x.workflow.js', {}), TypeError); assert.equal(reads, 0);
  } finally { fs.readFile = original; syncBuiltinESMExports(); }
});

test('public run fixes source, inferred root and relative dump before an asynchronous cwd change', async t => {
  const f = await fixture(t, [act, end()]); const other = path.join(f.directory, 'other'); await mkdir(other);
  const code = "import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {run,isControlSignal} from '@devcodex/flowkit';" +
    "const directory=process.argv[1];process.chdir(directory);const running=run('./source.workflow.js',{isControlSignal,runAction:async()=>{}},{},{dump:'debug'});process.chdir(path.join(directory,'other'));assert.equal((await running).terminal,'done');assert.equal((await fs.readdir(path.join(directory,'debug'))).length,1);assert.deepEqual(await fs.readdir(process.cwd()),[]);";
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.directory], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
});

test('AOT accepts encoded Unicode filenames and checks original source and exact body bytes on every call', async t => {
  const f = await fixture(t, [act, end()]); const filename = path.join(f.directory, '中文 space.workflow.js');
  await writeFile(filename, await readFile(f.file));
  const compiled = await api.compile(filename); assert.deepEqual(compiled.diagnostics, []);
  const artifact = path.join(f.directory, '中文 space.compiled.mjs'); let calls = 0;
  const runtime = host({ runAction: async () => { calls++; } });
  await api.run(artifact, runtime, {}, { projectRoot: f.directory }); assert.equal(calls, 1);
  await writeFile(filename, (await readFile(filename, 'utf8')) + ' ');
  await assert.rejects(api.run(artifact, runtime), error => error.code === 'FK_R001' && !Object.hasOwn(error, 'phase')); assert.equal(calls, 1);
  await writeFile(filename, await readFile(f.file));
  for (const text of [compiled.code.replaceAll('\n', '\r\n'), compiled.code + '\n', compiled.code.replace('succeeded', 'failed')]) {
    await writeFile(artifact, text); await assert.rejects(api.run(artifact, runtime), codeIs('FK_R001')); assert.equal(calls, 1);
  }
  await writeFile(artifact, compiled.code); await unlink(filename);
  await assert.rejects(api.run(artifact, runtime), codeIs('FK_R001'));
});

test('AOT source paths reject raw and encoded lexical escapes without importing the artifact', async t => {
  const f = await fixture(t, [act, end()]); const compiled = await api.compile(f.file);
  const artifact = path.join(f.directory, 'source.compiled.mjs');
  for (const sourcePath of ['', '../source.workflow.js', '%2e%2e/source.workflow.js', '/source.workflow.js', 'C%3A/source.workflow.js', '//server/a.workflow.js', 'x%2F..%2Fa.workflow.js', 'x%5Ca.workflow.js', 'x%00.md']) {
    const code = compiled.code.replace(/^\/\/ source: .*$/m, `// source: ${sourcePath}`);
    await writeFile(artifact, code); await assert.rejects(api.run(artifact, host({ runAction: async () => assert.fail('No business') })), codeIs('FK_R001'));
  }
  for (const code of ['// short\n', compiled.code.replace('// sourceHash:', '// hiddenHash:')]) { await writeFile(artifact, code); await assert.rejects(api.run(artifact, host()), codeIs('FK_R001')); }
});

test('AOT follows source symlink ancestors normally even when the real source is outside artifact directory', async t => {
  const f = await fixture(t, [end()]); const project = path.join(f.directory, 'project'), outside = path.join(f.directory, 'outside');
  await mkdir(project); await mkdir(outside); await writeFile(path.join(outside, 'ref.workflow.js'), await readFile(f.file));
  await symlink(outside, path.join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await api.compile(path.join(project, 'link/ref.workflow.js'), { outDir: project });
  assert.equal((await api.run(path.join(project, 'ref.compiled.mjs'), host(), {}, { projectRoot: project })).terminal, 'done');
});

test('AOT executes the saved verified snapshot after the artifact is replaced and preserves other filesystem errors', async t => {
  const f = await fixture(t, [act, end()]); const compiled = await api.compile(f.file), artifact = path.join(f.directory, 'source.compiled.mjs');
  const original = fs.readFile; let replaced = false, calls = 0;
  fs.readFile = async (...args) => {
    const bytes = await original(...args);
    if (String(args[0]) === artifact && !replaced) { replaced = true; await writeFile(artifact, compiled.code.replaceAll('succeeded', 'failed')); }
    return bytes;
  }; syncBuiltinESMExports();
  try { assert.equal((await api.run(artifact, host({ runAction: async () => { calls++; } }), {}, { projectRoot: f.directory })).status, 'succeeded'); assert.equal(calls, 1); }
  finally { fs.readFile = original; syncBuiltinESMExports(); }
  await assert.rejects(api.run(artifact, host()), codeIs('FK_R001'));
  const rejection = { code: 'EACCES' };
  fs.readFile = async () => { throw rejection; }; syncBuiltinESMExports();
  try { assert.equal((await settled(api.run(artifact, host(), {}, { projectRoot: f.directory }))).error, rejection); }
  finally { fs.readFile = original; syncBuiltinESMExports(); }
});
