import type { AgentTaskV2, PreparedAgentTask, AgentExecutionResult, HostPreparationContext, TaskJsonObject } from './index.js';

export interface ApiHostTool {
  name: string;
  description: string;
  parameters: object;
  sideEffect: 'read' | 'write';
  validate(args: unknown): string[];
  execute(args: unknown, context: { signal: AbortSignal; operationId: string; task: AgentTaskV2 }): Promise<unknown>;
  operationKey?(args: unknown, task: AgentTaskV2): string | Promise<string>;
}
export interface ApiHostOptions {
  scope: string;
  model: string;
  request(body: TaskJsonObject, context: { signal: AbortSignal; idempotencyKey: string }): Promise<Response>;
  tools?: ApiHostTool[];
  authorizeTool?(context: { scope: string; task: AgentTaskV2; name: string; args: unknown; signal: AbortSignal }): boolean | Promise<boolean>;
  supportsTools?: boolean;
  requiresTools?(task: PreparedAgentTask): boolean;
  ledger?: Map<string, { fingerprint: string; status: string; output?: string }>;
  retryDelaysMs?: number[];
  limits?: Partial<Record<'maxRequests' | 'maxToolCalls' | 'maxInputBytes' | 'maxOutputBytes' | 'maxToolResultBytes' |
    'maxArgumentBytes' | 'maxOutputTokens' | 'maxTotalTokens' | 'maxLedgerEntries' | 'timeoutMs', number>>;
}
export function createApiAgentAdapter(options: ApiHostOptions): {
  runAgentTask(task: PreparedAgentTask, context?: HostPreparationContext): Promise<AgentExecutionResult>;
};
export interface IndependentAgentBinding {
  artifactHash: string;
  runId: string;
  nodeId: string;
  subjectId: string;
  sessionId: string;
  workspaceRef: string;
  permissionRef: string;
  runAgentTask(task: PreparedAgentTask, context: HostPreparationContext): Promise<AgentExecutionResult>;
  cancel?(): unknown;
}
export interface IndependentAgentOptions {
  scope: string;
  select(request: { scope: string; artifactHash: string; runId: string; nodeId: string; prepared: PreparedAgentTask; signal: AbortSignal }):
    Promise<IndependentAgentBinding>;
  authorize(binding: Omit<IndependentAgentBinding, 'runAgentTask' | 'cancel'> & { scope: string; signal: AbortSignal }): boolean | Promise<boolean>;
  independentFrom?(prepared: PreparedAgentTask): Pick<IndependentAgentBinding, 'subjectId' | 'sessionId' | 'workspaceRef'> | null;
  limits?: { maxConcurrent?: number; maxSessions?: number; timeoutMs?: number };
}
export function createIndependentAgentAdapter(options: IndependentAgentOptions): {
  runAgentTask(task: PreparedAgentTask, context?: HostPreparationContext): Promise<AgentExecutionResult>;
  releaseRun(artifactHash: string, runId: string): void;
  status(): { activeExecutions: number; sessionBindings: number };
};
