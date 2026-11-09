import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(target = 1, file = 'sample.workflow.js') {
  const events = [];
  const result = await run(fileURLToPath(new URL(file, import.meta.url)), {
    isControlSignal,
    async runVerification(verifier, name, ctx) { events.push(`check:${ctx.state.score}`); return ctx.state.score >= target; },
    async runAction(action, name, ctx) { ctx.state.score += 1; events.push(`repair:${ctx.state.score}`); },
  }, { score: 0 });
  return { result, events };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] === 'exhaust' ? 9 : 1), null, 2));
