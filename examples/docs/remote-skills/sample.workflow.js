import { defineWorkflow, node, terminal } from '@devcodex/flowkit/dsl';
export default defineWorkflow({ id: 'remote-skills', version: '1.0.0', name: '远程 Skill', nodes: [
  node('first', { name: '第一次建议', skill: 'https://skills.example.test/advice.md', integrity: 'sha256-O0rz52STZdJhvL/QvjjU8DTwd/MoUiHJl8lHGwEHUf4=', output: { type: 'object', properties: { advice: { type: 'string' } }, required: ['advice'] }, next: 'second' }),
  node('second', { name: '再次建议', skill: 'https://skills.example.test/advice.md', integrity: 'sha256-O0rz52STZdJhvL/QvjjU8DTwd/MoUiHJl8lHGwEHUf4=', output: { type: 'object', properties: { advice: { type: 'string' } }, required: ['advice'] }, next: 'done' }),
  terminal('done', { name: '完成', status: 'succeeded' }),
] });
