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
  /** checkStep is deliberately NOT supported in P0-A. */
  checkStep?: never;
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
