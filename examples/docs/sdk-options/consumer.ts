import type { Runtime, RunResult, FlowkitOptions, AgentStep, Diagnostic, Ctx } from '@devcodex-labs/flowkit';
import { run, isControlSignal } from '@devcodex-labs/flowkit';
const runtime: Runtime = { isControlSignal, async runAction(action, name, ctx) { ctx.state.saved = true; } };
const options: FlowkitOptions = { trace: true, runId: 'typed-run' };
const result: RunResult = await run('sample.workflow.js', runtime, {}, options);
console.log(result.status);
// 这些类型可以用于你的适配器签名，不要求导入任何内部文件。
export type AdapterContext = { step: AgentStep; diagnostics: Diagnostic[]; ctx: Ctx };
