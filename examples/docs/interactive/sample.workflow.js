import { defineWorkflow, condition, node, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'interactive-guide', version: '1.0.0', name: '受控资料生成', nodes: [
  condition('gate', { name: '资料已批准', branches: [
    { when: 'approved', next: 'draft' }, { when: 'true', next: 'closed' },
  ] }),
  node('draft', { name: '生成资料', skill: 'skills/writer.md', inputs: ['topic'],
    output: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    retries: 1, next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
  terminal('closed', { name: '不派发', status: 'failed' }),
] });
