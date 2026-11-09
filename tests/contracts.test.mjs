import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUBLIC_FUNCTIONS, OPTION_KEYS, ERROR_CATALOG, DSL_FIELDS, NODE_TYPES } from '../src/shared/contracts.mjs';

test('定稿六名称和11选项与公共声明一致', async () => {
  assert.deepEqual(PUBLIC_FUNCTIONS, ['run', 'compile', 'compileSource', 'check', 'evalWhen', 'isControlSignal']);
  assert.deepEqual(OPTION_KEYS, ['projectRoot', 'outDir', 'skillsRoot', 'skillCheck', 'remoteSkillHosts', 'trace', 'mermaid', 'fetch', 'signal', 'runId', 'dump']);
  const declaration = await readFile(new URL('../types/index.d.ts', import.meta.url), 'utf8');
  assert.deepEqual([...declaration.matchAll(/export declare function (\w+)/g)].map(x => x[1]), PUBLIC_FUNCTIONS);
  const options = declaration.match(/interface FlowkitOptions \{([\s\S]*?)\n\}/)[1];
  assert.deepEqual([...options.matchAll(/^\s+(\w+)\?:/gm)].map(x => x[1]), OPTION_KEYS);
});

test('61码与独立定稿快照一致，只有两warning和一个预留码', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/contract-codes.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(ERROR_CATALOG).length, 61);
  assert.deepEqual(Object.keys(ERROR_CATALOG), baseline.codes.map(x => x.code));
  assert.deepEqual(Object.values(ERROR_CATALOG).map(x => x.message), baseline.codes.map(x => x.message));
  assert.equal(Object.keys(ERROR_CATALOG).filter(x => x.startsWith('FK_C')).length, 52);
  assert.deepEqual(Object.keys(ERROR_CATALOG).filter(x => ERROR_CATALOG[x].severity === 'warning'), ['FK_C053', 'FK_C059']);
  assert.deepEqual(Object.keys(ERROR_CATALOG).filter(x => ERROR_CATALOG[x].reserved), ['FK_R003']);
});

test('字段、类型和目录边界固定且不可改写', async () => {
  assert.deepEqual(Object.keys(NODE_TYPES).sort(), ['action', 'condition', 'human', 'loop', 'node', 'parallel', 'terminal', 'verification']);
  assert.deepEqual(DSL_FIELDS.defineWorkflow, ['id', 'version', 'name', 'nodes']);
  assert.equal(NODE_TYPES.node, 'agent');
  assert.ok(Object.isFrozen(DSL_FIELDS.node));
  assert.ok(Object.isFrozen(ERROR_CATALOG.FK_C053));
  assert.throws(() => DSL_FIELDS.node.push('budget'), TypeError);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(typeof pkg.private, 'boolean');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22.13.0');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './dsl', './capability-graph', './package.json']);
  assert.deepEqual(pkg.dependencies, { acorn: '8.19.0' });
});
