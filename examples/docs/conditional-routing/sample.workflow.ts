import { defineWorkflow, condition, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({
  id: 'routing', version: '1.0.0', name: '条件分流',
  nodes: [
    condition('choose', { name: '选择处理路径', branches: [{ when: 'urgent', next: 'fast' }, { when: 'true', next: 'normal' }] }),
    action('fast', { name: '加急处理', action: 'fast', writes: ['route'], next: 'done' }),
    action('normal', { name: '普通处理', action: 'normal', writes: ['route'], next: 'done' }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
} as const);
