import type {Runtime, PreparedAgentTask, TaskPolicy, GraphSnapshotV1, InteractiveHumanDecision} from './index.js';
import type {WorkflowContract} from './dsl.js';

/**
 * P0-A / Interactive-state-machine-v1.
 * Host-owned execution only; a model may never independently call complete().
 * Not interchangeable with the six Standard root functions.
 */
export interface InteractiveProgramIdentity {
  artifactHash: string;
  sourceHash: string;
  graphStructureHash: string;
  workflowId: string;
  workflowVersion: string;
  compilerVersion: string;
  programAbiVersion: 1;
  semanticsVersion: 'interactive-state-machine-v1';
  checkpointSchemaVersion: 1;
  canonicalizationVersion: 'jcs-rfc8785-v1';
  implementedStage: 'P0-A' | 'P0-B' | 'P1' | 'P2';
}
export interface InteractiveCompileOptions {
  output: 'memory' | 'file';
  featureStage: 'P0-A' | 'P0-B' | 'P1' | 'P2';
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
  mermaid?: string;
  diagnostics: InteractiveDiagnostic[];
  programIdentity?: InteractiveProgramIdentity;
  graphSnapshot?: GraphSnapshotV1;
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
    contract?:WorkflowContract & {readonly validator:string;readonly digest:string};
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
  preparedTask?: PreparedAgentTask;
}
export type InteractiveRunStatus =
  'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'errored' | 'cancelled';
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
  getReceipt(runId: string, requestId: string): {
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
  prepareAgentTask?: Runtime['prepareAgentTask'];
  /** Recheck current authorization and exact pinned resource availability on every resume/disclosure/receipt. */
  authorizeAgentTask?: (task: PreparedAgentTask, context: {runId?:string;signal?:AbortSignal;deadlineMs:number}) => boolean|Promise<boolean>;
  taskResourcePolicy?: Pick<TaskPolicy,'fetch'|'authorizeRemote'|'isImmutableResource'>;
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
  reserveDispatch(input:{runId:string;requestId:string;operationId:string}):Promise<{deadlineMs:number;dispatches:number;providerRequests?:number}>;
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
    failure?: {message:string;retryable?:boolean;sideEffectStatus?:'none'|'known'|'unknown';code?:string};
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
  | {runId:string;requestId:string;nodeId:string;attempt:number;kind:'agent-call-failed';failure:{message:string;retryable?:boolean;sideEffectStatus?:'none'|'known'|'unknown';code?:string}};

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
  preparedTask?:PreparedAgentTask;
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
  status:'succeeded'|'failed'|'errored'|'cancelled';
  pending:readonly [];
  cancelledRequests?:readonly string[];
  checkpointRef:{runId:string;revision:number};
  terminal?:{nodeId:string;status:'succeeded'|'failed'};
  resultRef:InteractiveTerminalResultRef;
}

interface InteractiveContextError {
  code:string;
  message:string;
  operationKey?:string;
  sideEffectStatus?:'none'|'known'|'unknown';
}

export interface TrustedInteractiveTerminalResult {
  projectionVersion:1;
  namespace:string;
  runId:string;
  status:PublicInteractiveTerminalFrame['status'];
  terminal?:PublicInteractiveTerminalFrame['terminal'];
  state:Record<string,unknown>;
  /** Formal result, present only on success after output validation. */
  publicOutput?:Record<string,unknown>;
  contextError:InteractiveContextError|null;
  causeCode?:string;
}

export interface HistoricalAckRequest {
  namespace:string;
  runId:string;
  requestId:string;
  nodeId:string;
  attempt:number;
  receiptHash:string;
}
export interface TrustedInteractiveHost {
  reserveDispatch:InteractiveCoordinator['reserveDispatch'];
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
  readHistoricalAck(input:HistoricalAckRequest):Promise<Readonly<HistoricalAckRequest & {acceptedRevision:number}>>;
  /** Revoke the SHA-256 fingerprint of a public key's SPKI in the Host Store. */
  revokeKey(publicKeyHash:string):Promise<boolean>;
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
  authorizeReceiptAudit?(context:Readonly<HistoricalAckRequest & {action:'receipt:read-history'}>):boolean|Promise<boolean>;
  authorizeKeyRevocation?(context:Readonly<{action:'host:revoke-key';namespace:string;publicKeyHash:string}>):boolean|Promise<boolean>;
  drainOnly?:boolean;
  maxProofAgeMs?:number;
  clockSkewMs?:number;
  now?:()=>number;
  maxStagesPerCall?:number;
}
export declare function createTrustedInteractiveHost(
  options:TrustedInteractiveHostOptions
):TrustedInteractiveHostWithTerminalAccess;

export interface TransitionRecordV1 {
  namespace:string;
  runId:string;
  transitionId:string;
  fromRevision:number|null;
  toRevision:number;
  fromBlockId:string|null;
  toBlockId:string|null;
  programHash:string;
  eventDigest:string;
  /** Present for the R5 transition identity scheme. */
  proposalDigest?:string;
  committedAt:string;
}

type InteractiveStepKind = 'agent' | 'action' | 'verification' | 'human';
interface InteractiveHumanProof {subjectId:string;proofId:string;evidenceHash:string;
  bundleHash?:string;decision?:'approve'|'revise'|'decline'}

export interface ReceiptRecordV1 {
  namespace:string;
  runId:string;
  requestId:string;
  kind:InteractiveStepKind;
  humanProof?:InteractiveHumanProof;
  subjectId?:string;
  operationSafety?:'unclaimed'|'settled'|'no-effect';
  submissionDigest:string;
  acceptedRevision:number;
  outcome:'succeeded'|'failed'|'legacy';
  transitionId:string;
  /** P0-A execution identity retained by the SQLite compatibility facade. */
  nodeId?:string;
  attempt?:number;
}

export type RunCheckpointV1 = {
  schemaVersion:1;
  protocolVersion:1;
  namespace:string;
  runId:string;
  startKey:string;
  startIntentHash:string;
  revision:number;
  status:InteractiveRunStatus;
  program:InteractiveProgramIdentity;
  programRef:TrustedProgramRefV1;
  policyIdentity:{id:string;version:string;policyHash:string;bindingManifestHash:string;skillManifestHash?:string};
  execution:{blockId:string;phase:'enter'|'prepare'|'dispatch-ready'|'awaiting'|'validate'|'commit'|'route'|'finished';
    activationSeq:number;agentStepCounter:number;controlStack:readonly Record<string,unknown>[];
    contextError:InteractiveContextError|null;
    businessDeadlineMs?:number;
    activityDeadlineMs?:number;
    regionCounters?:Record<string,number>;
    skillSnapshot?:{activation:number;nodeId:string;instruction:string};
    cancelledRequests?:readonly string[];
    unavailableParallelKeys?:readonly string[];
    parallel?:{nodeId:string;strategy:'all_succeeded'|'any';effectMode?:'retain'|'compensate';
      lanes:readonly Record<string,unknown>[];decision?:Record<string,unknown>;receipt?:Record<string,unknown>};
    taskContext?:{deadlineMs:number;deadlineScope?:'activity';dispatches:number;providerRequests?:number;reservations?:string[];
      active?:{activationId:string;input:Record<string,unknown>;missing:string[];prepared:PreparedAgentTask}}};
  state:Record<string,unknown>;
  publicOutput?:Record<string,unknown>;
  outputContractDigest?:string;
  candidate:{kind:InteractiveStepKind;requestId:string;result:Record<string,unknown>}|null;
  receivedSubmission:{kind:InteractiveStepKind;requestId:string;activation:number;attempt:number;canonicalDigest:string;
    acceptedRevision:number;payload:Record<string,unknown>;receivedAt:string;humanProof?:InteractiveHumanProof}|null;
  pending:Array<{requestId:string;nodeId:string;kind:InteractiveStepKind;activation:number;attempt:number;issuedRevision:number;
    intent:'execute';name:string;internalPayload:Record<string,unknown>;publicTask:Record<string,unknown>}>;
  inFlightOperations:Record<string,unknown>[];
  terminal:{nodeId:string;status:'succeeded'|'failed'}|null;
  lastTransitionId:string|null;
  limits:{stageCount:number;receiptCount:number;bytes:number};
  causeCode?:string;
};

export type CASResultV1 =
  | {committed:true;checkpoint:RunCheckpointV1}
  | {committed:false;currentRevision:number};

/** All reads must be linearizable within namespace, including history. */
export interface CheckpointStoreV1 {
  readonly namespace:string;
  /** Atomically creates Genesis and protects the registered Program from release. */
  createIfAbsent(startKey:string,initial:RunCheckpointV1,genesis:TransitionRecordV1):Promise<{created:boolean;checkpoint:RunCheckpointV1}>;
  load(runId:string):Promise<RunCheckpointV1|null>;
  compareAndSwap(runId:string,expectedRevision:number,tx:{next:RunCheckpointV1;transition:TransitionRecordV1;receipt?:ReceiptRecordV1}):Promise<CASResultV1>;
  loadTransition(runId:string,transitionId:string):Promise<TransitionRecordV1|null>;
  loadReceipt(runId:string,requestId:string):Promise<ReceiptRecordV1|null>;
  loadJournalPage?(runId:string,page:{afterRevision:number;limit:number}):Promise<{headRevision:number;
    records:Array<{revision:number;transitionId:string;entry:Record<string,unknown>}>}|null>;
}

export interface TrustedProgramRefV1 {
  namespace:string;
  artifactHash:string;
  programId:string;
}

export interface TrustedProgramRegistryV1 {
  readonly namespace:string;
  putImmutable(bytes:Uint8Array,manifest:InteractiveProgramIdentity):Promise<TrustedProgramRefV1>;
  resolveByHash(artifactHash:string):Promise<Uint8Array>;
  describe(artifactHash:string):Promise<InteractiveProgramIdentity|null>;
  retain(runId:string,artifactHash:string):Promise<void>;
  release(runId:string,artifactHash:string):Promise<void>;
}

export declare function createSqliteInteractivePersistence(file:string,options:{namespace:string}):{
  readonly store:CheckpointStoreV1;
  readonly programRegistry:TrustedProgramRegistryV1;
  readonly adminController:InteractiveAdminControllerV1;
  readonly operationController:InteractiveOperationController;
  readonly artifactController:InteractiveArtifactController;
  close():void;
};

export interface InteractiveOperationRecord {
  requestId:string;
  inputHash:string;
  businessKey?:string;
  readOnly?:true;
  compensationPlan?:{capabilityId:string;inputHash:string};
  compensation?:{key:string;idempotencyKey:string;evidenceHash:string|null};
  settlement:{effect:'applied'|'no-effect';evidenceHash:string;result:unknown}|null;
}
export interface InteractiveOperationController {
  claim(input:{runId:string;requestId:string;operationKey:string;inputHash:string;businessKey?:string;
      compensationPlan?:{capabilityId:string;inputHash:string}},
    auth:TrustedHostContextV1):Promise<InteractiveOperationRecord & {claimed:boolean}>;
  load(input:{runId:string;operationKey:string},auth:TrustedHostContextV1):Promise<InteractiveOperationRecord|null>;
  settle(input:{runId:string;operationKey:string;inputHash:string;effect:'applied'|'no-effect';evidenceHash:string;result:unknown},
    auth:TrustedHostContextV1):Promise<InteractiveOperationRecord>;
  list(input:{runId:string},auth:TrustedHostContextV1):Promise<Array<InteractiveOperationRecord & {operationKey:string}>>;
  claimCompensation(input:{runId:string;operationKey:string},
    auth:TrustedHostContextV1):Promise<InteractiveOperationRecord & {claimed:boolean}>;
  recoverCompensation(input:{runId:string;operationKey:string;compensationKey:string;evidenceHash:string},
    auth:TrustedHostContextV1):Promise<InteractiveOperationRecord & {claimed:boolean}>;
  settleCompensation(input:{runId:string;operationKey:string;compensationKey:string;evidenceHash:string},
    auth:TrustedHostContextV1):Promise<InteractiveOperationRecord>;
}

declare const adminContextBrand:unique symbol;
export interface TrustedAdminContextV1 {
  readonly [adminContextBrand]:true;
  readonly namespace:string;
  readonly subjectId:string;
}
export interface InteractiveAdminControllerV1 {
  adminTerminate(runId:string,reasonCode:string,auth:TrustedAdminContextV1):Promise<InteractiveFrameV1>;
}
export declare function createInteractiveAdminContext(options:{
  namespace:string;
  subjectId:string;
  authorize(request:Readonly<{namespace:string;subjectId:string;action:'run:admin-terminate';runId:string;reasonCode:string}>):boolean|Promise<boolean>;
}):TrustedAdminContextV1;

declare const hostContextBrand:unique symbol;
export interface TrustedHostContextV1 {
  readonly [hostContextBrand]:true;
  readonly namespace:string;
  readonly subjectId:string;
  readTerminalResult(resultRef:InteractiveTerminalResultRef,
    options:Omit<InteractiveOptionsV1,'auth'>):Promise<TrustedInteractiveTerminalResult>;
  readRunView(ref:RunViewerRef,options:RunViewerOptions):Promise<RunViewerSnapshot>;
  listRunViewEvents(input:{ref:RunViewerRef;afterRevision?:number;limit?:number},options:RunViewerOptions):Promise<RunViewerEvents>;
  readRunArtifacts(input:{ref:RunViewerRef;after?:number},options:RunViewerOptions):Promise<RunArtifactIndex>;
  readRunArtifactContent(input:{ref:RunViewerRef;artifactId:string;versionId:string},options:RunViewerOptions,
    readContent:(version:ArtifactMetadata & {namespace:string;runId:string;versionId:string;storageRef:string;signal?:AbortSignal})=>
      string|Uint8Array|null|Promise<string|Uint8Array|null>):
    Promise<{artifactId:string;versionId:string;versionLabel?:string;mimeType:string;text:string}|null>;
}

interface ArtifactMetadata {artifactId:string;contentHash:string;mimeType:string;sizeBytes:number;versionLabel?:string}
interface ArtifactVersion extends ArtifactMetadata {versionId:string;nodeId:string;requestId:string}
export interface ReviewBundle {runId:string;requestId:string;reviewDigest:string;expiresAt:number;bundleHash:string;
  versions:Array<Pick<ArtifactVersion,'artifactId'|'versionId'|'contentHash'>>}
export interface InteractiveArtifactController {
  registerVersion(input:ArtifactMetadata & {runId:string;requestId:string;storageRef:string},auth:TrustedHostContextV1):
    Promise<ArtifactVersion & {storageRef:string}>;
  freezeBundle(input:{runId:string;requestId:string;reviewDigest:string;versionIds:string[];expiresAt:number;
    expectedBundleHash?:string},auth:TrustedHostContextV1):Promise<ReviewBundle>;
}
export interface RunArtifactIndex {schemaVersion:1;namespace:string;runId:string;artifactHash:string;graphDigest:string;
  items:Array<ArtifactVersion & {latestVersionId:string;effectiveVersionId:string|null;confirmed?:true}>;next:number|null}

export type RunViewerRef = {namespace:string;runId:string;artifactHash:string;graphDigest:string} & (
  {collectionId:string;candidateHash:string;approvalRef:string} |
  {collectionId?:never;candidateHash?:never;approvalRef?:never}
);
export type RunViewerOptions=Omit<InteractiveOptionsV1,'auth'> & {graphSnapshot:GraphSnapshotV1};
export interface InteractiveForkPoint {
  revision:number;
  nodeId:string;
  entryRevision:number;
  startNodeId:string;
  scope:Array<{groupId:string;laneId:string}>;
  activation?:number;
  attempt?:number;
}
export interface RunViewerSnapshot {
  schemaVersion:1;namespace:string;runId:string;artifactHash:string;graphDigest:string;revision:number;
  status:InteractiveRunStatus;pauseReason?:string;publicOutput?:Record<string,unknown>;
  pending:Array<{nodeId:string;kind:InteractiveStepKind;activation:number;attempt:number;requestId:string;
    scope:Array<{groupId:string;laneId:string}>}>;
}
export interface RunViewerEvents {
  schemaVersion:1;namespace:string;runId:string;artifactHash:string;graphDigest:string;headRevision:number;cursor:number;
  events:Array<{eventId:string;revision:number;kind:'run.started'|'run.finished'|'receipt.accepted'|'transition.committed';
    occurredAt:string;nodeId?:string;requestId?:string;attempt?:number;activation?:number;
    scope?:Array<{groupId:string;laneId:string}>;receiptOutcome?:'succeeded'|'failed'}>;
}

export type PublicPendingV1 = {
  requestId:string;
  nodeId:string;
  attempt:number;
  activation:number;
  intent:'execute';
} & (
  | {kind:'agent';task:Pick<InteractiveAgentPending,'name'|'instruction'|'input'|'missing'|'resultSchema'|'reasons'|'overview'|'preparedTask'>}
  | {kind:'action';task:InteractiveStepTask & {action:string;writes:readonly string[];
      effect?:'read-only'|'write';operationKey:string}}
  | {kind:'verification';task:InteractiveStepTask & {verifier:string}}
  | {kind:'human';task:InteractiveStepTask & {reviewDigest:string}}
);
interface InteractiveStepTask {
  name:string;
  input:Record<string,unknown>;
  contextError:InteractiveContextError|null;
}

export interface InteractiveFrameV1 {
  protocolVersion:1;
  runId:string;
  revision:number;
  status:Exclude<InteractiveRunStatus,'running'>;
  pending:ReadonlyArray<PublicPendingV1>;
  checkpointRef:{runId:string;revision:number};
  terminal?:{nodeId:string;status:'succeeded'|'failed'};
  resultRef?:InteractiveTerminalResultRef;
  acknowledgement?:{requestId:string;acceptedRevision:number;repeated:boolean};
  pauseReason?:'reconciliation';
  cancelledRequests?:readonly string[];
  diagnostics?:readonly InteractiveDiagnostic[];
}

export declare function createInteractiveHostContext(options:{
  namespace:string;
  subjectId:string;
  authorize(request:Readonly<{namespace:string;subjectId:string;action:'run:create'|'run:complete'|'run:resume'|'run:cancel'|'result:read'|
    'run:fork'|'run:fork:redo-writes'|
    'viewer:read'|'viewer:events'|'viewer:output'|'viewer:artifacts'|'viewer:artifact-content'|'artifact:register'|'artifact:freeze'|
    'operation:claim'|'operation:read'|'operation:settle'|'operation:list'|'operation:compensate'|
    'operation:recover-compensation'|'operation:settle-compensation';
    startKey?:string;source?:string;artifactHash?:string;runId?:string;requestId?:string;revision?:number;
    graphDigest?:string;collectionId?:string;candidateHash?:string;approvalRef?:string;entryRevision?:number;redoWrites?:boolean;
    reasonCode?:string;operationKey?:string;inputHash?:string;businessKey?:string;effect?:'applied'|'no-effect';
    evidenceHash?:string;compensationKey?:string;compensationPlan?:Readonly<{capabilityId:string;inputHash:string}>}>):boolean|Promise<boolean>;
  authorizeTask(request:Readonly<{namespace:string;subjectId:string;runId:string;requestId:string;revision:number;nodeId:string;
    task:PublicPendingV1['task']}>):boolean|Promise<boolean>;
  authorizeHuman?(request:Readonly<{namespace:string;subjectId:string;runId:string;requestId:string;reviewDigest:string;
    result:InteractiveHumanDecision;bundle?:ReviewBundle}>):{proofId:string;evidenceHash:string}|null
      |Promise<{proofId:string;evidenceHash:string}|null>;
}):TrustedHostContextV1;

type BindingV1<Mode extends string,F> = {id:string;version:string;mode:Mode;implementation:F};
export interface InteractiveRuntimeV1 {
  prepareAgentTask?:BindingV1<'trusted-read',NonNullable<InteractiveRuntime['prepareAgentTask']>>;
  authorizeAgentTask?:BindingV1<'trusted-read',NonNullable<InteractiveRuntime['authorizeAgentTask']>>;
  taskResourcePolicy?:InteractiveRuntime['taskResourcePolicy'];
  validateResult?:BindingV1<'pure-local',NonNullable<InteractiveRuntime['validateResult']>>;
  skillResolver?:BindingV1<'trusted-read',(reference:string,meta?:InteractiveSkillDescriptor)=>string|Promise<string>>;
  checkStep?:BindingV1<'pure-local',(input:Readonly<{
    id:string;name:string;runId:string;requestId:string;attempt:number;result:Record<string,unknown>;state:Record<string,unknown>;
    contextError:InteractiveContextError|null;
  }>,context:Readonly<{signal:AbortSignal}>)=>string|null|void|Promise<string|null|void>>;
  verifyAgentResult?:BindingV1<'trusted-read',(input:Readonly<{
    id:string;name:string;runId:string;requestId:string;attempt:number;verifier:string;state:Record<string,unknown>;
    contextError:InteractiveContextError|null;
  }>,context:Readonly<{signal:AbortSignal}>)=>boolean|Promise<boolean>>;
}

export interface InteractivePolicyV1 {
  /** Optional absolute run deadline in epoch milliseconds, including durable waits. */
  businessDeadlineMs?:number;
  requiredBundleReviews?:readonly string[];
  professionalSkillPins?:ReadonlyArray<{nodeId:string;id:string;version:string;digest:string;source?:string}>;
  taskPolicy?: Omit<TaskPolicy,'fetch'|'authorizeRemote'|'isImmutableResource'|'authorizeRetry'> & {remoteSkillHosts?:string[]};
  id:string;
  version:string;
  bindingManifest:Readonly<Record<string,{id:string;version:string;mode:'pure-local'|'trusted-read'}>>;
  disclosePolicyId:string;
  capabilityStage:'P0-A'|'P0-B'|'P1'|'P2';
  /** Retain known losing external effects, or require verified compensation before the join. */
  parallelEffectMode?:'retain'|'compensate';
  canonicalizationVersion:'jcs-rfc8785-v1';
  requiredSkillManifestHash?:string;
}

export interface InteractiveOptionsV1 {
  readonly store:CheckpointStoreV1;
  readonly programRegistry:TrustedProgramRegistryV1;
  readonly policy:InteractivePolicyV1;
  readonly auth:TrustedHostContextV1;
  maxStagesPerCall?:number;
  signal?:AbortSignal;
}

type InteractiveFailedSubmission = {
  runId:string;requestId:string;outcome:'failed';error:{code:string;message:string;retryable?:boolean;
    sideEffectStatus?:'none'|'known'|'unknown';origin?:'runtime'|'executor'|'validator'|'store'|'policy'};
};
export type HostSubmissionV1 =
  | {kind:'agent';runId:string;requestId:string;outcome:'succeeded';result:Record<string,unknown>}
  | ({kind:'agent'|'verification'} & InteractiveFailedSubmission)
  | ({kind:'action';operationKey:string} & InteractiveFailedSubmission)
  | {kind:'action';runId:string;requestId:string;outcome:'succeeded';operationKey:string;
      result:{set:Record<string,unknown>;remove?:readonly string[]}}
  | {kind:'verification';runId:string;requestId:string;outcome:'succeeded';result:{passed:boolean}}
  | {kind:'human';runId:string;requestId:string;outcome:'succeeded';reviewDigest:string;bundleHash?:string;
      result:InteractiveHumanDecision};

export declare function start(source:string|TrustedProgramRefV1,runtime:InteractiveRuntimeV1,
  initialState:Record<string,unknown>,options:InteractiveOptionsV1&{startKey:string}):Promise<InteractiveFrameV1>;
export declare function complete(submission:HostSubmissionV1,runtime:InteractiveRuntimeV1,
  options:InteractiveOptionsV1):Promise<InteractiveFrameV1>;
export declare function resume(runId:string,runtime:InteractiveRuntimeV1,options:InteractiveOptionsV1):Promise<InteractiveFrameV1>;
export declare function listInteractiveForkPoints(input:{ref:RunViewerRef;nodeId:string;beforeRevision?:number},
  options:RunViewerOptions & {auth:TrustedHostContextV1}):Promise<{points:InteractiveForkPoint[];next:number|null}>;
export declare function forkInteractiveRun(input:{source:RunViewerRef;revision:number;entryRevision:number;startKey:string;redoWrites:boolean},
  runtime:InteractiveRuntimeV1,options:RunViewerOptions & {auth:TrustedHostContextV1}):Promise<InteractiveFrameV1>;
export declare function cancelInteractiveRun(runId:string,reasonCode:string,options:InteractiveOptionsV1):Promise<PublicInteractiveTerminalFrame>;
export declare function reserveInteractiveDispatch(input:{runId:string;requestId:string;operationId:string},
  runtime:InteractiveRuntimeV1,options:InteractiveOptionsV1):Promise<{deadlineMs:number;dispatches:number;providerRequests?:number}>;
