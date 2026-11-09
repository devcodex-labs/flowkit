import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
const result = await run(fileURLToPath(new URL('./sample.compiled.mjs', import.meta.url)), {
  isControlSignal,
  async runAgent(step) { return { draft: step.instruction.trim() }; },
  validateResult(schema, value) { return typeof value?.draft === 'string' ? [] : ['draft 必须是字符串']; },
});
console.log(JSON.stringify(result, null, 2));
