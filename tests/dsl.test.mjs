import test from 'node:test';
import assert from 'node:assert/strict';
import * as dsl from '../src/dsl.mjs';

test('DSL恰九函数，八类构造器保留字面数据', () => {
  assert.deepEqual(Object.keys(dsl).sort(), ['action', 'condition', 'defineWorkflow', 'human', 'loop', 'node', 'parallel', 'terminal', 'verification']);
  const cases = [
    ['node', 'agent', { name: '写作', skill: 'skills/write.md', output: { type: 'object' }, next: 'end' }],
    ['action', 'action', { name: '动作', action: 'save', next: 'end' }],
    ['verification', 'verification', { name: '检查', verifier: 'ok' }],
    ['parallel', 'parallel', { name: '并行', branches: ['a', 'b'], join: { strategy: 'any', next: 'end' } }],
    ['condition', 'condition', { name: '判断', branches: [{ when: 'true', next: 'end' }] }],
    ['loop', 'loop', { name: '修复', maxIterations: 2, body: 'check', onSuccess: 'end', onMaxExceeded: 'fail' }],
    ['human', 'human', { name: '审批', onApprove: 'end', onReject: 'revise' }],
    ['terminal', 'terminal', { name: '成功', status: 'succeeded' }],
  ];
  for (const [name, type, options] of cases) {
    const result = dsl[name]('step', options);
    assert.deepEqual(result, { ...options, id: 'step', type });
    assert.ok(Object.isFrozen(result));
    assert.ok(!Object.isFrozen(options));
  }
});

test('嵌套schema和数组复制冻结，修改原输入不改变定义', () => {
  const output = { type: 'object', properties: { item: { type: 'string', enum: ['a', 'b'] } } };
  const inputs = ['query'];
  const options = { name: '写作', output, inputs, agent: 'writer', next: 'done' };
  const result = dsl.node('write', options);
  assert.notEqual(result.output, output);
  assert.notEqual(result.inputs, inputs);
  assert.ok(Object.isFrozen(result.output.properties.item.enum));
  assert.throws(() => result.output.properties.item.enum.push('c'), TypeError);
  output.properties.item.enum.push('c');
  inputs.push('later');
  assert.deepEqual(result.output.properties.item.enum, ['a', 'b']);
  assert.deepEqual(result.inputs, ['query']);
});

test('defineWorkflow复制节点与节点数组，输入本身仍可编辑', () => {
  const end = dsl.terminal('done', { name: '完成', status: 'succeeded' });
  const definition = { id: 'flow', version: '1.0.0', name: '流程', nodes: [end] };
  const result = dsl.defineWorkflow(definition);
  assert.notEqual(result, definition);
  assert.notEqual(result.nodes, definition.nodes);
  assert.notEqual(result.nodes[0], end);
  assert.ok(Object.isFrozen(result.nodes));
  definition.nodes.push(end);
  definition.name = '已修改';
  assert.equal(result.nodes.length, 1);
  assert.equal(result.name, '流程');
});

test('任意嵌套自身特殊键、null原型和共享子对象得到保留', () => {
  const special = JSON.parse('{"__proto__":{"type":"string"},"constructor":{"type":"number"},"toString":true}');
  const output = Object.assign(Object.create(null), { type: 'object', properties: special, additional: special });
  const result = dsl.node('write', { name: '写作', agent: 'writer', output, next: 'done' });
  assert.ok(Object.hasOwn(result.output.properties, '__proto__'));
  assert.deepEqual(result.output.properties.__proto__, { type: 'string' });
  assert.equal(Object.getPrototypeOf(result.output.properties), Object.prototype);
  assert.equal(result.output.properties, result.output.additional);
  assert.ok(Object.isFrozen(result.output.properties.__proto__));
  assert.equal(Object.hasOwn(Object.prototype, 'type'), false);
});

test('根选项自身非枚举output和next仍保留，枚举性不改变', () => {
  const output = { type: 'object', properties: { text: { type: 'string' } } };
  const options = { name: '写作', agent: 'writer' };
  Object.defineProperty(options, 'output', { value: output, enumerable: false });
  Object.defineProperty(options, 'next', { value: 'done', enumerable: false });
  const result = dsl.node('write', options);
  assert.equal(Object.hasOwn(result, 'output'), true);
  assert.equal(Object.hasOwn(result, 'next'), true);
  assert.equal(result.next, 'done');
  assert.deepEqual(result.output, output);
  assert.notEqual(result.output, output);
  assert.equal(Object.getOwnPropertyDescriptor(result, 'output').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(result, 'next').enumerable, false);
  assert.ok(Object.isFrozen(result.output));
  assert.equal(Object.isFrozen(options), false);
  assert.equal(Object.isFrozen(output), false);
});

test('缺省字段不在定义阶段填入，显式undefined保留自身键', () => {
  const a = dsl.action('a', { name: '动作', action: 'save' });
  assert.equal(Object.hasOwn(a, 'writes'), false);
  const n = dsl.node('n', { name: '写作', agent: 'a', output: { type: 'object' }, retries: undefined });
  assert.equal(Object.hasOwn(n, 'retries'), true);
  assert.equal(n.retries, undefined);
});

test('非法容器或保留字段明确失败', () => {
  for (const value of [null, [], 'wrong']) assert.throws(() => dsl.defineWorkflow(value), TypeError);
  assert.throws(() => dsl.node(42, {}), TypeError);
  assert.throws(() => dsl.action('a', null), TypeError);
  assert.throws(() => dsl.action('a', { id: 'other' }), TypeError);
  assert.throws(() => dsl.node('a', { type: 'terminal' }), TypeError);
});

test('不执行getter，拒绝循环、函数与非字面数据', () => {
  let reads = 0;
  const getter = { get name() { reads++; return 'x'; } };
  assert.throws(() => dsl.action('a', getter), TypeError);
  assert.equal(reads, 0);
  const cycle = {}; cycle.self = cycle;
  for (const invalid of [cycle, new Date(), { call() {} }, { value: Infinity }, { value: 1n }, { [Symbol()]: 'x' }]) {
    assert.throws(() => dsl.defineWorkflow(invalid), TypeError);
  }
});

test('built DSL and compiler entries are consumable while internal modules stay private', async () => {
  const built = await import('@devcodex/flowkit/dsl');
  assert.equal(built.terminal('ok', { name: '完成', status: 'succeeded' }).type, 'terminal');
  await assert.rejects(import('@devcodex/flowkit/src/shared/contracts.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  assert.deepEqual(Object.keys(await import('@devcodex/flowkit')), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal']);
});
