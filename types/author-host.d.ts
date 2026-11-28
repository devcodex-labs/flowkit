import type { AgentExecutionResult, PreparedAgentTask, HostPreparationContext, Runtime } from './index.js';
import type { FlowkitMcpOptions } from './mcp.js';

export interface AuthorRequestContext {
  namespace: string; principalId: string; sessionId: string; workspaceId: string; authorizedCollections: string[];
  authorizationSnapshotRef: string;
}
export interface AuthorBudgetPolicy {
  durationMs: number; maxRequests: number; maxToolCalls: number; maxIoCalls: number; maxBytes: number; maxResponseBytes: number;
}
export interface AuthorPortContext { signal: AbortSignal; requestContext: AuthorRequestContext; [key: string]: unknown }
export interface AuthorGuardedPorts {
  request(input: unknown, context?: object): Promise<unknown>;
  tool(input: unknown, context: { sideEffect: 'read' | 'write'; toolName: string; operationKey?: string; [key: string]: unknown }): Promise<unknown>;
  io(input: unknown, context?: object): Promise<unknown>;
}
export interface AuthorTarget { skillId?: string; name: string; description: string; version: string }
export type AuthorExecutionMode = 'standard' | 'interactive-p0-a' | 'interactive-p0-b' | 'interactive-p1' | 'interactive-p2';
export interface AuthorChoices { project?: string; collectionName?: string; executionMode?: AuthorExecutionMode; includeSource?: boolean }
export interface AuthorCandidate {
  files: Record<string, string>; hash: string;
  manifest: { collectionId: string; skillId: string; name: string; version: string; artifactHash: string; [key: string]: unknown };
}
export interface AuthorProfessionalSkill {
  files: Record<string, string>; hash: string;
  manifest: { kind: 'professional'; collectionId: string; skillId: string; name: string; version: string; description: string;
    format?: 'codex-native'; digest: string; files: Record<string, string> };
}
export interface AuthorProfessionalCatalogScope {
  requestContext: AuthorRequestContext; signal: AbortSignal;
}
export interface AuthorProfessionalCollection { id: string; name: string; directory: string }
export interface AuthorReviewRejection {
  candidateHash: string;
  findings: Array<{ message: string; nodeIds: string[]; rule?: string }>;
  actions: Array<{ kind: 'review-only' | 'authoring'; candidateHash: string; label: string }>;
}
export interface AuthorDraftView {
  id: string; namespace: string; storeId: string; collectionId: string; stateVersion: number; contentRevision: number; contentHash: string;
  status: string; goal: string; choices: AuthorChoices; questions: Array<{ id: string; question: string; options: unknown[]; recommended: string; customAllowed?: boolean }>;
  candidate?: AuthorCandidate | null; previousHash: string | null;
  reviewReceipt?: { qualified: boolean; reviewRef: string; candidateHash: string; [key: string]: unknown } | null;
  reviewRejection?: AuthorReviewRejection;
  documentProgress?: { sourceIdentity: string; sections: number; extracted: number; merged: number; reviewed: number };
  approvalReceipt?: { approvalRef: string; [key: string]: unknown } | null;
  diagnostics?: Array<{ code?: string; message?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
type HostActionRouteTarget = { kind: 'action'; id: string } | { kind: 'terminal'; status: 'succeeded' | 'failed' };

export type HostExecutionContract = { id: string; version: string; implementationDigest: string;
  roles?: readonly string[]; rules: readonly string[] } & (
  { kind: 'action'; effect: 'read-only' | 'write'; reads: readonly string[]; writes: readonly string[];
    resultRoutes?: { key: string; cases: ReadonlyArray<{ value: string | number | boolean | null;
      settlement?: 'applied' | 'no-effect'; next: HostActionRouteTarget }> };
    noEffectFailureRoute?: HostActionRouteTarget } |
  { kind: 'verification'; effect?: never; reads?: never; writes?: never; resultRoutes?: never; noEffectFailureRoute?: never });

export interface AuthorHostOptions {
  hostExecutionContracts?: readonly HostExecutionContract[];
  namespace: string; storageFile: string; collectionIds: string[];
  hostProfile: { id: string; digest: string; [key: string]: unknown };
  defaults?: AuthorChoices;
  /** Compile the initial Standard Plan from its validated node options. */
  useNodeOptionsForNewDrafts?: boolean;
  budgetPolicy?: Partial<AuthorBudgetPolicy>;
  /** Optional finite budget for material-based turns that dispatch multiple document tasks. */
  documentBudgetPolicy?: Partial<AuthorBudgetPolicy>;
  capacity: { maxPhysicalExecutions: number; maxPendingCandidates?: number; maxDrafts: number; maxDraftBytes: number;
    maxRetainedDraftBytes: number; maxReceiptBytes: number; maxTurnsPerDraft: number };
  retention?: { policyRef: string; idempotencyRetentionMs: number };
  discovery?: {
    root: string;
    readMapping(scope: { namespace: string; collectionId: string; requestContext: AuthorRequestContext; signal?: AbortSignal }): Promise<AuthorDiscoveryMapping | null>;
    compareAndSetMapping(scope: { namespace: string; collectionId: string; requestContext: AuthorRequestContext; signal?: AbortSignal;
      expected: AuthorDiscoveryMapping | null; next: AuthorDiscoveryMapping | null; operationId: string }): Promise<unknown>;
    observeMapping?(scope: { namespace: string; collectionId: string; requestContext: AuthorRequestContext; signal?: AbortSignal;
      mapping: AuthorDiscoveryMapping; files: string[] }): Promise<boolean>;
    /** Host must keep new Run admission closed for this generation through cleanup. */
    readReferences?(scope: { namespace: string; collectionId: string; generationId: string; discoveryRoot: string; requestContext: AuthorRequestContext; signal?: AbortSignal }):
      Promise<{ generationId: string; evidenceRef: string; referenced: boolean; closedForNewRuns: boolean }>;
  };
  execution: {
    request(input: unknown, context: AuthorPortContext): Promise<unknown>;
    tool?(input: unknown, context: AuthorPortContext): Promise<unknown>;
    io?(input: unknown, context: AuthorPortContext): Promise<unknown>;
    createSession(ports: AuthorGuardedPorts, context: { signal: AbortSignal; requestContext: AuthorRequestContext; draftId: string; turnId: string; attemptId: string }):
      Promise<{ intentRuntime: { parse(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> };
        runtime: Pick<Runtime, 'validateResult'> & { runAgentTask(task: PreparedAgentTask, context: HostPreparationContext): Promise<AgentExecutionResult>; [key: string]: unknown } }>;
  };
  authorization: {
    authorize(binding: { action: string; collectionId: string; requestContext: AuthorRequestContext; signal?: AbortSignal; [key: string]: unknown }): boolean | Promise<boolean>;
    observeReview(binding: { task: unknown; result: unknown; requestContext: AuthorRequestContext; [key: string]: unknown }):
      Promise<{ passed: boolean; subjectId: string; executionId: string; requestId?: string; authorSubjectId?: string;
        sessionId?: string; authorSessionId?: string; workspaceId?: string; authorWorkspaceId?: string }>;
    verifyApproval(binding: { approvalRef: string; candidateHash?: string; requestContext: AuthorRequestContext; [key: string]: unknown }):
      Promise<{ approved: boolean; subjectId: string; approvalId: string }>;
    verifySettlement?(binding: { draftId: string; turnId: string; attemptId: string; evidenceRef: string; resultHash: string | null; [key: string]: unknown }):
      Promise<{ verified: boolean; draftId: string; turnId: string; attemptId: string; evidenceRef: string;
        physicalDone: boolean; noEffect?: boolean; resultHash?: string | null }>;
    verifySafetyPolicy?(binding: object): boolean | Promise<boolean>;
    resolveApplicableSafetyPolicies(scope: object): readonly {nodeId:string;policyRef:string}[] |
      Promise<readonly {nodeId:string;policyRef:string}[]>;
    verifyImport?(binding: object): boolean | Promise<boolean>;
    reviewPolicy?: 'separate-pass' | 'independent-subject';
  };
  capabilityGraph?: object | ((context: { requestContext: AuthorRequestContext; signal: AbortSignal }) => object | Promise<object>);
  discoverCapabilities?(scope: { input: string; requested?: boolean; graph: object; context: unknown; requestContext: AuthorRequestContext; signal: AbortSignal;
    request: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
    readDocumentUrl?: (url: string) => Promise<{ url: string; bytes: Uint8Array }> }): Promise<{
      selection: unknown;
      documents?: { text: string; evidence: { capabilityId: string; documentId: string; revision: string; contentHash: string;
        source: { type: 'url'; url: string } | { type: 'file'; path: string } } }[];
    } | undefined>;
  resolveCapabilityGraphContext?(context: { requestContext: AuthorRequestContext; signal: AbortSignal }):
    { facts?: Record<string, string | number | boolean>; notes?: string } |
    Promise<{ facts?: Record<string, string | number | boolean>; notes?: string } | undefined> | undefined;
  initialCapabilityIds?: string[];
  initialDocuments?: object[];
  resolveImportSource?(input: { sourceRef: string; mode: 'new-collection' | 'migration' }, context: { requestContext: AuthorRequestContext; signal?: AbortSignal }): Promise<{ candidate: AuthorCandidate; sourceRef: string; issuer?: string }>;
  readDocumentUrl?(url: string, context: { requestContext: AuthorRequestContext; signal: AbortSignal }): Promise<{ url: string; bytes: Uint8Array }>;
  /** Explicit Host authorization for a historical pin. A missing result blocks that review. */
  readHistoricalDocument?(pin: { capabilityId: string; documentId: string; revision: string; contentHash: string;
    source: { type: 'url'; url: string } | { type: 'file'; path: string } },
    context: { requestContext: AuthorRequestContext; signal: AbortSignal; candidateHash: string }):
    Promise<{ bytes: Uint8Array; evidence: object } | null>;
  professionalSkillCatalog?: {
    collection(scope: AuthorProfessionalCatalogScope & { collectionId: string }): AuthorProfessionalCollection | null | Promise<AuthorProfessionalCollection | null>;
    search(scope: AuthorProfessionalCatalogScope & { id: string; description: string; collection: AuthorProfessionalCollection;
      selection?: string;
      selectCandidates?(need: { id: string; description: string },
        entries: { key: string; id: string; name: string; description: string; source: string }[]): Promise<string[] | null>;
      verifyApplicability(need: { id: string; description: string }, candidate: AuthorProfessionalSkill): Promise<boolean | null> }): Promise<{
      complete?: boolean; denied?: boolean; occupied?: boolean; matches?: Array<{ candidate: AuthorProfessionalSkill; source: string; approved: true }> }>;
  };
  resolveProfessionalSkill?(pin: object, context: AuthorProfessionalCatalogScope): Promise<{
    id: string; version: string; digest: string; source?: string; approved: boolean;
    reviewMaterial?: { text: string; contentHash: string };
  } | null>;
  resolveAuthoringInput?: FlowkitMcpOptions['resolveAuthoringInput'];
}
export interface AuthorDiscoveryMapping {
  generationId: string; discoveryRoot: string; snapshotHash: string; manifestHash: string; operationId: string;
  [key: string]: unknown;
}
export interface AuthorTargetRef { collectionId: string; skillId: string; baseArtifactHash: string; baseVersion: string }
export interface AuthorStartInput { collectionId: string; requestId: string; goal: string; choices?: AuthorChoices; target?: AuthorTarget; operation?: 'create' | 'update' | 'import'; targetRef?: AuthorTargetRef; importSource?: { sourceRef: string; mode: 'new-collection' | 'migration' } }
export interface AuthorTurnInput {
  draftId: string; expectedStateVersion: number; turnId: string; input: string; kind?: 'authoring' | 'review-only' | 'retry';
  candidateHash?: string;
  choices?: AuthorChoices; contextSnapshot?: unknown; baseline?: unknown; baselineId?: string; confirmedConstraintIds?: string[];
  safetyPolicies?: Array<{ nodeId: string; policyRef: string }>; retryRef?: string;
  confirmedPlanHash?: string;
  reconfirmIntentBaseline?: boolean;
  useCapabilityGraph?: boolean;
  target?: Partial<AuthorTarget>;
}
export interface AuthorCandidateIdentity { draftId: string; candidateHash: string; previousHash: string | null }
export interface AuthorApprovalInput extends AuthorCandidateIdentity { expectedStateVersion: number; reviewRef: string; approvalRef: string }
export interface AuthorPublicationInput extends AuthorApprovalInput { publicationId: string }
export interface WorkflowAuthorHost {
  start(input: AuthorStartInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  advanceTurn(input: AuthorTurnInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  readDraft(input: { draftId: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  readPublication(input: AuthorCandidateIdentity & { publicationId: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<{
    publicationId: string; draftId: string; candidateHash: string; status: string; discovery: string; isCurrent: boolean
  }>;
  reviewCandidate(input: AuthorCandidateIdentity, context: AuthorRequestContext, signal?: AbortSignal): Promise<{
    diff: unknown; receipt: AuthorDraftView['reviewReceipt']; rejection?: AuthorReviewRejection
  }>;
  recordApproval(input: AuthorApprovalInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  publish(input: AuthorPublicationInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<{ status: string; currentActive: string | null; [key: string]: unknown }>;
  settleTurn(input: { draftId: string; expectedStateVersion: number; turnId: string; evidenceRef: string; decision: 'confirm-result' | 'confirm-no-effect' | 'abandon' }, context: AuthorRequestContext, signal?: AbortSignal): Promise<{ retryRef: string | null; stateVersion: number; budget: unknown; result?: AuthorDraftView }>;
  discard(input: { draftId: string; expectedStateVersion: number; candidateHash: string | null; purgeBody?: boolean; retentionPolicyRef?: string; generationId?: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  cancelTurn(input: { draftId: string; expectedStateVersion: number; turnId: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  createMcpOptions(context?: AuthorRequestContext, bindings?: Pick<FlowkitMcpOptions, 'resolveAuthoringInput' | 'resolveCollectionPlan' | 'runWorkflow' | 'limits'>): FlowkitMcpOptions;
  close(options?: { mode?: 'drain' | 'cancel'; timeoutMs?: number }): Promise<{ closed: boolean; outstanding: number }>;
}
export function createWorkflowAuthorHost(options: AuthorHostOptions): Promise<WorkflowAuthorHost>;
