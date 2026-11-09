import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(strategy = 'all', reject = false) {
  const events = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = {
    isControlSignal,
    async runVerification() { events.push('fast:false'); return false; },
    async runAction(action, name, ctx) { await gate; if (reject) throw new Error('慢分支失败'); ctx.state.slowDone = true; events.push('slow:done'); },
  };
  const pending = run(fileURLToPath(new URL(`./${strategy}.workflow.js`, import.meta.url)), runtime, {});
  if (strategy === 'all') release();
  let result;
  try { result = await pending; }
  finally { if (strategy === 'any') release(); }
  const atJoin = events.slice();
  // 等待后台分支释放后结束，避免演示进程过早退出。FlowKit不会取消该分支。
  await new Promise(resolve => setTimeout(resolve, 20));
  return { result, atJoin, events };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] ?? 'all', process.argv[3] === 'reject'), null, 2));
