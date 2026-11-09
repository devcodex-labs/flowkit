import { defineWorkflow, parallel, action, verification, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({
  id: 'parallel-any', version: '1.0.0', name: '等待一个完成',
  nodes: [
    parallel('reviews', { name: '并行检查', branches: ['fast', 'slow'], join: { strategy: 'any', next: 'done' } }),
    verification('fast', { name: '快速检查', verifier: 'check' }),
    action('slow', { name: '较慢处理', action: 'slow', writes: ['slowDone'] }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
