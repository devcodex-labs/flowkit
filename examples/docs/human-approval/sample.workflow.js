import { defineWorkflow, action, human, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'approval', version: '1.0.0', name: '审批与修订', nodes: [
  action('draft', { name: '准备稿件', action: 'draft', writes: ['draft'], next: 'approval' }),
  human('approval', { name: '批准稿件', onApprove: 'done', onReject: 'revise' }),
  action('revise', { name: '根据反馈修订', action: 'revise', writes: ['draft'], next: 'approval' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
