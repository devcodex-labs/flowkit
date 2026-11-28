import type { AuthorDraftView, AuthorProfessionalSkill, AuthorRequestContext, AuthorTurnInput, WorkflowAuthorHost } from './author-host.js';
/** A Host-owned approved artifact store. */
interface Store {
  readCollectionMetadata?(collectionId:string,options?:{limit:number}):{collection:{name:string};skills:Array<Omit<Candidate,'files'>>}|null;
  readCollection(collectionId: string): { collection: { name: string }; skills: Candidate[] } | null;
  readVersion(collectionId: string, skillId: string, hash: string): Candidate | null;
  readProfessionalVersion?(collectionId: string, skillId: string, version: string): AuthorProfessionalSkill | null;
  applyCollectionPlan(plan: { destination: { id: string } }, approvalRef: string): unknown;
}
interface Candidate {
  hash: string;
  files: Record<string, string>;
  manifest: { collectionId: string; skillId: string; name: string; version: string; kind?: string };
}
export interface FlowkitAuthoringMaterial { id: string; title: string; content: string }
export type FlowkitMaterialSource = (FlowkitAuthoringMaterial & { kind: 'text' }) |
  { kind: 'material'; id: string; sha256: string } | { kind: 'design'; ref: string; sha256: string; groupId?: string };
/** Per-connection Host bindings. Runtime values remain owned by the Host. */
export interface FlowkitMcpOptions {
  namespace: string;
  collectionIds: string[];
  store?: Store;
  authorHost?: WorkflowAuthorHost;
  requestContext?: AuthorRequestContext;
  authorize(scope: { namespace: string; collectionId: string; operation: string; signal?: AbortSignal }, context?: AuthorRequestContext): boolean | Promise<boolean>;
  resolveAuthoringInput?(scope: { namespace: string; collectionId: string; inputRef: string; requestContext: AuthorRequestContext; signal: AbortSignal }): Promise<AuthorTurnInput>;
  resolveCollectionPlan?(scope: { namespace: string; collectionId: string; planRef: string; requestContext: AuthorRequestContext; signal: AbortSignal }):
    Promise<{ destination: { id: string } }>;
  applyCollectionPlan?(plan: { destination: { id: string } }, approvalRef: string, context?: AuthorRequestContext, signal?: AbortSignal): Promise<unknown>;
  runWorkflow?(scope: { namespace: string; collectionId: string; skillId: string; candidateHash: string; executionRef: string; requestContext: AuthorRequestContext; signal: AbortSignal }): Promise<unknown>;
  queueAuthoringTurn?(input: AuthorTurnInput, context: AuthorRequestContext, admissionSignal?: AbortSignal): Promise<AuthorDraftView>;
  nativeSkillDiscovery?: boolean;
  workflowUi?: {
    defaultCollectionId: string;
    present(draft: AuthorDraftView, context?: AuthorRequestContext): unknown;
    recover?(input: { draftId: string; expectedStateVersion: number }, context: AuthorRequestContext, signal?: AbortSignal): Promise<AuthorDraftView>;
    review(result: Awaited<ReturnType<WorkflowAuthorHost['reviewCandidate']>>): unknown;
    matchCapability?(input: { goal: string }, context: AuthorRequestContext, signal: AbortSignal): Promise<unknown>;
    authoringMaterials?(scope: { input: AuthorTurnInput; sources?: FlowkitMaterialSource[]; draft: AuthorDraftView },
      context: AuthorRequestContext, signal: AbortSignal): Promise<AuthorTurnInput>;
    design?(input: { collectionId: string; requestId: string; title: string; resumeToken?: string } &
      ({ materials: FlowkitAuthoringMaterial[]; sources?: never } |
        { sources: Exclude<FlowkitMaterialSource, { kind: 'design' }>[]; materials?: never }),
      context?: AuthorRequestContext, signal?: AbortSignal): Promise<unknown>;
    relayout?(input: { collectionId: string; draftId: string; candidateHash: string; expectedLayoutRevision: string; requestId: string },
      context?: AuthorRequestContext, signal?: AbortSignal): Promise<unknown>;
    export(input: { collectionId: string; draftId: string; candidateHash: string } &
      ({ layoutRevision?: string; exportReceipt?: never } | { layoutRevision?: never; exportReceipt: string }),
      context?: AuthorRequestContext, signal?: AbortSignal): Promise<unknown>;
    add(input: { collectionId: string; requestId: string; sourceRef: string; candidateHash?: string; destination?: 'flowkit' | 'codex' },
      context?: AuthorRequestContext, signal?: AbortSignal): Promise<unknown>;
  };
  limits?: { pageSize?: number; maxResourceBytes?: number; maxResponseBytes?: number;maxMetadataEntries?:number };
}
export interface FlowkitMcpServer {
  connect(transport: object): Promise<void>;
  close(): Promise<void>;
}
export function createFlowkitMcpServer(options: FlowkitMcpOptions): FlowkitMcpServer;
export function connectFlowkitStdio(options: FlowkitMcpOptions): Promise<FlowkitMcpServer>;
/** The resolver authenticates each Node HTTP request and returns an isolated Host binding. */
export function createFlowkitHttpHandler(resolveHost: (request: unknown) => FlowkitMcpOptions | null | Promise<FlowkitMcpOptions | null>):
  (request: unknown, response: unknown) => Promise<void>;
