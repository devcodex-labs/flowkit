import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from '@devcodex-labs/flowkit';
import * as dsl from '@devcodex-labs/flowkit/dsl';
import pkg from '@devcodex-labs/flowkit/package.json' with { type: 'json' };
assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal', 'run']);
assert.equal(Object.keys(dsl).length, 9); assert.equal(pkg.name, '@devcodex-labs/flowkit');
const resolved = fileURLToPath(import.meta.resolve('@devcodex-labs/flowkit'));
assert.ok(resolved.startsWith(path.resolve('node_modules/@devcodex-labs/flowkit') + path.sep));
for (const name of ['@devcodex-labs/flowkit/dist/index.mjs', '@devcodex-labs/flowkit/cli', '@devcodex-labs/flowkit/runtime/run', '@devcodex-labs/flowkit/testing']) await assert.rejects(import(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const definition = dsl.defineWorkflow({ id: 'installed', version: '1.0.0', name: 'Installed', nodes: [dsl.terminal('done', { name: 'Done', status: 'succeeded' })] });
assert.ok(Object.isFrozen(definition.nodes[0]));
await mkdir('skills'); await writeFile('skills/a.md', 'Installed Skill.');
const source = `import {defineWorkflow,node,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'installed',version:'1.0.0',name:'Installed',nodes:[node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'save'}),action('save',{name:'Save',action:'save',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]} as const);\n`;
await writeFile('sample.workflow.ts', source);
const output = await api.compile('sample.workflow.ts', { trace: true, mermaid: false }); assert.deepEqual(output.diagnostics, []);
assert.equal((await api.compileSource(source, { filename: 'virtual.workflow.ts', mermaid: false })).diagnostics.length, 0);
const before = await stat('sample.compiled.mjs'); assert.deepEqual(await api.check('sample.workflow.ts', { trace: true, mermaid: false }), []); assert.equal((await stat('sample.compiled.mjs')).mtimeMs, before.mtimeMs);
for (const mode of ['source', 'aot', 'dump']) {
  const host = { isControlSignal: api.isControlSignal, evalWhen: api.evalWhen, runAgent: async step => { assert.equal(step.instruction, 'Installed Skill.'); return { answer: 42 }; }, validateResult: () => [], runAction: async (_id, _name, ctx) => { ctx.state.saved = true; } };
  const result = await api.run(mode === 'aot' ? 'sample.compiled.mjs' : 'sample.workflow.ts', host, {}, { trace: true, ...(mode === 'dump' ? { dump: 'debug' } : {}) });
  assert.equal(result.terminal, 'done'); assert.equal(result.state.answer, 42); assert.equal(result.state.saved, true); assert.equal(Object.hasOwn(result, 'error'), false);
}
assert.equal(api.evalWhen({ runtime: {}, state: { ready: true } }, 'ready'), true); assert.equal(api.isControlSignal({ control: true }), true);
assert.equal(await readFile('sample.compiled.mjs', 'utf8'), output.code);
