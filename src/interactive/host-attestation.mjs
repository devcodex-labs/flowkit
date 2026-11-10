import {canonicalBytes, safeJSONSnapshot, sha256Bytes, assertSHA256} from './canonical.mjs';

export const HOST_AGENT_ATTESTATION_DOMAIN = 'flowkit.host-agent-receipt.v1';
export const MAX_AGENT_RECEIPT_BYTES = 2 * 1024 * 1024;
const SIGNED_FIELDS = Object.freeze([
  'domain','keyId','proofId','namespace','runId','requestId','nodeId',
  'attempt','kind','artifactHash','policyHash','receiptHash','issuedAt','expiresAt',
]);

function rejected(reason) {
  // Do not echo untrusted body, task instructions, or signed secrets into errors.
  return Object.assign(new Error('FK_I_PROVENANCE_REJECTED: ' + reason), {
    code:'FK_I_PROVENANCE_REJECTED',
  });
}
function strictRecord(value, fields, required=fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw rejected('invalid object');
  }
  const keys=Object.keys(value);
  if (keys.some(k=>!fields.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) {
    throw rejected('invalid fields');
  }
}
function identifier(value, name, limit=256) {
  if (typeof value !== 'string' || value.length<1 || value.length>limit
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw rejected('invalid '+name);
  }
}
function boundedTime(value) {
  return Number.isSafeInteger(value) && value>0;
}

/**
 * A receipt is pure JSON data from a trusted Host transport. It never contains
 * a caller-supplied cursor, transition, approval, provenance or policy override.
 */
export function normalizeHostAgentReceipt(supplied) {
  let data;
  try { data=safeJSONSnapshot(supplied,MAX_AGENT_RECEIPT_BYTES); }
  catch { throw rejected('invalid receipt JSON'); }
  strictRecord(data,['runId','requestId','nodeId','attempt','kind','result','failure'],
    ['runId','requestId','nodeId','attempt','kind']);
  identifier(data.runId,'runId');
  identifier(data.requestId,'requestId');
  identifier(data.nodeId,'nodeId');
  if (!Number.isSafeInteger(data.attempt) || data.attempt<1 || data.attempt>11) {
    throw rejected('invalid Agent attempt');
  }
  if (data.kind === 'agent-result') {
    if (!Object.hasOwn(data,'result') || Object.hasOwn(data,'failure')) {
      throw rejected('invalid Agent result fields');
    }
  } else if (data.kind === 'agent-call-failed') {
    if (Object.hasOwn(data,'result') || !Object.hasOwn(data,'failure')) {
      throw rejected('invalid Agent failure fields');
    }
    strictRecord(data.failure,['message']);
    if (typeof data.failure.message !== 'string' || !data.failure.message.length
      || data.failure.message.length>4096) {
      throw rejected('invalid Agent failure message');
    }
  } else {
    // Includes Human, Action and Verification. P0-A never accepts them.
    throw rejected('unsupported receipt kind');
  }
  return data;
}

/**
 * Pure, signing-key-free canonical attestation statement builder.
 * A trusted Host may sign encodeAgentReceiptStatement(statement) with its
 * PRIVATE Ed25519 key, held outside model-visible filesystem/tool channels.
 */
export function createAgentReceiptStatement({
  run, receipt, keyId, proofId, issuedAt, expiresAt,
}={}) {
  const normalized=normalizeHostAgentReceipt(receipt);
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw rejected('missing authoritative run');
  }
  identifier(run.namespace,'namespace');
  assertSHA256(run.artifactHash);
  assertSHA256(run.policyHash);
  identifier(keyId,'keyId',64);
  identifier(proofId,'proofId',128);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(keyId)
    || !/^[a-zA-Z0-9_.:-]+$/.test(proofId)) {
    throw rejected('invalid proof identifier');
  }
  if (!boundedTime(issuedAt) || !boundedTime(expiresAt) || expiresAt<=issuedAt) {
    throw rejected('invalid proof time range');
  }
  return Object.freeze({
    domain: HOST_AGENT_ATTESTATION_DOMAIN,
    keyId,proofId,namespace:run.namespace,
    runId:normalized.runId,requestId:normalized.requestId,
    nodeId:normalized.nodeId,attempt:normalized.attempt,kind:normalized.kind,
    artifactHash:run.artifactHash,policyHash:run.policyHash,
    receiptHash:sha256Bytes(canonicalBytes(normalized,MAX_AGENT_RECEIPT_BYTES)),
    issuedAt,expiresAt,
  });
}

/** Canonical bytes for both Host signing and Host verifier; no JSON.stringify drift. */
export function encodeAgentReceiptStatement(input) {
  let statement;
  try { statement=safeJSONSnapshot(input,4096); }
  catch { throw rejected('invalid statement JSON'); }
  strictRecord(statement,SIGNED_FIELDS);
  if (statement.domain!==HOST_AGENT_ATTESTATION_DOMAIN) {
    throw rejected('incorrect proof domain');
  }
  identifier(statement.keyId,'keyId',64);
  identifier(statement.proofId,'proofId',128);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(statement.keyId)
    || !/^[a-zA-Z0-9_.:-]+$/.test(statement.proofId)) {
    throw rejected('invalid proof identifier');
  }
  for (const k of ['namespace','runId','requestId','nodeId']) {
    identifier(statement[k],k);
  }
  if (!Number.isSafeInteger(statement.attempt) || statement.attempt<1
    || statement.attempt>11 || !['agent-result','agent-call-failed'].includes(statement.kind)) {
    throw rejected('invalid Agent identity');
  }
  for (const k of ['artifactHash','policyHash','receiptHash']) {
    try { assertSHA256(statement[k]); }
    catch { throw rejected('invalid '+k); }
  }
  if (!boundedTime(statement.issuedAt) || !boundedTime(statement.expiresAt)
    || statement.expiresAt<=statement.issuedAt) {
    throw rejected('invalid time');
  }
  return canonicalBytes(statement,4096);
}
