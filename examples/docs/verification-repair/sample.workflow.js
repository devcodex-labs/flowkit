import { defineWorkflow, loop, verification, action, terminal } from '@devcodex/flowkit/dsl';
export default defineWorkflow({
  id: 'repair', version: '1.0.0', name: '校验与修复',
  nodes: [
    loop('quality', { name: '有限修复', maxIterations: 3, body: 'check', onSuccess: 'done', onMaxExceeded: 'failed' }),
    verification('check', { name: '检查分数', verifier: 'score', onSuccess: 'quality', onFailure: 'repair' }),
    action('repair', { name: '提高分数', action: 'improve', writes: ['score'], next: 'check' }),
    terminal('done', { name: '质量达标', status: 'succeeded' }),
    terminal('failed', { name: '次数耗尽', status: 'failed' }),
  ],
});
