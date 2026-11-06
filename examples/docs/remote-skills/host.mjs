import { run, isControlSignal } from '@devcodex/flowkit';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function scenario(mode = 'ok') {
  let requests = 0;
  const bytes = await readFile(new URL('./skill.md', import.meta.url));
  const runtime = {
    isControlSignal,
    async runAgent(step) { return { advice: `已读取指令：${step.instruction.trim()}` }; },
    validateResult(schema, value) { return typeof value?.advice === 'string' ? [] : ['advice 必须是字符串']; },
  };
  const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), runtime, {}, {
    remoteSkillHosts: mode === 'blocked' ? [] : ['skills.example.test'],
    async fetch(url, init) {
      requests += 1;
      // 固定响应演示，无真实网络请求。生产中移除此选项以使用默认 fetch。
      return new Response(mode === 'tampered' ? '被修改的内容' : bytes, { status: 200 });
    },
  });
  return { result, requests };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] ?? 'ok'), null, 2));
