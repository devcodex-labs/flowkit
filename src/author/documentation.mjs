import { artifactDigest } from '../shared/artifact-identity.mjs';

/** Read one explicitly selected document with its recorded Graph revision and byte identity. */
export async function readAuthorDocument(graph, pin, readUrl) {
  const { revision, contentHash } = pin;
  if (typeof revision !== 'string' || !revision || typeof contentHash !== 'string' || contentHash.length !== 71 ||
    !/^sha256:[a-f0-9]{64}$/.test(contentHash)) throw new TypeError('Choose a recorded document revision and SHA-256');
  const captured = await captureAuthorDocument(graph, { ...pin, url: pin.url ?? null }, readUrl);
  if (captured.evidence.contentHash !== contentHash) {
    throw new Error(captured.evidence.source.type === 'url' ? 'Published document URL or content differs from the planned version' :
      'Graph document version or content changed after selection');
  }
  return captured;
}

/** Capture an explicitly chosen Graph document through the authorized Host reader. */
export async function captureAuthorDocument(graph, { capabilityId, documentId, revision, url }, readUrl) {
  const result = await graph.getCapabilities({ ids: [capabilityId] });
  if (result.meta.revision !== revision || result.meta.completeness !== 'complete') {
    throw new Error('Capability Graph revision differs from the planned document source');
  }
  const selected = result.items.find(item => item.capability.id === capabilityId)?.capability.documents
    .find(document => document.id === documentId);
  if (!selected) throw new Error('The document is not declared by the selected capability');
  const source = selected.source;
  if (source.type === 'file') {
    const document = await graph.readDocument({ capabilityId, documentId });
    if (document.meta.revision !== revision || document.source.path !== source.path) {
      throw new Error('Graph document version or content changed after selection');
    }
    return { text: document.text, evidence: { capabilityId, documentId, revision, contentHash: document.contentHash, source } };
  }
  if (source.type !== 'url' || (url !== undefined && source.url !== url) ||
      !source.url.startsWith('https://') || typeof readUrl !== 'function') {
    throw new Error('The Host must authorize the exact published document URL');
  }
  const response = await readUrl(source.url);
  if (response.url !== source.url || !(response.bytes instanceof Uint8Array)) {
    throw new Error('Published document URL or content differs from the planned version');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
  return { text, evidence: { capabilityId, documentId, revision, contentHash: artifactDigest(response.bytes), source } };
}
