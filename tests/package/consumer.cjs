const assert = require('node:assert/strict');
(async () => {
  const api = await import('@devcodex-labs/flowkit');
  const dsl = await import('@devcodex-labs/flowkit/dsl');
  assert.equal(Object.keys(api).length, 6); assert.equal(Object.keys(dsl).length, 9);
  assert.deepEqual(await api.check('sample.workflow.ts', { trace: true, mermaid: false }), []);
  assert.equal((await api.run('sample.compiled.mjs', { isControlSignal: api.isControlSignal, runAgent: async () => ({}), validateResult: () => [], runAction: async () => {} })).terminal, 'done');
})().catch(error => { console.error(error); process.exitCode = 1; });
