import type { AgentExecutionResult, PreparedAgentTask, HostPreparationContext, Runtime } from './index.js';

export interface AuthorRequestContext {
  namespace: string; principalId: string; sessionId: string; workspaceRef: string; collectionIds: string[];
  authorizationSnapshot?: unknown;
}
export interface AuthorBudgetPolicy {
  durationMs: number; maxRequests: number; maxToolCalls: number; maxIoCalls: number; maxBytes: number; maxResponseBytes: number;
}
export interface AuthorPortContext { signal: AbortSignal; requestContext: AuthorRequestContext; [key: string]: unknown }
export interface AuthorGuardedPorts {
  request(input: unknown, context?: object): Promise<unknown>;
  tool(input: unknown, context?: object): Promise<unknown>;
  io(input: unknown, context?: object): Promise<unknown>;
}
export interface AuthorTarget { skillId?: string; name: string; description: string; version: string }
export interface AuthorChoices { project?: string; collectionName?: string; executionMode?: 'standard' | 'interactive-p0-a'; includeSource?: boolean }
export interface AuthorCandidate {
  files: Record<string, string>; hash: string;
  manifest: { collectionId: string; skillId: string; name: string; version: string; artifactHash: string; [key: string]: unknown };
}
export interface AuthorDraftView {
  id: string; namespace: string; storeId: string; collectionId: string; stateVersion: number; contentRevision: number; contentHash: string;
  status: string; goal: string; choices: AuthorChoices; questions: Array<{ id: string; question: string; options: unknown[]; recommended: string }>;
  candidate?: AuthorCandidate | null; previousHash: string | null;
  reviewReceipt?: { qualified: boolean; reviewRef: string; candidateHash: string; [key: string]: unknown } | null;
  approvalReceipt?: { approvalRef: string; [key: string]: unknown } | null;
  diagnostics?: Array<{ code?: string; message?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface AuthorHostOptions {
  namespace: string; storageFile: string; collectionIds: string[];
  hostProfile: { id: string; digest: string; [key: string]: unknown };
  defaults?: AuthorChoices;
  budgetPolicy?: Partial<AuthorBudgetPolicy>;
  capacity?: Partial<{ maxPhysicalExecutions: number; maxPendingCandidates: number; maxDrafts: number; maxDraftBytes: number }>;
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
      Promise<{ passed: boolean; subjectId: string; executionId: string; requestId?: string; authorSubjectId?: string }>;
    verifyApproval(binding: { approvalRef: string; candidateHash?: string; requestContext: AuthorRequestContext; [key: string]: unknown }):
      Promise<{ approved: boolean; subjectId: string; approvalId: string }>;
    verifySettlement?(binding: object): Promise<{ verified: boolean; physicalDone: boolean; noEffect?: boolean }>;
    verifySafetyPolicy?(binding: object): boolean | Promise<boolean>;
    verifyImport?(binding: object): boolean | Promise<boolean>;
    reviewPolicy?: 'separate-pass' | 'independent-subject';
  };
  capabilityGraph?: object; initialDocuments?: object[];
  initialCapabilityIds?: string[];
  resolveImportSource?(input: { sourceRef: string; mode: 'new-collection' | 'migration' }, context: { requestContext: AuthorRequestContext; signal?: AbortSignal }): Promise<{ candidate: AuthorCandidate; sourceRef: string }>;
  readDocumentUrl?(url: string, context: { requestContext: AuthorRequestContext; signal: AbortSignal }): Promise<{ url: string; bytes: Uint8Array }>;
  resolveProfessionalSkill?(pin: object, context: { requestContext: AuthorRequestContext; signal: AbortSignal }): Promise<{ id: string; version: string; digest: string; approved: boolean } | null>;
  resolveAuthoringInput?(inputRef: string, context: AuthorRequestContext): Promise<AuthorTurnInput>;
}
export interface AuthorTargetRef { collectionId: string; skillId: string; baseArtifactHash: string; baseVersion: string }
export interface AuthorStartInput { collectionId: string; requestId: string; goal: string; choices?: AuthorChoices; target?: AuthorTarget; operation?: 'create' | 'update' | 'import'; targetRef?: AuthorTargetRef; importSource?: { sourceRef: string; mode: 'new-collection' | 'migration' } }
export interface AuthorTurnInput {
  draftId: string; expectedStateVersion: number; turnId: string; input: string; kind?: 'authoring' | 'review-only' | 'retry';
  choices?: AuthorChoices; contextSnapshot?: unknown; baseline?: unknown; baselineId?: string; confirmedConstraintIds?: string[];
  safetyPolicies?: Array<{ nodeId: string; policyRef: string }>; retryRef?: string;
  confirmedPlanHash?: string;
}
export interface AuthorCandidateIdentity { draftId: string; candidateHash: string; previousHash: string | null }
export interface AuthorApprovalInput extends AuthorCandidateIdentity { expectedStateVersion: number; reviewRef: string; approvalRef: string }
export interface AuthorPublicationInput extends AuthorApprovalInput { publicationId: string }
export interface WorkflowAuthorHost {
  start(input: AuthorStartInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  advanceTurn(input: AuthorTurnInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  readDraft(input: { draftId: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  reviewCandidate(input: AuthorCandidateIdentity, context: AuthorRequestContext, signal?: AbortSignal): Promise<{ diff: unknown; receipt: AuthorDraftView['reviewReceipt'] }>;
  recordApproval(input: AuthorApprovalInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  publish(input: AuthorPublicationInput, context: AuthorRequestContext, signal?: AbortSignal): Promise<{ status: string; currentActive: string | null; [key: string]: unknown }>;
  settleTurn(input: { draftId: string; expectedStateVersion: number; turnId: string; decision: 'confirm-result' | 'confirm-no-effect' | 'abandon' }, context: AuthorRequestContext, signal?: AbortSignal): Promise<{ retryRef: string | null; stateVersion: number; budget: unknown }>;
  discard(input: { draftId: string; expectedStateVersion: number; candidateHash: string | null }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  cancelTurn(input: { draftId: string; expectedStateVersion: number; turnId: string }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
  createMcpOptions(): { namespace: string; collectionIds: string[]; authorHost: WorkflowAuthorHost; store: object; [key: string]: unknown };
  close(options?: { mode?: 'drain' | 'cancel'; timeoutMs?: number }): Promise<{ closed: boolean; outstanding: number }>;
}
export function createWorkflowAuthorHost(options: AuthorHostOptions): Promise<WorkflowAuthorHost>;
