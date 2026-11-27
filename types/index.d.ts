/** Public SDK contracts. */
import type { DescriptionRef, ObjectSchema, RequiredSkillRef } from './dsl.js';
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
export interface RunResult extends WorkflowResult {
  /** Internal state for trusted SDK consumers. */
  state: Record<string, unknown>;
  /** Present only on a successful run with a validated output contract. */
  publicOutput?: Record<string, unknown>;
  error?: unknown;
}
export interface CompileResult { code: string; mermaid: string; diagnostics: Diagnostic[] }
export interface GraphSnapshotV1 {
  schemaVersion:1;
  compilerVersion:string;
  mode:string;
  workflowId:string;
  workflowVersion:string;
  name:string;
  entryNodeId:string;
  sourceHash:string;
  artifactHash:string;
  definitionDigest:string;
  graphDigest:string;
  nodes:ReadonlyArray<{id:string;type:string;name:string;sourcePath:string;line:number;column:number;
    ownerIds:readonly string[];inputs:ReadonlyArray<{key:string;source:'declared'|'inferred'|'conditional'|'unknown'}>;
    outputs:readonly string[];capabilityId?:string;effect?:string;status?:string;maxIterations?:number;
    maxRevisions?:number;retries?:number}>;
  referenceEdges:readonly GraphSnapshotEdge[];
  executionEdges:readonly GraphSnapshotEdge[];
  regions:ReadonlyArray<{ownerId:string;kind:string;entry:string;memberIds:readonly string[];
    normalExits:readonly string[];branchMode?:'leaf'|'subflow';joinStrategy?:'any'|'all_succeeded';
    lanes?:ReadonlyArray<{entry:string;memberIds:readonly string[]}>}>;
  helpers:ReadonlyArray<{kind:'parallel-start'|'parallel-join';ownerId:string}>;
  contract?:{validator:string;digest:string;input?:Readonly<Record<string,unknown>>;
    output?:Readonly<Record<string,unknown>>;outputKeys?:readonly string[]};
}
export interface GraphSnapshotEdge {
  edgeId:string;from:string;to:string;role:string;sourcePath:string;origin:'declared'|'derived';
  condition?:string;priority?:number;
}
export interface Ctx { runtime: Runtime; state: Record<string, unknown>; signal?: AbortSignal; runId?: string; error?: unknown }
export interface AgentStep {
  id: string; name: string; instruction: string;
  activationId: string; requestId: string;
  input: Record<string, unknown>; missing: string[]; resultSchema: ObjectSchema;
  attempt: number; reasons: string[]; overview?: { step: number }; signal?: AbortSignal; runId?: string;
}
export type TaskJsonValue = null | boolean | number | string | readonly TaskJsonValue[] | TaskJsonObject;
export interface TaskJsonObject { readonly [key: string]: TaskJsonValue }
export interface AgentTaskV2 {
  readonly protocolVersion: 2;
  readonly workflow: { readonly id: string; readonly version: string; readonly artifactHash: string;
    readonly programAbiVersion: number; readonly semanticsVersion: string; readonly compilerVersion: string;
    readonly implementedStage?: 'P0-A'|'P0-B'|'P1'|'P2' };
  readonly run: { readonly runId: string };
  readonly node: { readonly id: string; readonly name: string };
  readonly task: { readonly description?: string | readonly string[]; readonly descriptionRefs?: readonly DescriptionRef[];
    readonly requiredSkills?: readonly RequiredSkillRef[] };
  readonly input: TaskJsonObject;
  readonly missing: readonly string[];
  readonly outputSchema: ObjectSchema;
  readonly execution: { readonly activationId: string; readonly requestId: string; readonly attempt: number;
    readonly reasons: readonly string[]; readonly deadlineMs?: number; readonly overviewStep?: number };
}
export interface DescriptionResource { readonly uri: string; readonly role: 'instruction' | 'reference' | 'evidence';
  readonly content: string; readonly byteLength: number; readonly digest: string }
export interface PreparedSkill { readonly logicalId: string; readonly resolvedVersion: string; readonly digest: string;
  readonly providerRef?: string; readonly source?: string; readonly files?: Readonly<Record<string, string>> }
export interface TaskPreparation {
  readonly protocolVersion: 2;
  readonly task: AgentTaskV2;
  readonly descriptionResources: readonly DescriptionResource[];
  readonly skills: readonly PreparedSkill[];
}
export interface ResourceManifest {
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly resources: readonly { readonly logicalId: string; readonly digest: string; readonly resolvedVersion?: string;
    readonly role?: DescriptionResource['role']; readonly byteLength?: number; readonly source?: string }[];
}
export interface PreparedAgentTask extends TaskPreparation { readonly resourceManifest: ResourceManifest }
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';
export interface HostCapabilityProfile {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly hostVersion: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly executionModes: readonly import('./author-host.js').AuthorExecutionMode[];
  readonly capabilities: Readonly<Partial<Record<'modelExecution' | 'toolCalling' | 'nativeSkillDiscovery' |
    'skillResourceLoading' | 'fileAccess' | 'terminalExecution' | 'networkAccess' | 'durableResume' |
    'humanApproval' | 'trustedReceipt', CapabilitySupport>>>;
  readonly resourceLimits?: { readonly maxTaskBytes?: number; readonly maxResourceBytes?: number };
}
export interface TaskPolicy {
  projectRoot?: string;
  hostProfile?: HostCapabilityProfile;
  authorizationContextRef?: string;
  deadlineMs?: number;
  activityTimeoutMs?: number;
  maxDispatches?: number;
  maxProviderRequests?: number;
  maxResourceBytes?: number;
  maxTotalResourceBytes?: number;
  maxTaskBytes?: number;
  fetch?: typeof fetch;
  authorizeRemote?(url: string, signal: AbortSignal): boolean | Promise<boolean>;
  isImmutableResource?(url: string): boolean | Promise<boolean>;
  authorizeRetry?(request: { readonly task: AgentTaskV2; readonly envelope: AgentExecutionResult;
    readonly reasons: readonly string[]; readonly signal: AbortSignal }): boolean | Promise<boolean>;
}
export interface HostPreparationContext {
  readonly signal: AbortSignal;
  readonly deadlineMs?: number;
  readonly projectRoot?: string;
  readonly hostProfile?: HostCapabilityProfile;
  readonly authorizationContextRef?: string;
  readonly descriptionResources: readonly DescriptionResource[];
  readonly budget: { readonly deadlineMs?: number; readonly maxResourceBytes: number;
    readonly maxTotalResourceBytes: number; readonly maxTaskBytes: number; check(): void;
    dispatch(reservation?:{operationId:string}): void | Promise<unknown>;
    dispatchProvider?(reservation:{operationId:string}): void | Promise<unknown> };
}
export type SideEffectStatus = 'none' | 'known' | 'unknown';
type TokenCoverage = 'known' | 'partial' | 'unknown';
type TaskUsageObservation = TaskJsonObject & {
  readonly tokenCoverage?: Readonly<Record<'inputTokens' | 'outputTokens' | 'cachedInputTokens', TokenCoverage>>;
};
interface ExecutionObservations { readonly events: readonly TaskJsonObject[]; readonly usage?: TaskUsageObservation }
export type AgentExecutionResult = ExecutionObservations & (
  { readonly status: 'succeeded'; readonly result: TaskJsonObject; readonly sideEffectStatus?: SideEffectStatus } |
  { readonly status: 'failed'; readonly failure: { readonly code: string; readonly message: string;
    readonly retryable: boolean; readonly sideEffectStatus: SideEffectStatus } } |
  { readonly status: 'cancelled'; readonly reason: string; readonly sideEffectStatus: SideEffectStatus }
);
export interface Runtime {
  /** 业务方法只在对应节点出现时需要；isControlSignal始终必需。 */
  runAgent?(step: AgentStep): Promise<Record<string, unknown>>;
  authorizeLegacyRetry?(request: { runId?: string; nodeId: string; step: number; attempt: number;
    activationId: string; requestId: string;
    reasons: readonly string[]; signal?: AbortSignal }):
    { authorized: boolean; sideEffectStatus: SideEffectStatus } |
    Promise<{ authorized: boolean; sideEffectStatus: SideEffectStatus }>;
  taskPolicy?: TaskPolicy;
  prepareAgentTask?(task: AgentTaskV2, context: HostPreparationContext): Promise<TaskPreparation>;
  runAgentTask?(task: PreparedAgentTask, context: HostPreparationContext): Promise<AgentExecutionResult>;
  recordAgentResult?(task: AgentTaskV2, result: AgentExecutionResult): void;
  validateResult?(schema: ObjectSchema, result: Record<string, unknown>): string[];
  checkStep?(step: { id: string; name: string; attempt: number }, result: Record<string, unknown>, ctx: Ctx): Promise<string | null | undefined>;
  runHuman?(name: string, ctx: Ctx): Promise<boolean | InteractiveHumanDecision>;
  runVerification?(verifier: string, name: string, ctx: Ctx): Promise<boolean>;
  runAction?(action: string, name: string, ctx: Ctx): Promise<void>;
  loadSkill?(path: string, options?: { integrity?: string }): Promise<string>;
  loadSkillByAgent?(agent: string): Promise<string>;
  evalWhen?(ctx: Ctx, when: string): boolean;
  isControlSignal(err: unknown): boolean;
  trace?: { start(nodeId: string, name: string): void; end(nodeId: string, name: string, outcome: 'ok' | 'error' | 'control'): void };
}
export type InteractiveHumanDecision={decision:'approve'|'revise'|'decline';comment?:string|null}
  | {approved:boolean;comment?:string|null};
export declare function run(file: string, runtime: Runtime, state?: Record<string, unknown>, options?: FlowkitOptions): Promise<RunResult>;
export declare function runArtifact(file: string, expectedHash: string, runtime: Runtime, state?: Record<string, unknown>, options?: FlowkitOptions): Promise<RunResult>;
export declare function compile(file: string, options?: FlowkitOptions): Promise<CompileResult>;
export declare function compileSource(text: string, options: FlowkitOptions & { filename: string }): Promise<CompileResult>;
export declare function compileArtifact(file: string, options?: FlowkitOptions): Promise<CompileResult & { artifactHash: string | null; graphSnapshot?:GraphSnapshotV1 }>;
export declare function check(file: string, options?: FlowkitOptions): Promise<Diagnostic[]>;
export declare function evalWhen(ctx: Ctx, when: string): boolean;
export declare function isControlSignal(err: unknown): boolean;
