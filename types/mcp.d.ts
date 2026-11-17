/** A Host-owned approved artifact store. */
interface Store {
  readCollectionMetadata?(collectionId:string):{collection:{name:string};skills:Array<Omit<Candidate,'files'>>}|null;
  readCollection(collectionId: string): { collection: { name: string }; skills: Candidate[] } | null;
  readVersion(collectionId: string, skillId: string, hash: string): Candidate | null;
  applyCollectionPlan(plan: { destination: { id: string } }, approvalRef: string): unknown;
}
interface Candidate {
  hash: string;
  files: Record<string, string>;
  manifest: { collectionId: string; skillId: string; name: string; version: string; kind?: string };
}
/** Per-connection Host bindings. Runtime values remain owned by the Host. */
export interface FlowkitMcpOptions {
  namespace: string;
  collectionIds: string[];
  store: Store;
  author: {
    start(goal: string, choices: object): unknown;
    prepare(plan: unknown, options: unknown): Promise<{ candidate: Candidate | null; diagnostics: unknown[] }>;
    review(candidate: Candidate, previous: Candidate | null): unknown;
    publish(candidate: Candidate, receipts: object): Promise<string>;
  };
  authorize(scope: { namespace: string; collectionId: string; operation: string; signal?: AbortSignal }): boolean | Promise<boolean>;
  resolveCompileInput?(scope: { namespace: string; collectionId: string; inputRef: string; signal: AbortSignal }):
    Promise<{ plan: unknown; options: { collectionId: string; [key: string]: unknown } }>;
  resolveCollectionPlan?(scope: { namespace: string; collectionId: string; planRef: string; signal: AbortSignal }):
    Promise<{ destination: { id: string } }>;
  runWorkflow?(scope: { namespace: string; collectionId: string; skillId: string; candidateHash: string; executionRef: string; signal: AbortSignal }): Promise<unknown>;
  pendingCandidates?: Map<string, Candidate>;
  limits?: { pageSize?: number; maxResourceBytes?: number; maxCandidates?: number;maxMetadataEntries?:number };
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
