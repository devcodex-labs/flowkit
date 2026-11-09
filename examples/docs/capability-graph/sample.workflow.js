import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';

export default defineWorkflow({
  id: 'graph-backed-action', version: '1.0.0', name: '能力图谱约束动作执行',
  nodes: [
    action('greet', { name: '执行受控问候', action: 'greet', writes: ['message'], next: 'done' }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
