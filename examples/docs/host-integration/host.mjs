import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(new URL('./sample.workflow.js', import.meta.url));
export async function scenario() {
  const events = [];
  const runtime = {
    isControlSignal,
    async runAgent(step) {
      events.push({ event: 'agent', input: step.input, missing: step.missing, attempt: step.attempt });
      // 确定性演示；真实模型接入放在这里，必须返回对象。
      return { draft: `${step.input.topic}：先运行最小例，再接入自己的业务。` };
    },
    validateResult(schema, value) {
      events.push({ event: 'validate' });
      // 仅验证本例的 Schema；不是完整 JSON Schema 实现。
      return value && typeof value === 'object' && !Array.isArray(value) && typeof value.draft === 'string' && Object.keys(value).length === 1 ? [] : ['需要且仅允许 draft 字符串'];
    },
    async checkStep(step, result, ctx) { events.push({ event: 'checkStep', committed: Object.hasOwn(ctx.state, 'draft') }); return null; },
    async runVerification(verifier, name, ctx) { events.push({ event: 'verify', candidate: ctx.state.draft }); return ctx.state.draft.length > 0; },
    async runHuman(name, ctx) { events.push({ event: 'human', draft: ctx.state.draft }); return { approved: true, comment: '可以交付' }; },
    async runAction(action, name, ctx) { ctx.state.draft += '（已修订）'; },
  };
  const result = await run(file, runtime, { topic: 'FlowKit 入门' });
  return { result, events };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(), null, 2));
