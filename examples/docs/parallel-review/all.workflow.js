import { defineWorkflow, parallel, action, verification, terminal } from '@devcodex/flowkit/dsl';
export default defineWorkflow({
  id: 'parallel-all', version: '1.0.0', name: '等待所有检查',
  nodes: [
    parallel('reviews', { name: '并行检查', branches: ['fast', 'slow'], join: { strategy: 'all_succeeded', next: 'done' } }),
    verification('fast', { name: '快速检查', verifier: 'check' }),
    action('slow', { name: '较慢处理', action: 'slow', writes: ['slowDone'] }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
