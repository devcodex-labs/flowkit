import { run, isControlSignal } from '@devcodex/flowkit';
import { fileURLToPath } from 'node:url';

const runtime = {
  isControlSignal,
  async runAction(action, name, ctx) {
    if (action !== 'greet') throw new Error(`未实现的动作：${action}`);
    ctx.state.message = `你好，${ctx.state.name}！`;
  },
};
const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), runtime, { name: 'FlowKit' });
console.log(JSON.stringify(result, null, 2));
