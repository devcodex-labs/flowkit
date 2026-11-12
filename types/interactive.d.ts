/**
 * P0-A / Interactive-state-machine-v1.
 * Host-owned execution only; a model may never independently call complete().
 * Not interchangeable with the six Standard root functions.
 */
export interface InteractiveProgramIdentity {
  artifactHash: string;
  sourceHash: string;
  workflowId: string;
  workflowVersion: string;
  compilerVersion: string;
  programAbiVersion: 1;
  semanticsVersion: 'interactive-state-machine-v1';
  checkpointSchemaVersion: 1;
  canonicalizationVersion: 'jcs-rfc8785-v1';
  implementedStage: 'P0-A';
}
export interface InteractiveCompileOptions {
  output: 'memory' | 'file';
  featureStage: 'P0-A';
  outDir?: string;
  /** Uses the Standard analyzer's nearest package.json discovery by default. */
  projectRoot?: string;
  /** Standard-compatible static Skill root (default "skills"). */
  skillsRoot?: string;
  /** Standard-compatible local Skill existence check (default true). */
  skillCheck?: boolean;
  /** Standard-compatible allowed HTTPS Skill host names. */
  remoteSkillHosts?: string[];
  targetVersion?: 'interactive-state-machine-v1';
}
export interface InteractiveDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  [key: string]: unknown;
}
export interface InteractiveCompileResult {
  code: string;
  diagnostics: InteractiveDiagnostic[];
  programIdentity?: InteractiveProgramIdentity;
  artifactPath?: string;
}
export declare function compileInteractive(
  file: string, options: InteractiveCompileOptions
): Promise<InteractiveCompileResult>;
export interface LoadedInteractiveProgram {
  artifactHash: string;
  interactiveProgram: {
    artifactFormat: 'FlowkitInteractiveProgramV1';
    identity: Omit<InteractiveProgramIdentity,'artifactHash'>;
  };
  programTable: {
    schemaVersion: 1;
    entryBlockId: string;
    blocks: readonly Record<string,unknown>[];
    nodes: Record<string,unknown>;
    requiredBindings: readonly Record<string,unknown>[];
  };
  advance(view: unknown, event: unknown): unknown;
}
export declare function loadInteractiveProgram(
  bytes: Uint8Array, expectedArtifactHash: string
): Promise<LoadedInteractiveProgram>;

export interface InteractiveAgentPending {
  kind: 'agent';
  runId: string;
  nodeId: string;
  id: string;
  name: string;
  requestId: string;
  attempt: number;
  instruction: string;
  input: Record<string,unknown>;
  missing: string[];
  resultSchema: Record<string,unknown>;
  reasons: string[];
  overview?: {step: number};
}
export type InteractiveRunStatus =
  'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'errored';
/** Execution frame for trusted Host callers. It can contain private State. */
export interface InteractiveRunFrame {
  namespace: string;
  runId: string;
  status: InteractiveRunStatus;
  revision: number;
  state?: Record<string,unknown>;
  pending?: InteractiveAgentPending;
  pauseReason?: string;
  terminal?: {status: 'succeeded'|'failed'|'errored'; nodeId: string; causeCode?: string}|null;
}
export type InteractiveCheckpoint = {
  schemaVersion: 1;
  namespace: string;
  runId: string;
  revision: number;
  artifactHash: string;
  status: InteractiveRunStatus;
  blockId: string;
  phase: string;
  state: Record<string,unknown>;
  controlStack: unknown[];
  [key: string]: unknown;
};
export interface CheckpointStore {
  readonly namespace: string;
  close(): void;
  putArtifact(input: {programIdentity: InteractiveProgramIdentity; bytes: Uint8Array}): string;
  getArtifact(hash: string): {programIdentity: InteractiveProgramIdentity;bytes: Uint8Array}|null;
  deleteArtifact(hash: string): boolean;
  createRun(input: {
    startKey: string;
    startIntent?: unknown;
    checkpoint: InteractiveCheckpoint;
  }): {created: boolean;checkpoint: InteractiveCheckpoint};
  load(runId: string): InteractiveCheckpoint|null;
  compareAndSwap(input: {
    runId: string;
    expectedRevision: number;
    nextCheckpoint: InteractiveCheckpoint;
    transitionId: string;
    journalEntry?: unknown;
  }): {committed:boolean;checkpoint:InteractiveCheckpoint};
  listJournal(runId: string): unknown[];
  /**
   * Optional execution-only receipt index (implemented by the default SQLite
   * Store). Resolves acceptedRevision/digest after a receipt leaves the
   * Checkpoint's bounded recent-receipts cache.
   */
  getReceipt?(runId: string, requestId: string): {
    requestId: string;
    nodeId: string;
    attempt: number;
    digest: string;
    acceptedRevision: number;
  } | null;
}
export declare function createSqliteCheckpointStore(
  file: string, options: {namespace:string}
): CheckpointStore;

export interface InteractiveSkillDescriptor {
  runId: string;
  nodeId: string;
  name: string;
  agent: string|null;
  skill: string|null;
  integrity: string|null;
}
export interface InteractiveRuntime {
  skillResolver?: (descriptor: InteractiveSkillDescriptor) => string|Promise<string>;
  validateResult?: (schema: Record<string,unknown>, result: unknown) => string[];
  /**
   * A shared Standard Host may expose checkStep. It is ignored only for a
   * verified Program with zero Agent bindings; Agent P0-A rejects it rather
   * than silently skipping a requested validation capability.
   */
  checkStep?: unknown;
}
export interface InteractiveCoordinator {
  readonly policyHash: string;
  start(input: {
    programBytes: Uint8Array;
    programIdentity: InteractiveProgramIdentity;
    startKey: string;
    runId?: string;
    state?: Record<string,unknown>;
    startIntent?: unknown;
  }): Promise<InteractiveRunFrame>;
  complete(input: {
    runId: string;
    requestId: string;
    nodeId: string;
    attempt: number;
    kind?: 'agent-result' | 'agent-call-failed';
    result?: unknown;
    failure?: {message:string};
  }): Promise<InteractiveRunFrame & {acceptedRevision:number;duplicate:boolean}>;
  resume(input: {runId:string}): Promise<InteractiveRunFrame>;
  load(input: {runId:string}): Promise<InteractiveRunFrame|null>;
}
export declare function createInteractiveCoordinator(input: {
  store: CheckpointStore;
  runtime: InteractiveRuntime;
  policy?: Record<string,unknown>;
  maxStagesPerCall?: number;
}): InteractiveCoordinator;


/** M5 signed Host-only Agent receipt: no Human/Action/Verification spoofing. */
export type HostAgentReceipt =
  | {runId:string;requestId:string;nodeId:string;attempt:number;kind:'agent-result';result:unknown}
  | {runId:string;requestId:string;nodeId:string;attempt:number;kind:'agent-call-failed';failure:{message:string}};

export interface HostAgentReceiptStatement {
  domain: 'flowkit.host-agent-receipt.v1';
  keyId: string;
  proofId: string;
  namespace: string;
  runId: string;
  requestId: string;
  nodeId: string;
  attempt: number;
  kind: 'agent-result' | 'agent-call-failed';
  artifactHash: string;
  policyHash: string;
  receiptHash: string;
  issuedAt: number;
  expiresAt: number;
}
export interface HostAgentAttestation {
  statement: HostAgentReceiptStatement;
  /** Canonical base64url Ed25519 signature of encodeAgentReceiptStatement bytes. */
  signature: string;
}
export declare function normalizeHostAgentReceipt(input:unknown):HostAgentReceipt;
export declare function createAgentReceiptStatement(input: {
  run: Pick<InteractiveCheckpoint,'namespace'|'artifactHash'> & {policyHash:string};
  receipt:HostAgentReceipt;
  keyId:string;
  proofId:string;
  issuedAt:number;
  expiresAt:number;
}):Readonly<HostAgentReceiptStatement>;
/** No private key is used or exposed. Host must sign in an isolated trust boundary. */
export declare function encodeAgentReceiptStatement(
  statement:HostAgentReceiptStatement
):Uint8Array;

export interface PublicInteractiveAgentTask {
  schemaVersion:1;
  kind:'agent';
  id:string;
  nodeId:string;
  runId:string;
  requestId:string;
  attempt:number;
  name:string;
  instruction:string;
  input:Record<string,unknown>;
  missing:string[];
  resultSchema:Record<string,unknown>;
  reasons:string[];
  overview?:{step:number};
}
export interface InteractiveDisclosureContext {
  namespace:string;
  runId:string;
  requestId:string;
  task:PublicInteractiveAgentTask;
  disclosurePolicyId:string;
}
export interface InteractiveTerminalAccessContext {
  action:'run:read'|'result:read';
  namespace:string;
  runId:string;
  revision:number;
}

export interface InteractiveTerminalResultRef {
  runId:string;
  revision:number;
  projectionVersion:1;
}

export interface PublicInteractiveTerminalFrame {
  protocolVersion:1;
  runId:string;
  revision:number;
  status:'succeeded'|'failed'|'errored';
  pending:readonly [];
  checkpointRef:{runId:string;revision:number};
  terminal?:{nodeId:string;status:'succeeded'|'failed'};
  resultRef:InteractiveTerminalResultRef;
}

export interface TrustedInteractiveTerminalResult {
  projectionVersion:1;
  namespace:string;
  runId:string;
  status:PublicInteractiveTerminalFrame['status'];
  terminal?:PublicInteractiveTerminalFrame['terminal'];
  state:Record<string,unknown>;
  contextError:null;
  causeCode?:string;
}

export interface TrustedInteractiveHost {
  readonly policyHash:string;
  readonly securityMode:'ed25519-agent-receipt-v1';
  /** Trusted Host only, not a model-facing method. */
  start(input: Parameters<InteractiveCoordinator['start']>[0]):Promise<InteractiveRunFrame>;
  resume(input:{runId:string}):Promise<InteractiveRunFrame>;
  load(input:{runId:string}):Promise<InteractiveRunFrame|null>;
  /** Only this task shape may be shared into a model worker. */
  getPublicAgentTask(input:{runId:string}):Promise<PublicInteractiveAgentTask|null>;
  /** A signature from an independently secured Host transport is mandatory. */
  accept(input:{
    receipt:HostAgentReceipt;
    attestation:HostAgentAttestation;
  }):Promise<InteractiveRunFrame & {acceptedRevision:number;duplicate:boolean}>;
}
export interface TrustedInteractiveHostWithTerminalAccess extends TrustedInteractiveHost {
  /** Public terminal projection, subject to the Host's run:read authorization. */
  getPublicTerminalFrame(input:{runId:string}):Promise<PublicInteractiveTerminalFrame>;
  /** Host-only result read, subject to a separate result:read authorization. */
  readTrustedTerminalResult(input:{resultRef:InteractiveTerminalResultRef}):Promise<TrustedInteractiveTerminalResult>;
}
export interface TrustedInteractiveHostOptions {
  store:CheckpointStore;
  runtime:InteractiveRuntime;
  policy?:Record<string,unknown>;
  /** Pinned Ed25519 public keys or PEM encoded public keys. No private material. */
  trustedPublicKeys:Record<string,unknown>;
  /** Pinned artifact hashes approved by a separate trusted build/deployment. */
  trustedArtifacts:string[];
  /** Explicit model-visible Agent State keys, default empty/fail closed. */
  allowedInputKeys?:string[];
  disclosurePolicyId:string;
  authorizeDisclosure(context:Readonly<InteractiveDisclosureContext>):boolean|Promise<boolean>;
  /** Host-owned authorizer, required for both terminal projection methods. */
  authorizeTerminalAccess?(context:Readonly<InteractiveTerminalAccessContext>):boolean|Promise<boolean>;
  maxProofAgeMs?:number;
  clockSkewMs?:number;
  now?:()=>number;
  maxStagesPerCall?:number;
}
export declare function createTrustedInteractiveHost(
  options:TrustedInteractiveHostOptions
):TrustedInteractiveHostWithTerminalAccess;
