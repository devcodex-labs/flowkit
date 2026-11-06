import { defineWorkflow, action, terminal } from '@devcodex/flowkit/dsl';

export default defineWorkflow({
  id: 'hello-flowkit', version: '1.0.0', name: '第一个工作流',
  nodes: [
    action('greet', { name: '生成问候', action: 'greet', writes: ['message'], next: 'done' }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
