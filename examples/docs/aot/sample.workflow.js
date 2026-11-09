import { defineWorkflow, node, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'aot-demo', version: '1.0.0', name: '完整部署', nodes: [
  node('draft', { name: '读取本地指令', skill: 'skills/writer.md', output: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'] }, next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
