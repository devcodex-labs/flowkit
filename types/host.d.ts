import type { AgentTaskV2, PreparedAgentTask, AgentExecutionResult, HostPreparationContext, TaskJsonObject, FlowkitOptions, Runtime, RunResult } from './index.js';
import type { InteractiveFrameV1, InteractiveOperationController, InteractiveOptionsV1, InteractiveRuntimeV1, TrustedHostContextV1 } from './interactive.js';
import type { AuthorCandidate, AuthorProfessionalSkill } from './author-host.js';
export { createWorkflowAuthorHost } from './author-host.js';
export type { AuthorHostOptions, WorkflowAuthorHost, AuthorRequestContext, AuthorDraftView, AuthorTurnInput, AuthorCandidate, AuthorBudgetPolicy, AuthorReviewRejection } from './author-host.js';

export interface ApprovedWorkflowTarget { collectionId: string; skillId: string; candidateHash: string; skillDirectory: string; executionRef: string }
export interface ApprovedWorkflowScope {
  collectionId: string; skillId: string; candidateHash: string; executionRef: string; workflowFile: string; artifactHash: string;
}
export interface ApprovedWorkflowStore {
  readVersion(collectionId: string, skillId: string, hash: string): Pick<AuthorCandidate, 'hash' | 'files'> &
    { manifest: Pick<AuthorCandidate['manifest'], 'collectionId' | 'skillId' | 'version'> } | null;
  readProfessionalVersion?(collectionId: string, skillId: string, version: string): AuthorProfessionalSkill | null;
}
export interface ApprovedWorkflowHostAuthority {
  hostProfile: { id: string; digest: string };
  authorizeExecution(scope: ApprovedWorkflowScope): boolean | Promise<boolean>;
  resolveRunProfessionalSkill?(pin: { nodeId: string; id: string; version: string; digest: string; source: string },
    scope: ApprovedWorkflowScope & { signal?: AbortSignal }): { authorized: boolean; source: string; candidate: AuthorProfessionalSkill } | null |
    Promise<{ authorized: boolean; source: string; candidate: AuthorProfessionalSkill } | null>;
}
export function runApprovedCollectionWorkflow(store: ApprovedWorkflowStore, target: ApprovedWorkflowTarget,
  host: ApprovedWorkflowHostAuthority & { runtime: Runtime }, state?: Record<string, unknown>, options?: FlowkitOptions): Promise<RunResult>;
export function runApprovedCollectionWorkflow(store: ApprovedWorkflowStore, target: ApprovedWorkflowTarget,
  host: ApprovedWorkflowHostAuthority & { runtime: InteractiveRuntimeV1; interactive: InteractiveOptionsV1 & { startKey: string } },
  state?: Record<string, unknown>, options?: FlowkitOptions): Promise<InteractiveFrameV1>;
/** Recreate the approved runtime and policy before resuming or completing an Interactive Run. */
export function bindApprovedInteractiveWorkflow(store: ApprovedWorkflowStore, target: ApprovedWorkflowTarget,
  host: ApprovedWorkflowHostAuthority & { runtime: InteractiveRuntimeV1; interactive: InteractiveOptionsV1 }):
  Promise<{ runtime: InteractiveRuntimeV1; options: InteractiveOptionsV1 }>;
export interface CompilationCacheLimits {maxEntries:number;maxBytes:number;ttlMs:number;maxModuleIdentities:number;maxModuleBytes:number}
export interface CompilationCacheStatus extends CompilationCacheLimits {
  entries:number;bytes:number;residentModuleIdentities:number;residentModuleBytes:number;hits:number;misses:number;evictions:number;
}
export function configureCompilationCache(options:Partial<CompilationCacheLimits>):CompilationCacheStatus;
export function clearCompilationCache():CompilationCacheStatus;
export function compilationCacheStatus():CompilationCacheStatus;
export function releaseToolReceipts(ledger:NonNullable<ApiHostOptions['ledger']>,identity:{scope:string;runId:string}):{removed:number;remaining:number};

export interface ApiHostTool {
  name: string;
  description: string;
  parameters: object;
  sideEffect: 'read' | 'write';
  validate(args: unknown): string[];
  execute(args: unknown, context: { signal: AbortSignal; operationId: string; task: AgentTaskV2 }): Promise<unknown>;
  operationKey?(args: unknown, task: AgentTaskV2): string | Promise<string>;
  compensationPlan?(args:unknown,task:AgentTaskV2):
    {capabilityId:string;inputHash:string}|Promise<{capabilityId:string;inputHash:string}>;
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
  runAgentTask(task: PreparedAgentTask, context?: HostPreparationContext & {
    interactiveOperations?: {controller:InteractiveOperationController;auth:TrustedHostContextV1};
  }): Promise<AgentExecutionResult>;
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
