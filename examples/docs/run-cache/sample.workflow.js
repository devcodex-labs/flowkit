import { defineWorkflow, node, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'cache-demo', version: '1.0.0', name: '重复运行', nodes: [
  node('answer', { name: '读取指令', skill: 'skills/instruction.md', inputs: ['count'], output: { type: 'object', properties: { count: { type: 'number' }, instruction: { type: 'string' } }, required: ['count', 'instruction'] }, retries: 0, next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
