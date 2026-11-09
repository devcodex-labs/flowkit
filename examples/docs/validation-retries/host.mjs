import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(exhaust = false) {
  const attempts = [], initial = {};
  let observedState;
  try {
    const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), {
      isControlSignal,
      async runAction(action, name, ctx) { observedState = ctx.state; },
      async runAgent(step) { attempts.push({ attempt: step.attempt, reasons: step.reasons, stateBefore: { ...observedState } }); return exhaust || step.attempt === 1 ? { answer: 42 } : { answer: '已修正' }; },
      validateResult(schema, value) { return typeof value?.answer === 'string' ? [] : ['answer 必须是字符串']; },
    }, initial);
    return { result, attempts, initial, stateAtEnd: { ...observedState } };
  } catch (error) { return { error: { code: error.code, reasons: error.reasons }, attempts, initial, stateAtEnd: { ...observedState } }; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] === 'exhaust'), null, 2));
