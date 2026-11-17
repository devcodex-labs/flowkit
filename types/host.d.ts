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
