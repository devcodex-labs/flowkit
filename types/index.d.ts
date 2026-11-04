/** Full confirmed SDK contract; the package entry selects only implemented functions for this batch. */
import type { ObjectSchema } from './dsl.js';
export interface FlowkitOptions {
  projectRoot?: string;
  outDir?: string;
  skillsRoot?: string;
  skillCheck?: boolean;
  remoteSkillHosts?: string[];
  trace?: boolean;
  mermaid?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  runId?: string;
  dump?: string;
}
export interface Diagnostic {
  code: string | null;
  message: string;
  nodeId?: string;
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
}
export interface WorkflowResult { status: 'succeeded' | 'failed'; terminal: string }
export interface RunResult extends WorkflowResult { state: Record<string, unknown>; error?: unknown }
export interface CompileResult { code: string; mermaid: string; diagnostics: Diagnostic[] }
export interface Ctx { runtime: Runtime; state: Record<string, unknown>; signal?: AbortSignal; runId?: string; error?: unknown }
export interface AgentStep {
  id: string; name: string; instruction: string;
  input: Record<string, unknown>; missing: string[]; resultSchema: ObjectSchema;
  attempt: number; reasons: string[]; overview?: { step: number }; signal?: AbortSignal; runId?: string;
}
export interface Runtime {
  /** 业务方法只在对应节点出现时需要；isControlSignal始终必需。 */
  runAgent?(step: AgentStep): Promise<Record<string, unknown>>;
  validateResult?(schema: ObjectSchema, result: Record<string, unknown>): string[];
  checkStep?(step: { id: string; name: string; attempt: number }, result: Record<string, unknown>, ctx: Ctx): Promise<string | null | undefined>;
  runHuman?(name: string, ctx: Ctx): Promise<boolean | { approved: boolean; comment?: string | null }>;
  runVerification?(verifier: string, name: string, ctx: Ctx): Promise<boolean>;
  runAction?(action: string, name: string, ctx: Ctx): Promise<void>;
  loadSkill?(path: string, options?: { integrity?: string }): Promise<string>;
  loadSkillByAgent?(agent: string): Promise<string>;
  evalWhen?(ctx: Ctx, when: string): boolean;
  isControlSignal(err: unknown): boolean;
  trace?: { start(nodeId: string, name: string): void; end(nodeId: string, name: string, outcome: 'ok' | 'error' | 'control'): void };
}
export declare function run(file: string, runtime: Runtime, state?: Record<string, unknown>, options?: FlowkitOptions): Promise<RunResult>;
export declare function compile(file: string, options?: FlowkitOptions): Promise<CompileResult>;
export declare function compileSource(text: string, options: FlowkitOptions & { filename: string }): Promise<CompileResult>;
export declare function check(file: string, options?: FlowkitOptions): Promise<Diagnostic[]>;
export declare function evalWhen(ctx: Ctx, when: string): boolean;
export declare function isControlSignal(err: unknown): boolean;
