import { defineWorkflow, node, action, human, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({
  id: 'host-integration', version: '1.0.0', name: '接入宿主',
  nodes: [
    node('draft', { name: '生成草稿', skill: 'skills/writer.md', inputs: ['topic'],
      output: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'], additionalProperties: false },
      verify: 'nonempty', retries: 1, next: 'approval' }),
    human('approval', { name: '审批草稿', onApprove: 'done', onReject: 'revise' }),
    action('revise', { name: '根据反馈修订', action: 'revise', writes: ['draft'], next: 'approval' }),
    terminal('done', { name: '交付', status: 'succeeded' }),
  ],
});
