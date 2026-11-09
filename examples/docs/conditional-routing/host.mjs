import { run, evalWhen, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(urgent = false, extension = 'js') {
  const file = fileURLToPath(new URL(`./sample.workflow.${extension}`, import.meta.url));
  return run(file, { isControlSignal, evalWhen, async runAction(action, name, ctx) { ctx.state.route = action; } }, { urgent });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] === 'urgent', process.argv[3] ?? 'js'), null, 2));
