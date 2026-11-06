import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, readdir, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compile, compileSource, check, run, evalWhen, isControlSignal } from '@devcodex/flowkit';
const source = await readFile('sample.workflow.js', 'utf8');
await compile('sample.workflow.js'); const before = await stat('sample.compiled.mjs');
assert.deepEqual(await check('sample.workflow.js'), []); assert.equal((await stat('sample.compiled.mjs')).mtimeMs, before.mtimeMs);
await unlink('sample.compiled.mjs'); assert.deepEqual(await check('sample.workflow.js'), []); await assert.rejects(stat('sample.compiled.mjs'), { code: 'ENOENT' });
await compile('sample.workflow.js'); await writeFile('sample.compiled.mjs', 'changed'); assert.ok((await check('sample.workflow.js')).some(item => item.code === 'FK_R001'));
await compile('sample.workflow.js');
await mkdir('src', { recursive: true }); await mkdir('dist', { recursive: true }); await writeFile('src/child.workflow.js', source);
await assert.rejects(compile('src/child.workflow.js', { outDir: 'dist' }), TypeError);
assert.equal((await compile('src/child.workflow.js', { outDir: '.' })).diagnostics.length, 0);
await assert.rejects(compileSource(source, {}), TypeError);
assert.equal((await compileSource(source, { filename: 'virtual.workflow.js' })).diagnostics.length, 0);
await assert.rejects(run('virtual.compiled.mjs', { isControlSignal }), { code: 'FK_R001' });
const initial = { nested: { value: 1 } }; let observed;
const runtime = { isControlSignal, async runAction(action, name, ctx) { observed = ctx; ctx.state.saved = true; ctx.state.nested.value++; } };
await run('sample.workflow.js', runtime, initial, { runId: 'named', dump: 'dump', mermaid: true, outDir: 'ignored' });
assert.equal(initial.saved, undefined); assert.equal(initial.nested.value, 2); assert.equal(observed.runId, 'named');
assert.equal(evalWhen(observed, 'saved && nested.value === 2'), true); assert.equal(isControlSignal({ control: true }), true);
await assert.rejects(run('sample.workflow.js', runtime, {}, { unknown: true }), TypeError);
const dumps = (await readdir('dump')).filter(file => file.endsWith('.run.mjs')); assert.ok(dumps.length); assert.ok((await readFile(path.join('dump', dumps[0]), 'utf8')).includes('export'));
const require = createRequire(import.meta.url), packageFile = require.resolve('@devcodex/flowkit/package.json');
const metadata = JSON.parse(await readFile(packageFile, 'utf8')), bin = path.resolve(path.dirname(packageFile), metadata.bin.flowkit);
function cli(args) { return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 30000 }); }
assert.equal(cli(['compile', 'sample.workflow.js', '--trace', '--no-mermaid']).status, 0);
assert.equal(cli(['check', 'sample.workflow.js', '--trace', '--no-mermaid']).status, 0);
await writeFile('bad.workflow.js', source.replace("next: 'done'", "next: 'missing'"));
const bad = cli(['compile', 'bad.workflow.js']); assert.equal(bad.status, 1); assert.ok(bad.stdout.includes('FK_C015'));
assert.equal(cli(['run', 'sample.workflow.js']).status, 2);
const config = await readFile('flowkit.config.mjs');
try { await writeFile('flowkit.config.mjs', 'export default {trace: "wrong"};'); assert.equal(cli(['compile', 'sample.workflow.js', '--trace']).status, 2); }
finally { await writeFile('flowkit.config.mjs', config); }
console.log('six APIs, paths, artifacts, context, dump and CLI exits verified');
