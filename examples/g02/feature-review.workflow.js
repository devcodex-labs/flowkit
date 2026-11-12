import { defineWorkflow, condition, node, terminal } from '@devcodex-labs/flowkit/dsl';

export default defineWorkflow({
  id: 'g02-feature-review',
  version: '1.0.0',
  name: '功能变更评审闭环',
  nodes: [
    condition('gate', {
      name: '检查材料是否齐全',
      branches: [
        { when: 'materialsReady', next: 'analyze' },
        { when: 'true', next: 'rejected' },
      ],
    }),
    node('analyze', {
      name: '需求分析',
      agent: 'analyze',
      inputs: ['request'],
      output: {
        type: 'object',
        properties: { requirementSummary: { type: 'string' } },
        required: ['requirementSummary'],
        additionalProperties: false,
      },
      retries: 0,
      next: 'design',
    }),
    node('design', {
      name: '技术设计',
      agent: 'design',
      inputs: ['requirementSummary'],
      output: {
        type: 'object',
        properties: { designSummary: { type: 'string' } },
        required: ['designSummary'],
        additionalProperties: false,
      },
      retries: 0,
      next: 'review',
    }),
    node('review', {
      name: '独立评审',
      agent: 'review',
      inputs: ['requirementSummary', 'designSummary'],
      output: {
        type: 'object',
        properties: {
          reviewApproved: { type: 'boolean' },
          reviewNotes: { type: 'string' },
        },
        required: ['reviewApproved', 'reviewNotes'],
        additionalProperties: false,
      },
      retries: 1,
      next: 'decide',
    }),
    condition('decide', {
      name: '根据评审结论分流',
      branches: [
        { when: 'reviewApproved', next: 'accepted' },
        { when: 'true', next: 'rejected' },
      ],
    }),
    terminal('accepted', { name: '评审通过', status: 'succeeded' }),
    terminal('rejected', { name: '评审未通过或材料不齐', status: 'failed' }),
  ],
});
