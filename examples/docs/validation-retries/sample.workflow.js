import { defineWorkflow, action, node, terminal } from '@devcodex/flowkit/dsl';
export default defineWorkflow({ id: 'retries', version: '1.0.0', name: '结果纠正', nodes: [
  action('observe', { name: '观察运行状态', action: 'observe', next: 'answer' }),
  node('answer', { name: '生成结果', skill: 'skills/result.md', output: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
