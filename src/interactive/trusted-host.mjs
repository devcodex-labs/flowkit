import {
  createPublicKey, verify as verifySignature, timingSafeEqual,
} from 'node:crypto';
import {MAX_CHECKPOINT_BYTES, canonicalBytes, safeJSONSnapshot, sha256Bytes, assertSHA256} from './canonical.mjs';
import {createInteractiveCoordinator} from './coordinator.mjs';
import {
  createAgentReceiptStatement,encodeAgentReceiptStatement,
  normalizeHostAgentReceipt,
} from './host-attestation.mjs';

function denied(detail='authentication or disclosure denied') {
  return Object.assign(new Error('FK_I_HOST_DENIED: '+detail), {code:'FK_I_HOST_DENIED'});
}
function invalidProof() {
  // A deliberately uniform external error; no information about key, tenant,
  // underlying state or expected signed content leaks to model-controlled input.
  return Object.assign(new Error('FK_I_PROVENANCE_REJECTED'), {code:'FK_I_PROVENANCE_REJECTED'});
}
function name(value) {
  if (typeof value!=='string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) {
    throw new TypeError('Invalid Host binding identifier');
  }
  return value;
}
function hash(value) {
  try { assertSHA256(value);return value; }
  catch { throw new TypeError('Invalid trusted artifact hash'); }
}
function strictFields(object,fields) {
  if (!object || typeof object!=='object' || Array.isArray(object)
    || Object.keys(object).length!==fields.length
    || fields.some(k=>!Object.hasOwn(object,k))) {
    throw invalidProof();
  }
}
function normalizeKeys(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) {
    throw new TypeError('trustedPublicKeys must be a Host-owned key-id map');
  }
  const entries=Object.entries(input);
  if (!entries.length || entries.length>32) {
    throw new TypeError('At least one trusted Host public key is required');
  }
  const keys=new Map();
  const fingerprints=[];
  for (const [id,value] of entries) {
    name(id);
    let key;
    try {
      key=value?.type==='public' && value?.asymmetricKeyType
        ? value : createPublicKey(value);
    } catch {
      throw new TypeError('Invalid Host public key');
    }
    if (key.type!=='public' || key.asymmetricKeyType!=='ed25519') {
      throw new TypeError('Host attestation requires Ed25519 public keys');
    }
    const fingerprint=sha256Bytes(key.export({type:'spki',format:'der'}));
    keys.set(id,key);
    fingerprints.push({id,publicKeyHash:fingerprint});
  }
  // Deterministic UTF-16 ordering across Node/OS locale configurations.
  fingerprints.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  return {keys,fingerprints};
}
function keysArray(value,label,max) {
  if (!Array.isArray(value) || value.length>max || !value.every(x=>typeof x==='string'
    && x.length>0 && x.length<=256 && !/[\u0000-\u001f\u007f]/.test(x))
    || new Set(value).size!==value.length) {
    throw new TypeError('Invalid '+label);
  }
  return [...value].sort();
}
function numericPolicy(value,label,max) {
  if (!Number.isSafeInteger(value) || value<0 || value>max) {
    throw new TypeError('Invalid '+label);
  }
  return value;
}

function terminalNode(checkpoint) {
  if (checkpoint.status==='succeeded' || checkpoint.status==='failed') {
    if (typeof checkpoint.terminal?.nodeId!=='string'
      || checkpoint.terminal.status!==checkpoint.status) throw denied();
    return {nodeId:checkpoint.terminal.nodeId,status:checkpoint.status};
  }
}

/**
 * Trusted Host facade for the existing P0-A Coordinator. The Host keeps
 * SQLite, runtime callbacks, and signing private key outside model access.
 *
 * Warning: this is NOT an in-process sandbox. A model with the same OS
 * privileges as the Host, or direct Store/Coordinator access, bypasses it.
 */
export function createTrustedInteractiveHost({
  store,runtime,policy={},
  trustedPublicKeys,trustedArtifacts,
  allowedInputKeys=[],
  disclosurePolicyId,authorizeDisclosure,authorizeTerminalAccess,
  maxProofAgeMs=5*60*1000,clockSkewMs=5000,
  now=()=>Date.now(),maxStagesPerCall=128,
}={}) {
  if (!store || typeof store.namespace!=='string'
    || typeof store.load!=='function' || typeof store.getArtifact!=='function') {
    throw new TypeError('A namespace-scoped Host-owned CheckpointStore is required');
  }
  if (typeof now!=='function' || typeof authorizeDisclosure!=='function') {
    throw new TypeError('Trusted Host clock and disclosure authorizer are required');
  }
  if (authorizeTerminalAccess!==undefined && typeof authorizeTerminalAccess!=='function') {
    throw new TypeError('Terminal access authorizer must be a function');
  }
  name(disclosurePolicyId);
  numericPolicy(maxProofAgeMs,'maxProofAgeMs',3600000);
  if (maxProofAgeMs<1000) throw new TypeError('maxProofAgeMs must be >= 1000');
  numericPolicy(clockSkewMs,'clockSkewMs',30000);
  if (!Array.isArray(trustedArtifacts) || trustedArtifacts.length<1
    || trustedArtifacts.length>1000) {
    throw new TypeError('trustedArtifacts must be a nonempty Host-owned allowlist');
  }
  const approvedArtifacts=keysArray(trustedArtifacts,'trustedArtifacts',1000).map(hash);
  const approvalSet=new Set(approvedArtifacts);
  const permittedInputs=keysArray(allowedInputKeys,'allowedInputKeys',256);
  const allowed=new Set(permittedInputs);
  const {keys:publicKeys,fingerprints}=normalizeKeys(trustedPublicKeys);
  const policySnapshot=safeJSONSnapshot(policy);
  if (!policySnapshot || typeof policySnapshot!=='object'
    || Array.isArray(policySnapshot) || Object.hasOwn(policySnapshot,'hostSecurity')) {
    throw new TypeError('Host policy must be a JSON object without reserved hostSecurity');
  }
  const securityConfig=Object.freeze({
    schemaVersion:1,mode:'ed25519-agent-receipt',
    keyFingerprints:fingerprints,
    approvedArtifactHashes:approvedArtifacts,
    publicAgentInputKeys:permittedInputs,
    disclosurePolicyId,maxProofAgeMs,clockSkewMs,
  });
  const effectivePolicy={
    ...policySnapshot,
    hostSecurity:securityConfig,
  };
  const coordinator=createInteractiveCoordinator({
    store,runtime,policy:effectivePolicy,maxStagesPerCall,
  });

  function assertPinned(runId) {
    const cp=store.load(runId);
    if (!cp || cp.namespace!==store.namespace
      || cp.policyHash!==coordinator.policyHash
      || !approvalSet.has(cp.artifactHash)) {
      throw denied();
    }
    return cp;
  }

  /** No bytes are imported until the Host's compiler artifact allowlist passes. */
  async function start(options={}) {
    if (!options || typeof options!=='object'
      || !options.programIdentity || !approvalSet.has(options.programIdentity.artifactHash)) {
      throw denied('unapproved Program artifact');
    }
    if (!(options.programBytes instanceof Uint8Array)
      || options.programBytes.byteLength>4*1024*1024) {
      throw denied('unapproved Program bytes');
    }
    return coordinator.start(options);
  }

  async function resume({runId}={}) {
    assertPinned(runId);
    return coordinator.resume({runId});
  }
  async function load({runId}={}) {
    const cp=store.load(runId);
    if (cp===null) return null;
    assertPinned(runId);
    return coordinator.load({runId});
  }

  async function loadAuthorizedTerminal(runId, action, revision) {
    if (!authorizeTerminalAccess || typeof runId!=='string' || runId.length<1
      || runId.length>256 || /[\u0000-\u001f\u007f]/.test(runId)) throw denied();
    const checkpoint=assertPinned(runId);
    if (checkpoint.runId!==runId || !['succeeded','failed','errored','cancelled'].includes(checkpoint.status)
      || (revision!==undefined && revision!==checkpoint.revision)) throw denied();

    let decision;
    try {
      decision=await authorizeTerminalAccess(Object.freeze({
        action,namespace:checkpoint.namespace,runId,revision:checkpoint.revision,
      }));
    } catch {
      throw denied();
    }
    if (decision!==true) throw denied();

    const current=assertPinned(runId);
    if (current.runId!==runId || current.revision!==checkpoint.revision
      || current.status!==checkpoint.status) throw denied();
    return current;
  }

  async function getPublicTerminalFrame({runId}={}) {
    const checkpoint=await loadAuthorizedTerminal(runId,'run:read');
    const {revision,status}=checkpoint;
    const terminal=terminalNode(checkpoint);
    return {
      protocolVersion:1,runId,revision,status,pending:[],
      checkpointRef:{runId,revision},
      ...(terminal ? {terminal} : {}),
      resultRef:{runId,revision,projectionVersion:1},
    };
  }

  async function readTrustedTerminalResult(input) {
    let resultRef;
    try {
      resultRef=safeJSONSnapshot(input,2048)?.resultRef;
    } catch {
      throw denied();
    }
    if (!resultRef || Object.keys(resultRef).length!==3 || resultRef.projectionVersion!==1
      || !Number.isSafeInteger(resultRef.revision) || resultRef.revision<0) throw denied();
    const checkpoint=await loadAuthorizedTerminal(resultRef.runId,'result:read',resultRef.revision);
    const terminal=terminalNode(checkpoint);
    const causeCode=checkpoint.terminal?.causeCode;
    return safeJSONSnapshot({
      projectionVersion:1,namespace:checkpoint.namespace,runId:checkpoint.runId,
      status:checkpoint.status,state:checkpoint.state,contextError:null,
      ...(terminal ? {terminal} : {}),
      ...(typeof causeCode==='string' ? {causeCode} : {}),
    },MAX_CHECKPOINT_BYTES);
  }

  /**
   * This is the ONLY task structure to send to the model. It is derived from
   * authoritative Store state (never a caller-supplied frame), enforces an
   * explicit input allowlist, then requires an affirmative Host disclosure gate.
   */
  async function getPublicAgentTask({runId}={}) {
    const cp=assertPinned(runId);
    if (cp.status!=='waiting') return null;
    const frame=await coordinator.load({runId});
    const pending=frame?.pending;
    if (!pending || pending.kind!=='agent' || pending.runId!==runId) {
      throw denied('pending task cannot be certified');
    }
    // Missing declared inputs reveal field names too; they require approval.
    if ([...Object.keys(pending.input),...pending.missing].some(key=>!allowed.has(key))) {
      throw denied('Agent input is not on the disclosure allowlist');
    }
    const task=safeJSONSnapshot({
      schemaVersion:1,kind:'agent',
      id:pending.id,nodeId:pending.nodeId,runId:pending.runId,
      requestId:pending.requestId,attempt:pending.attempt,
      name:pending.name,instruction:pending.instruction,
      input:pending.input,missing:pending.missing,
      resultSchema:pending.resultSchema,reasons:pending.reasons,
      ...(pending.overview?{overview:pending.overview}:{}),
    },MAX_CHECKPOINT_BYTES);
    let decision;
    try {
      decision=await authorizeDisclosure(
        Object.freeze(safeJSONSnapshot({
          namespace:cp.namespace,runId,requestId:pending.requestId,task,
          disclosurePolicyId,
        },MAX_CHECKPOINT_BYTES)),
      );
    } catch {
      // Host-private DLP details must not leak into the model-facing error.
      throw denied('Host did not approve model disclosure');
    }
    if (decision!==true) throw denied('Host did not approve model disclosure');
    // An async disclosure gate may overlap a successful receipt/commit from a
    // separate Host process. Never hand the model a superseded Pending.
    const current=store.load(runId);
    if (!current || current.status!=='waiting' || current.revision!==cp.revision
      || current.policyHash!==cp.policyHash
      || current.pending?.requestId!==pending.requestId) {
      throw denied('Pending changed during Host authorization');
    }
    return task;
  }

  /** Validate the independent Host signature before ANY receipt CAS. */
  async function accept({receipt,attestation}={}) {
    const normalized=normalizeHostAgentReceipt(receipt);
    let cp;
    try { cp=assertPinned(normalized.runId); }
    catch { throw invalidProof(); }
    let proof;
    try { proof=safeJSONSnapshot(attestation,8192); }
    catch { throw invalidProof(); }
    strictFields(proof,['statement','signature']);
    let statement,encoded,expected,signature;
    try {
      statement=safeJSONSnapshot(proof.statement,4096);
      encoded=encodeAgentReceiptStatement(statement);
      const current=now();
      // Re-acknowledging an already accepted byte-identical receipt is safe
      // after expiry: the durable ledger proves no new receipt is being
      // introduced. NEW receipts still require fresh proofs and signatures
      // are checked in both cases; raw Coordinator access stays Host-private.
      const receiptDigest=sha256Bytes(canonicalBytes(normalized));
      const previous=typeof store.getReceipt==='function'
        ? store.getReceipt(normalized.runId,normalized.requestId)
        : cp.receipts?.find(r=>r.requestId===normalized.requestId);
      const alreadyAccepted=previous?.requestId===normalized.requestId
        && previous.nodeId===normalized.nodeId
        && previous.attempt===normalized.attempt && previous.digest===receiptDigest;
      if (!Number.isSafeInteger(current) || current<=0
        || statement.issuedAt>current+clockSkewMs
        || (statement.expiresAt<current-clockSkewMs && !alreadyAccepted)
        || statement.expiresAt-statement.issuedAt>maxProofAgeMs) {
        throw invalidProof();
      }
      const key=publicKeys.get(statement.keyId);
      if (!key || typeof proof.signature!=='string'
        || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature)) {
        throw invalidProof();
      }
      signature=Buffer.from(proof.signature,'base64url');
      if (signature.byteLength!==64
        || signature.toString('base64url')!==proof.signature) throw invalidProof();
      expected=createAgentReceiptStatement({
        run:cp,receipt:normalized,keyId:statement.keyId,
        proofId:statement.proofId,
        issuedAt:statement.issuedAt,expiresAt:statement.expiresAt,
      });
      const expectedBytes=encodeAgentReceiptStatement(expected);
      if (encoded.byteLength!==expectedBytes.byteLength
        || !timingSafeEqual(encoded,expectedBytes)
        || !verifySignature(null,encoded,key,signature)) {
        throw invalidProof();
      }
    } catch {
      throw invalidProof();
    }
    // The underlying Coordinator retains all M4 identity/CAS/retry checks.
    // The model receives neither this closure nor a raw complete() capability.
    return coordinator.complete(normalized);
  }

  return Object.freeze({
    start,resume,load,getPublicAgentTask,getPublicTerminalFrame,readTrustedTerminalResult,accept,
    policyHash:coordinator.policyHash,
    securityMode:'ed25519-agent-receipt-v1',
  });
}
