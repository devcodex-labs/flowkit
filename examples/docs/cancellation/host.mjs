import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(mode = 'cancel') {
  const controller = new AbortController(); let cleaned = false;
  try {
    const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), {
      isControlSignal,
      async runAction(action, name, ctx) {
        if (mode === 'error') throw new Error('业务服务失败');
        if (mode === 'ok') return;
        await new Promise((resolve, reject) => {
          const stop = () => { ctx.signal.removeEventListener('abort', stop); cleaned = true; reject(Object.assign(new Error('用户取消'), { control: true, kind: 'cancel' })); };
          ctx.signal.addEventListener('abort', stop, { once: true });
          controller.abort();
        });
      },
    }, {}, { signal: controller.signal });
    return { status: result.status, cleaned };
  } catch (error) { return { status: isControlSignal(error) ? 'cancelled' : 'error', message: error.message, cleaned }; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] ?? 'cancel'), null, 2));
