import { defineWorkflow, action, terminal } from '@devcodex/flowkit/dsl';
export default defineWorkflow({ id: 'cancel-demo', version: '1.0.0', name: '取消操作', nodes: [
  action('work', { name: '等待业务结果', action: 'wait', next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
