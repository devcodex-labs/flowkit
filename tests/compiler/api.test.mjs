import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as api from '@devcodex/flowkit';

const source = name => `import {defineWorkflow,terminal} from '@devcodex/flowkit/dsl';\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'${name ?? 'Demo'}',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});\n`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function workspace(t) {
  const base = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(base, 'flowkit-api-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), base);
    assert.ok(path.basename(directory).startsWith('flowkit-api-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function snapshot(directory) {
  const records = [];
  async function visit(folder) {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(folder, entry.name);
      const metadata = await stat(filename, { bigint: true });
      records.push([path.relative(directory, filename), String(metadata.mtimeNs), entry.isDirectory() ? 'directory' : hash(await readFile(filename))]);
      if (entry.isDirectory()) await visit(filename);
    }
  }
  await visit(directory);
  return records;
}

test('package root exposes implemented compiler functions and runtime helpers while blocking deep imports', async () => {
  assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal', 'run']);
  await assert.rejects(import('@devcodex/flowkit/compiler/api'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('the README quick-start module compiles unchanged through the public API', async t => {
  const directory = await workspace(t);
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  const example = readme.match(/```js\r?\n([\s\S]*?)```/)[1];
  const result = await api.compileSource(example, { filename: path.join(directory, 'sample.workflow.js') });
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.code.includes('export async function workflow(ctx)'));
  assert.equal(await readFile(path.join(directory, 'sample.compiled.mjs'), 'utf8'), result.code);
  assert.equal(await readFile(path.join(directory, 'sample.mmd'), 'utf8'), result.mermaid);
});

test('API paths and default-root fallback stay bound to invocation cwd across asynchronous source reads', async t => {
  const directory = await workspace(t);
  const script = String.raw`import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
const api=await import(${JSON.stringify(import.meta.resolve('@devcodex/flowkit'))});
const base=process.argv[1],project=path.join(base,'project');
await mkdir(path.join(project,'nested'),{recursive:true});
await mkdir(path.join(project,'skills'));await writeFile(path.join(project,'skills/a.md'),'instruction');
await writeFile(path.join(project,'nested/source.workflow.js'),${JSON.stringify(source())});
process.chdir(project);const compiling=api.compile('nested/source.workflow.js',{outDir:'.'});process.chdir(base);
const first=await compiling;assert.deepEqual(first.diagnostics,[]);
const artifact=path.join(project,'source.compiled.mjs');assert.equal(await readFile(artifact,'utf8'),first.code);
await assert.rejects(stat(path.join(base,'source.compiled.mjs')),{code:'ENOENT'});
await writeFile(artifact,first.code+' ');
process.chdir(project);const checking=api.check('nested/source.workflow.js',{outDir:'.'});process.chdir(base);
const differences=await checking;assert.deepEqual(differences.map(d=>d.code),['FK_R001']);assert.equal(differences[0].file,artifact);
const agent="import {defineWorkflow,node,terminal} from '@devcodex/flowkit/dsl';export default defineWorkflow({id:'agent',version:'1.0.0',name:'Agent',nodes:[node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});";
await writeFile(path.join(project,'nested/agent.workflow.js'),agent);
// Simulate no package.json ancestors so the fallback is independent of the test machine.
const originalStat=fsSync.statSync;
fsSync.statSync=(filename,...args)=>{if(path.basename(String(filename))==='package.json')throw Object.assign(Error('missing'),{code:'ENOENT'});return originalStat(filename,...args);};
syncBuiltinESMExports();
try {
  for(const options of [{projectRoot:'.'},{}]) {
    process.chdir(project);const pending=api.compile('nested/agent.workflow.js',options);process.chdir(base);
    assert.deepEqual((await pending).diagnostics,[]);
    process.chdir(project);const checked=api.check('nested/agent.workflow.js',options);process.chdir(base);
    assert.deepEqual(await checked,[]);
  }
} finally {fsSync.statSync=originalStat;syncBuiltinESMExports();}
process.chdir(project);const virtual=api.compileSource(${JSON.stringify(source())},{filename:'virtual/source.workflow.js',outDir:'.'});process.chdir(base);
assert.deepEqual((await virtual).diagnostics,[]);assert.ok((await stat(path.join(project,'source.compiled.mjs'))).isFile());
console.log('Invocation cwd, explicit roots, fallback, output and readonly comparison stay fixed.');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('compile writes deterministic code and diagram from raw BOM/CRLF source, replacing complete artifacts', async t => {
  const directory = await workspace(t);
  const file = path.join(directory, '中文 #demo.workflow.ts');
  const raw = Buffer.from('\uFEFF' + source().replaceAll('\n', '\r\n'));
  await writeFile(file, raw);
  const first = await api.compile(file);
  assert.deepEqual(Object.keys(first), ['code', 'mermaid', 'diagnostics']);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(await readFile(path.join(directory, '中文 #demo.compiled.mjs'), 'utf8'), first.code);
  assert.equal(await readFile(path.join(directory, '中文 #demo.mmd'), 'utf8'), first.mermaid);
  assert.ok(first.code.includes(`sourceHash: sha256:${hash(raw)}`));
  assert.ok(first.code.split('\n')[2].includes('%23demo.workflow.ts'));
  await writeFile(path.join(directory, '中文 #demo.compiled.mjs'), 'edited');
  const second = await api.compile(file);
  assert.equal(second.code, first.code);
  assert.equal(await readFile(path.join(directory, '中文 #demo.compiled.mjs'), 'utf8'), first.code);
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
});

test('compileSource writes for a virtual filename and honors an ancestor output root', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'not-created', 'source.workflow.js');
  const result = await api.compileSource(source(), { filename, outDir: directory });
  await assert.rejects(stat(filename), { code: 'ENOENT' });
  await assert.rejects(stat(path.dirname(filename)), { code: 'ENOENT' });
  assert.equal(result.code.split('\n')[2], '// source: not-created/source.workflow.js');
  assert.equal(await readFile(path.join(directory, 'source.compiled.mjs'), 'utf8'), result.code);
  assert.equal(await readFile(path.join(directory, 'source.mmd'), 'utf8'), result.mermaid);
});

test('compiler errors leave existing artifacts untouched and never create missing output directories', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  await api.compileSource(source(), { filename });
  const before = await snapshot(directory);
  const invalid = source().replace("status:'succeeded'", "status:'unknown'");
  const result = await api.compileSource(invalid, { filename });
  assert.equal(result.code, ''); assert.equal(result.mermaid, '');
  assert.equal(result.diagnostics[0].code, 'FK_C070');
  assert.deepEqual(await snapshot(directory), before);
  const absent = path.join(directory, 'absent', 'source.workflow.js');
  await api.compileSource(invalid, { filename: absent });
  await assert.rejects(stat(path.dirname(absent)), { code: 'ENOENT' });
});

test('warnings permit writing without fetching remote Skills or running source/configuration', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'remote.workflow.js');
  await writeFile(path.join(directory, 'flowkit.config.mjs'), "throw new Error('API must not execute configuration');");
  const remote = "import {defineWorkflow,node,terminal} from '@devcodex/flowkit/dsl';export default defineWorkflow({id:'remote',version:'1.0.0',name:'Remote',nodes:[node('n',{name:'N',skill:'https://example.test/skill.md',output:{type:'object'},next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});";
  const result = await api.compileSource(remote, { filename, remoteSkillHosts: ['example.test'], fetch: () => assert.fail('No network') });
  assert.deepEqual(result.diagnostics.map(item => item.code), ['FK_C059']);
  assert.ok(result.code.length); assert.ok((await stat(path.join(directory, 'remote.compiled.mjs'))).isFile());
  const marker = '__flowkitApiSideEffect';
  assert.equal(globalThis[marker], undefined);
  const invalid = await api.compileSource(`globalThis.${marker}=1;\n${source()}`, { filename });
  assert.equal(invalid.diagnostics[0].code, 'FK_C007');
  assert.equal(globalThis[marker], undefined);
});

test('mermaid false leaves existing diagrams alone and returns empty diagram text', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  await api.compileSource(source(), { filename });
  const diagram = path.join(directory, 'source.mmd');
  await writeFile(diagram, 'user diagram');
  const metadata = await stat(diagram, { bigint: true });
  const result = await api.compileSource(source('Changed'), { filename, mermaid: false });
  assert.equal(result.mermaid, '');
  assert.equal(await readFile(diagram, 'utf8'), 'user diagram');
  assert.equal((await stat(diagram, { bigint: true })).mtimeNs, metadata.mtimeNs);
});

test('check is zero-write when no compiled artifact exists and ignores a stray diagram', async t => {
  const directory = await workspace(t);
  const file = path.join(directory, 'source.workflow.js');
  await writeFile(file, source());
  await writeFile(path.join(directory, 'source.mmd'), 'not compared');
  const before = await snapshot(directory);
  assert.deepEqual(await api.check(file), []);
  assert.deepEqual(await snapshot(directory), before);
});

test('check reports a changed JS/header as R001 with exact artifact location and never rewrites it', async t => {
  const directory = await workspace(t);
  const file = path.join(directory, 'source.workflow.js');
  await writeFile(file, source());
  const compiled = await api.compile(file);
  const artifact = path.join(directory, 'source.compiled.mjs');
  for (const changed of [compiled.code.replace('// compiler:', '// changed compiler:'), compiled.code + ' ', 'invalid UTF8']) {
    await writeFile(artifact, changed === 'invalid UTF8' ? Buffer.from([255]) : changed);
    const before = await snapshot(directory);
    const diagnostics = await api.check(file);
    assert.deepEqual(diagnostics.map(({ code, file, line, column, severity }) => ({ code, file, line, column, severity })),
      [{ code: 'FK_R001', file: artifact, line: 1, column: 1, severity: 'error' }]);
    assert.equal(Object.hasOwn(diagnostics[0], 'nodeId'), false);
    assert.deepEqual(await snapshot(directory), before);
  }
});

test('check uses current options and source every time, and does not compare diagrams', async t => {
  const directory = await workspace(t);
  const file = path.join(directory, 'source.workflow.js');
  await writeFile(file, source());
  await api.compile(file);
  await writeFile(path.join(directory, 'source.mmd'), 'changed diagram');
  assert.deepEqual(await api.check(file), []);
  assert.deepEqual((await api.check(file, { trace: true })).map(item => item.code), ['FK_R001']);
  await writeFile(file, source('Changed'));
  assert.deepEqual((await api.check(file)).map(item => item.code), ['FK_R001']);
  await writeFile(file, source().replace("status:'succeeded'", "status:'unknown'"));
  const before = await snapshot(directory);
  assert.deepEqual((await api.check(file)).map(item => item.code), ['FK_C070']);
  assert.deepEqual(await snapshot(directory), before);
});

test('check compares the ancestor outDir and carries compile warnings alongside a mismatch', async t => {
  const directory = await workspace(t);
  const nested = path.join(directory, 'nested'); await mkdir(nested);
  const file = path.join(nested, 'source.workflow.js'); await writeFile(file, source());
  await api.compile(file, { outDir: directory });
  assert.deepEqual(await api.check(file, { outDir: directory }), []);
  assert.deepEqual(await api.check(file), []);
  const remote = "import {defineWorkflow,node,terminal} from '@devcodex/flowkit/dsl';export default defineWorkflow({id:'remote',version:'1.0.0',name:'Remote',nodes:[node('n',{name:'N',skill:'https://example.test/skill.md',output:{type:'object'},next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});";
  await writeFile(file, remote);
  assert.deepEqual((await api.check(file, { outDir: directory, remoteSkillHosts: ['example.test'] })).map(item => item.code), ['FK_C059', 'FK_R001']);
});

test('API argument and option types reject before I/O; filename is exclusive to compileSource', async t => {
  const directory = await workspace(t);
  const file = path.join(directory, 'missing.workflow.js');
  for (const key of ['compile', 'compileSource', 'check']) {
    const call = options => key === 'compileSource' ? api[key](source(), options) : api[key](file, options);
    for (const options of [null, [], { unknown: true }, { trace: null }, { signal: {} }, { fetch: false }, { remoteSkillHosts: ['ok', 1] }]) await assert.rejects(call(options), TypeError);
  }
  for (const name of ['compile', 'check']) {
    for (const bad of [undefined, null, {}, '', 'x.ts', 'x.compiled.mjs']) await assert.rejects(api[name](bad), TypeError);
    await assert.rejects(api[name](file, { filename: undefined }), TypeError);
    await assert.rejects(api[name](file), { code: 'ENOENT' });
    await assert.rejects(api[name](file, { outDir: path.join(directory, 'child') }), TypeError);
  }
  for (const options of [undefined, {}, { filename: undefined }, { filename: 'x.ts' }]) await assert.rejects(api.compileSource(source(), options), TypeError);
  for (const text of [undefined, null, 1, Buffer.from(source())]) await assert.rejects(api.compileSource(text, { filename: file }), TypeError);
  assert.deepEqual(await readdir(directory), []);
});

test('invalid text and lexical paths reject before filesystem project discovery', async t => {
  const failure = Object.assign(new Error('project discovery'), { code: 'EACCES' });
  let calls = 0;
  t.mock.method(fsSync, 'statSync', () => { calls++; throw failure; });
  syncBuiltinESMExports();
  try {
    for (const text of [undefined, null, 42, Buffer.from('text')]) await assert.rejects(api.compileSource(text, { filename: 'source.workflow.js' }), TypeError);
    await assert.rejects(api.compileSource(42, { unknown: true, filename: 'bad.ts' }), /Unknown option/);
    await assert.rejects(api.compileSource(42, { filename: 'bad.ts' }), /file must end/);
    await assert.rejects(api.compileSource(source(), { filename: 'source.workflow.js', outDir: 'child' }), TypeError);
    for (const name of ['compile', 'check']) await assert.rejects(api[name]('source.workflow.js', { outDir: 'child' }), TypeError);
    assert.equal(calls, 0);
    await assert.rejects(api.compileSource(source(), { filename: 'source.workflow.js' }), error => error === failure);
    assert.equal(calls, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('legal unused options are validated but do not alter compile text or cause execution', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  const normal = await api.compileSource(source(), { filename });
  const controller = new AbortController(); controller.abort();
  const ignored = await api.compileSource(source(), { filename, signal: controller.signal, runId: 'ignored', dump: path.join(directory, 'ignored'), fetch: () => assert.fail('No fetch') });
  assert.equal(ignored.code, normal.code); assert.equal(ignored.mermaid, normal.mermaid);
  await assert.rejects(stat(path.join(directory, 'ignored')), { code: 'ENOENT' });
});

test('filesystem failures remain original errors; failed rename cleans temporary files', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  await mkdir(path.join(directory, 'source.compiled.mjs'));
  await assert.rejects(api.compileSource(source(), { filename }), error => typeof error.code === 'string' && !error.code.startsWith('FK_'));
  assert.deepEqual((await readdir(directory)).sort(), ['source.compiled.mjs']);
  await writeFile(filename, source());
  await assert.rejects(api.check(filename), error => typeof error.code === 'string' && !error.code.startsWith('FK_'));
});

test('a failed second preparation preserves both old targets and cleans only owned temporaries', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  await api.compileSource(source(), { filename });
  await writeFile(path.join(directory, '.user-owned.tmp'), 'keep');
  const before = await snapshot(directory);
  const original = fs.open;
  const failure = Object.assign(new Error('injected filesystem failure'), { code: 'ENOSPC' });
  let calls = 0;
  t.mock.method(fs, 'open', (...args) => ++calls === 2 ? Promise.reject(failure) : original(...args));
  syncBuiltinESMExports();
  try { await assert.rejects(api.compileSource(source('Changed'), { filename }), error => error === failure); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(calls, 2);
  assert.deepEqual(await snapshot(directory), before);
  const recovered = await api.compileSource(source('Recovered'), { filename });
  assert.equal(await readFile(path.join(directory, 'source.compiled.mjs'), 'utf8'), recovered.code);
  assert.equal(await readFile(path.join(directory, '.user-owned.tmp'), 'utf8'), 'keep');
});

test('concurrent compiler calls publish complete files without leaking temporary artifacts', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  const results = await Promise.all(Array.from({ length: 6 }, () => api.compileSource(source(), { filename })));
  assert.equal(await readFile(path.join(directory, 'source.compiled.mjs'), 'utf8'), results[0].code);
  assert.equal(await readFile(path.join(directory, 'source.mmd'), 'utf8'), results[0].mermaid);
  assert.deepEqual((await readdir(directory)).sort(), ['source.compiled.mjs', 'source.mmd']);
});

test('write, sync and close failures preserve their original error and a queued successor recovers', async t => {
  const directory = await workspace(t);
  const filename = path.join(directory, 'source.workflow.js');
  const original = fs.open;
  for (const phase of ['writeFile', 'sync', 'close']) {
    await api.compileSource(source(), { filename });
    const before = await snapshot(directory);
    const failure = Object.assign(new Error(phase), { code: 'ENOSPC' });
    let first = true;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await original(...args);
      if (!first) return handle;
      first = false;
      return Object.fromEntries(['writeFile', 'sync', 'close'].map(method => [method, async (...values) => {
        if (method === phase && method !== 'close') throw failure;
        const result = await handle[method](...values);
        if (method === phase) throw failure;
        return result;
      }]));
    });
    syncBuiltinESMExports();
    try { await assert.rejects(api.compileSource(source('Changed'), { filename }), error => error === failure); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.deepEqual(await snapshot(directory), before);
  }
  const failure = new Error('first writer'); let first = true;
  t.mock.method(fs, 'open', (...args) => { if (first) { first = false; return Promise.reject(failure); } return original(...args); });
  syncBuiltinESMExports();
  try {
    const failed = api.compileSource(source('Failed'), { filename });
    const queued = api.compileSource(source('Recovered'), { filename });
    await assert.rejects(failed, error => error === failure);
    const result = await queued;
    assert.equal(await readFile(path.join(directory, 'source.compiled.mjs'), 'utf8'), result.code);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
});
