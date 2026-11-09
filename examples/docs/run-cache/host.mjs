import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export const file = fileURLToPath(new URL('./sample.workflow.js', import.meta.url));
export const runtime = {
  isControlSignal,
  async runAgent(step) { return { count: step.input.count + 1, instruction: step.instruction.trim() }; },
  validateResult(schema, value) { return typeof value?.count === 'number' && typeof value?.instruction === 'string' ? [] : ['count/instruction 类型错误']; },
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const initial = { count: 0 }, first = await run(file, runtime, initial), second = await run(file, runtime, initial);
  console.log(JSON.stringify({ first, second, initial }, null, 2));
}
