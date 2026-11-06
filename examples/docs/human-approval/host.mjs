import { run, isControlSignal } from '@devcodex/flowkit';
import { fileURLToPath } from 'node:url';
export async function scenario(decisions = [false, true]) {
  const events = []; let cursor = 0;
  const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), {
    isControlSignal,
    async runAction(action, name, ctx) {
      if (action === 'draft') ctx.state.draft = '第一版';
      else { events.push({ feedback: ctx.state.approval.comment }); ctx.state.draft += '，已补充说明'; }
    },
    async runHuman(name, ctx) {
      if (cursor >= decisions.length) throw new Error('演示决策序列已用尽');
      const approved = decisions[cursor++];
      const decision = { approved, comment: approved ? '通过' : '请补充说明' };
      events.push({ draft: ctx.state.draft, ...decision }); return decision;
    },
  });
  return { result, events };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] === 'approve' ? [true] : [false, true]), null, 2));
