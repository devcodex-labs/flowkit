import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'sdk-options', version: '1.0.0', name: 'SDK 与选项', nodes: [
  action('save', { name: '保存结果', action: 'save', writes: ['saved'], next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
