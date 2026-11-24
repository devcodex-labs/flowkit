import {
  constants, createCipheriv, createDecipheriv, createPublicKey, privateDecrypt,
  publicEncrypt, randomBytes, sign, verify
} from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { checkCandidate } from './standard-artifact.mjs';
import { resolveTrustedProfessionalPin } from './professional-skills.mjs';

const domain = 'flowkit-offline-dependencies-v1';
const maxPlainBytes = 12 * 1024 * 1024;
const maxEnvelopeBytes = 17 * 1024 * 1024;
const padding = constants.RSA_PKCS1_OAEP_PADDING;
const envelopeFields = ['candidateHash', 'ciphertext', 'domain', 'issuer', 'iv', 'key', 'recipient', 'signature', 'tag'];

const reject = message => Object.assign(new Error(message), { code: 'FKA_OFFLINE_DEPENDENCIES' });
const skillKey = ({ source, id, version, digest }) => JSON.stringify([source, id, version, digest]);
const documentKey = ({ capabilityId, documentId, revision, contentHash, source }) =>
  JSON.stringify([capabilityId, documentId, revision, contentHash, source?.type, source?.path ?? source?.url]);
const deduplicate = (items, key) => new Map(items.map(item => [key(item), item]));
const encodedKey = key => key.export({ type: 'spki', format: 'der' }).toString('base64url');
const sha256 = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const header = ({ issuer, recipient, candidateHash }) => JSON.stringify([domain, issuer, recipient, candidateHash]);
const signed = data => Buffer.from(JSON.stringify([header(data), data.key, data.iv, data.tag, data.ciphertext]));

function decode(value, bytes) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]*$/.test(value)) throw reject('Invalid offline dependency encoding');
  const result = Buffer.from(value, 'base64url');
  if (result.toString('base64url') !== value || bytes !== undefined && result.length !== bytes) {
    throw reject('Invalid offline dependency encoding');
  }
  return result;
}

function checkRecipient(key, type) {
  if (key?.type !== type || key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new TypeError('An RSA recipient KeyObject of at least 2048 bits is required');
  }
}

function checkWorkflow(candidate) {
  checkCandidate(candidate);
  if (Object.keys(candidate.files).some(name => name.startsWith('source/'))) {
    throw reject('Export the approved compiled Workflow Skill without DSL source');
  }
}

async function exactSkill(pin, material, collectionId) {
  const snapshot = structuredClone(material);
  if (!pin.source || !sha256(pin.digest) || !await resolveTrustedProfessionalPin({}, pin, {
    collectionId, resolve: () => snapshot
  })) throw reject('An approved exact Professional Skill is unavailable: ' + pin.id);
  return { authorized: true, source: pin.source, candidate: snapshot.candidate };
}

/** Package an approved Workflow version for a single recipient. It does not grant authority to execute. */
export async function sealOfflineWorkflowDependencies({ store, target, signerPrivateKey, recipientPublicKey,
  authorize, resolveProfessionalSkill, readDocument }) {
  checkRecipient(recipientPublicKey, 'public');
  if (signerPrivateKey?.type !== 'private' || signerPrivateKey.asymmetricKeyType !== 'ed25519' || typeof authorize !== 'function') {
    throw new TypeError('A Host authorization callback and an Ed25519 signing key are required');
  }
  const { collectionId, skillId, candidateHash } = target;
  const workflow = structuredClone(store.readVersion(collectionId, skillId, candidateHash));
  if (!workflow || workflow.hash !== candidateHash || workflow.manifest.collectionId !== collectionId || workflow.manifest.skillId !== skillId) {
    throw reject('No approved Workflow Skill at the requested identity');
  }
  checkWorkflow(workflow);
  const issuer = encodedKey(createPublicKey(signerPrivateKey));
  const recipient = artifactDigest(encodedKey(recipientPublicKey));
  const scope = Object.freeze({ issuer, recipient, collectionId, skillId, candidateHash });
  if (await authorize(Object.freeze({ action: 'export', ...scope })) !== true) throw reject('The Host denied the offline dependency export');

  const skills = [];
  const documents = [];
  for (const [key, pin] of deduplicate(workflow.manifest.professionalSkills, skillKey)) {
    const selection = structuredClone(pin);
    const supplied = await resolveProfessionalSkill?.(selection, scope);
    skills.push([key, await exactSkill(pin, supplied, collectionId)]);
  }
  for (const [key, pin] of deduplicate(workflow.manifest.documents ?? [], documentKey)) {
    const supplied = await readDocument?.(structuredClone(pin), scope);
    if (supplied?.authorized !== true || !(supplied.bytes instanceof Uint8Array)) {
      throw reject('An approved exact document is unavailable: ' + pin.documentId);
    }
    const bytes = Buffer.from(supplied.bytes);
    if (artifactDigest(bytes) !== pin.contentHash) throw reject('An approved document changed: ' + pin.documentId);
    documents.push([key, bytes.toString('base64url')]);
  }

  const payload = Buffer.from(JSON.stringify({ workflow, skills, documents }));
  if (payload.length > maxPlainBytes) throw reject('The offline dependency package exceeds the byte budget');
  const secret = randomBytes(32), iv = randomBytes(12);
  try {
    const envelope = { domain, issuer, recipient, candidateHash,
      key: publicEncrypt({ key: recipientPublicKey, padding, oaepHash: 'sha256' }, secret).toString('base64url'),
      iv: iv.toString('base64url') };
    const cipher = createCipheriv('aes-256-gcm', secret, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(header(envelope)));
    envelope.ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64url');
    envelope.tag = cipher.getAuthTag().toString('base64url');
    envelope.signature = sign(null, signed(envelope), signerPrivateKey).toString('base64url');
    return JSON.stringify(envelope);
  } finally {
    secret.fill(0);
  }
}

function exactEntries(items, expected) {
  if (!Array.isArray(items) || items.length !== expected.size ||
      items.some(pair => !Array.isArray(pair) || pair.length !== 2 || !expected.has(pair[0]))) {
    throw reject('Offline dependencies differ from the approved Workflow pins');
  }
  const result = new Map(items);
  if (result.size !== expected.size) throw reject('Offline dependencies contain duplicate pins');
  return result;
}

/** Authenticate, decrypt and open with the receiving Host. Each use rechecks the current grant. */
export async function openOfflineWorkflowDependencies(encoded, { recipientPrivateKey, isTrustedSigner, authorize }) {
  checkRecipient(recipientPrivateKey, 'private');
  if (typeof isTrustedSigner !== 'function' || typeof authorize !== 'function') throw new TypeError('Host trust and permission callbacks are required');
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxEnvelopeBytes) throw reject('Invalid offline dependency package size');
  let data;
  try { data = JSON.parse(encoded); } catch { throw reject('Invalid offline dependency package'); }
  if (!data || Object.keys(data).sort().join() !== envelopeFields.join() || data.domain !== domain ||
      !sha256(data.candidateHash) || data.recipient !== artifactDigest(encodedKey(createPublicKey(recipientPrivateKey)))) {
    throw reject('The offline dependency package does not match this recipient');
  }
  const access = async (action, extra = {}) => await isTrustedSigner(data.issuer) === true &&
    await authorize(Object.freeze({ action, issuer: data.issuer, recipient: data.recipient, candidateHash: data.candidateHash, ...extra })) === true;
  let signer;
  try { signer = createPublicKey({ key: decode(data.issuer, 44), type: 'spki', format: 'der' }); }
  catch { throw reject('Invalid offline dependency signature'); }
  if (signer.asymmetricKeyType !== 'ed25519' || encodedKey(signer) !== data.issuer ||
      !verify(null, signed(data), signer, decode(data.signature, 64)) || !await access('import')) {
    throw reject('The Host could not verify or authorize the offline dependency package');
  }

  let payload, secret;
  try {
    secret = privateDecrypt({ key: recipientPrivateKey, padding, oaepHash: 'sha256' }, decode(data.key));
    const decipher = createDecipheriv('aes-256-gcm', secret, decode(data.iv, 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(header(data)));
    decipher.setAuthTag(decode(data.tag, 16));
    const ciphertext = decode(data.ciphertext);
    if (ciphertext.length > maxPlainBytes) throw reject('The offline dependency package exceeds the byte budget');
    payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch { throw reject('Offline dependency authentication or decryption failed'); }
  finally { secret?.fill(0); }
  const workflow = payload?.workflow;
  if (workflow?.hash !== data.candidateHash) throw reject('The offline Workflow does not match the approved candidate');
  checkWorkflow(workflow);
  const { manifest } = workflow;
  const expectedSkills = deduplicate(manifest.professionalSkills, skillKey);
  const expectedDocuments = deduplicate(manifest.documents ?? [], documentKey);
  const skills = exactEntries(payload.skills, expectedSkills);
  const documents = exactEntries(payload.documents, expectedDocuments);
  for (const [key, pin] of expectedSkills) skills.set(key, await exactSkill(pin, skills.get(key), manifest.collectionId));
  for (const [key, pin] of expectedDocuments) {
    const bytes = decode(documents.get(key));
    if (artifactDigest(bytes) !== pin.contentHash) throw reject('An approved document changed: ' + pin.documentId);
    documents.set(key, bytes);
  }
  const issuer = artifactDigest(data.issuer);
  return Object.freeze({
    issuer,
    workflow: structuredClone(workflow),
    async readDocument(pin) {
      const key = documentKey(pin);
      const exact = expectedDocuments.get(key);
      if (!exact || !await access('read-document', { pin: structuredClone(exact) })) return null;
      return { bytes: Buffer.from(documents.get(key)), evidence: structuredClone(exact) };
    },
    resolverFor(approved) {
      checkCandidate(approved);
      const source = approved.manifest.importedFrom;
      if (approved.manifest.artifactHash !== manifest.artifactHash ||
          approved.hash !== workflow.hash && (source?.hash !== workflow.hash || source.issuer !== issuer)) {
        throw reject('The receiving Workflow is not the same signed version');
      }
      const { collectionId, skillId, artifactHash } = approved.manifest;
      const approvedHash = approved.hash;
      return async (pin, scope) => {
        const found = skills.get(skillKey(pin));
        if (!found || scope?.collectionId !== collectionId || scope.skillId !== skillId ||
            scope.candidateHash !== approvedHash || scope.artifactHash !== artifactHash ||
            !await access('read-skill', { pin: structuredClone(pin), execution: Object.freeze({ collectionId, skillId, candidateHash: approvedHash, executionRef: scope.executionRef }) })) return null;
        return structuredClone(found);
      };
    }
  });
}
