import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, unlink, stat } from 'node:fs/promises';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as api from '@devcodex/flowkit';
import { executeSource } from '../../src/runtime/source.mjs';
import { loadWorkflowText } from '../../src/runtime/load.mjs';
import { fixture, source, end, host, settled } from './support.mjs';

test('public helpers expose strict own-state evaluation and the control marker without a kind whitelist', async () => {
  assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal', 'run']);
  for (const value of [undefined, null, 0, 'control', { control: 1 }, { control: false }]) assert.equal(api.isControlSignal(value), false);
  assert.equal(api.isControlSignal({ control: true, kind: 'host-defined' }), true);
  assert.equal(api.evalWhen({ state: { a: 1, b: true } }, '!a === 2 && b'), true);
  assert.equal(api.evalWhen({ state: Object.create({ inherited: true }) }, 'inherited === null'), false);
  assert.throws(() => api.evalWhen({ state: { value: 1 } }, 'value'), { code: 'FK_R002' });
  assert.throws(() => api.evalWhen({ state: {} }, 'call()'), { code: 'FK_C033' });
  await assert.rejects(import('@devcodex/flowkit/runtime/source'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('compile errors select the first error after warnings and precede state cloning or business calls', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'https://example.test/a.md',output:{type:'object'},next:'done'})", end('done', 'unknown')]);
  let stateReads = 0;
  const state = Object.defineProperty({}, 'value', { enumerable: true, get() { stateReads++; throw Error('Do not clone'); } });
  const failure = await settled(f.run(host({ runAgent: async () => assert.fail('No business'), loadSkill: async () => assert.fail('No Skill') }), state, { remoteSkillHosts: ['example.test'] }));
  assert.equal(failure.fulfilled, false); assert.equal(failure.error.phase, 'compile'); assert.equal(failure.error.code, 'FK_C070');
  assert.deepEqual(failure.error.diagnostics.map(item => item.code), ['FK_C059', 'FK_C070']);
  assert.ok(failure.error.message.startsWith('FK_C070')); assert.equal(stateReads, 0);
  assert.deepEqual(await readdir(f.directory), ['source.workflow.js']);
});

test('warnings allow execution with host Skill functions and no network is performed by the core', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'https://example.test/a.md',output:{type:'object'},next:'done'})", end()]);
  let loaded = 0;
  const result = await f.run(host({ loadSkill: async url => { loaded++; assert.equal(url, 'https://example.test/a.md'); return 'instruction'; },
    runAgent: async step => { assert.equal(step.instruction, 'instruction'); return { value: 1 }; }, validateResult: () => [] }), {},
  { remoteSkillHosts: ['example.test'], fetch: () => assert.fail('No default fetch') });
  assert.equal(result.state.value, 1); assert.equal(loaded, 1);
});

test('DSL execution writes no artifacts, does not read configuration, and ignores compiled output locations', async t => {
  const f = await fixture(t, [end()]);
  const config = path.join(f.directory, 'flowkit.config.mjs');
  await writeFile(config, "throw new Error('Configuration must not run');");
  const sourceStat = await stat(f.file, { bigint: true });
  const result = await f.run(host(), {}, { outDir: path.join(f.directory, 'child'), mermaid: true });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual((await readdir(f.directory)).sort(), ['flowkit.config.mjs', 'source.workflow.js']);
  assert.equal((await stat(f.file, { bigint: true })).mtimeNs, sourceStat.mtimeNs);
});

test('the loaded function matches compile text and source execution never imports an edited artifact', async t => {
  const f = await fixture(t, [end()]);
  const compiled = await api.compile(f.file);
  const workflow = await loadWorkflowText(compiled.code);
  assert.equal(Function.prototype.toString.call(workflow), compiled.code.split('\n').slice(10).join('\n').slice(7, -1));
  const edited = "globalThis.__flowkitEditedArtifact=true;throw new Error('Never execute');";
  await writeFile(path.join(f.directory, 'source.compiled.mjs'), edited);
  assert.equal((await f.run(host())).terminal, 'done');
  assert.equal(globalThis.__flowkitEditedArtifact, undefined);
  assert.equal(await readFile(path.join(f.directory, 'source.compiled.mjs'), 'utf8'), edited);
  await writeFile(f.file, source([end('failed', 'failed')]));
  assert.equal((await f.run(host())).status, 'failed');
});

test('source errors are never executed and filesystem errors retain their native identity', async t => {
  const f = await fixture(t, [end()]);
  await writeFile(f.file, 'globalThis.__flowkitDslEffect=true;\n' + source([end()]));
  const rejected = await settled(f.run(host()));
  assert.equal(rejected.error.code, 'FK_C007'); assert.equal(rejected.error.phase, 'compile');
  assert.equal(globalThis.__flowkitDslEffect, undefined);
  const missing = await settled(executeSource(path.join(f.directory, 'missing.workflow.js'), host()));
  assert.equal(missing.error.code, 'ENOENT'); assert.equal(Object.hasOwn(missing.error, 'phase'), false);
  assert.equal(Object.hasOwn(missing.error, 'diagnostics'), false);
});

test('pure input failures precede filesystem discovery and do not clone state', async t => {
  const failure = Object.assign(new Error('No filesystem'), { code: 'EACCES' }); let calls = 0;
  t.mock.method(fsSync, 'statSync', () => { calls++; throw failure; });
  t.mock.method(fs, 'readFile', () => { calls++; return Promise.reject(failure); });
  syncBuiltinESMExports();
  try {
    for (const runtime of [undefined, null, [], {}, { isControlSignal: true }]) await assert.rejects(executeSource('source.workflow.js', runtime), TypeError);
    for (const state of [null, 1, true, [], () => {}]) await assert.rejects(executeSource('source.workflow.js', host(), state), TypeError);
    for (const options of [null, [], { unknown: true }, { signal: {} }, { trace: null }, { filename: undefined }]) await assert.rejects(executeSource('source.workflow.js', host(), {}, options), TypeError);
    for (const file of [undefined, 1, '', 'source.compiled.mjs']) await assert.rejects(executeSource(file, host()), TypeError);
    assert.equal(calls, 0);
    await assert.rejects(executeSource('source.workflow.js', host()), error => error === failure);
    assert.equal(calls, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('the uncached source core checks current local Skill existence on every compilation', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'done'})", end()]);
  await mkdir(path.join(f.directory, 'skills')); const skill = path.join(f.directory, 'skills/a.md'); await writeFile(skill, 'instruction');
  let loads = 0;
  const runtime = host({ loadSkill: async () => { loads++; return 'instruction'; }, runAgent: async () => ({}), validateResult: () => [] });
  await f.run(runtime, {}, { projectRoot: f.directory }); await unlink(skill);
  const missing = await settled(f.run(runtime, {}, { projectRoot: f.directory }));
  assert.equal(missing.error.code, 'FK_C051'); assert.equal(missing.error.phase, 'compile'); assert.equal(loads, 1);
});

test('source execution binds relative roots before async reads even when the caller changes cwd', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'done'})", end()]);
  await mkdir(path.join(f.directory, 'skills')); await writeFile(path.join(f.directory, 'skills/a.md'), 'instruction');
  const script = String.raw`import assert from 'node:assert/strict';
const {executeSource}=await import(${JSON.stringify(new URL('../../src/runtime/source.mjs', import.meta.url).href)});
process.chdir(process.argv[1]);
const pending=executeSource('source.workflow.js',{isControlSignal:error=>error?.control===true,loadSkill:async()=>'',runAgent:async()=>({}),validateResult:()=>[]},{},{projectRoot:'.'});
process.chdir(process.argv[2]);
assert.equal((await pending).terminal,'done');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.directory, path.dirname(f.directory)], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('a host loader that transforms the generated function is rejected before business execution', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'record',next:'done'})", end()]);
  const hook = path.join(f.directory, 'transform.mjs');
  await writeFile(hook, `export async function load(url,context,nextLoad){const result=await nextLoad(url,context);if(url.startsWith('data:text/javascript;base64,')){const text=typeof result.source==='string'?result.source:Buffer.from(result.source).toString('utf8');return {...result,source:text.replace('status: "succeeded"','status: "failed"')};}return result;}`);
  const script = String.raw`import assert from 'node:assert/strict';import {register} from 'node:module';import {pathToFileURL} from 'node:url';
const {executeSource}=await import(${JSON.stringify(new URL('../../src/runtime/source.mjs', import.meta.url).href)});
register(pathToFileURL(process.argv[1]));let calls=0;
await assert.rejects(executeSource(process.argv[2],{isControlSignal:error=>error?.control===true,runAction:async()=>{calls++;}}),error=>error.message==='Loaded workflow function differs from the compiled text'&&!Object.hasOwn(error,'code')&&!Object.hasOwn(error,'phase'));
assert.equal(calls,0);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, hook, f.file], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
