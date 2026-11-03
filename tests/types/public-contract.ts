import type { FlowkitOptions, Runtime, AgentStep, Ctx, RunResult, Diagnostic } from '../../types/index.js';
import type * as Public from '../../types/index.js';
const keys: Record<keyof FlowkitOptions, true> = { projectRoot: true, outDir: true, skillsRoot: true, skillCheck: true, remoteSkillHosts: true, trace: true, mermaid: true, fetch: true, signal: true, runId: true, dump: true };
const options: FlowkitOptions = { fetch, signal: new AbortController().signal, remoteSkillHosts: ['example.com:443'] };
declare const api: typeof Public;
declare const runtime: Runtime & Required<Pick<Runtime, 'runAgent' | 'validateResult' | 'evalWhen'>>;
const terminalOnlyRuntime: Runtime = { isControlSignal: () => false };
const agentOnlyRuntime: Runtime = {
  runAgent: async () => ({}), validateResult: () => [],
  evalWhen: () => false, isControlSignal: () => false,
};
const result: Promise<RunResult> = api.run('x.workflow.ts', runtime, {}, options);
const diagnostic: Promise<Diagnostic[]> = api.check('x.workflow.ts');
const compiled: Promise<{ code: string; mermaid: string; diagnostics: Diagnostic[] }> = api.compileSource('', { filename: 'x.workflow.ts' });
declare const step: AgentStep;
const first: Promise<Record<string, unknown>> = runtime.runAgent(step);
const issues: string[] = runtime.validateResult(step.resultSchema, {});
declare const ctx: Ctx;
const boolean: boolean = runtime.evalWhen(ctx, 'true');
void [keys, result, diagnostic, compiled, first, issues, boolean, terminalOnlyRuntime, agentOnlyRuntime];
// @ts-expect-error isControlSignal始终必需
const missingControlSignal: Runtime = {};
// @ts-expect-error compileSource必须filename
api.compileSource('', {});
// @ts-expect-error 未知选项不能进入公共类型
api.compile('x', { encoding: 'utf8' });
// @ts-expect-error null不是合法布尔
api.run('x', runtime, {}, { trace: null });
// @ts-expect-error validateResult保持同步
const badValidator: NonNullable<Runtime['validateResult']> = async () => [];
// @ts-expect-error verification必须严格布尔
const badVerification: NonNullable<Runtime['runVerification']> = async () => 'yes';
