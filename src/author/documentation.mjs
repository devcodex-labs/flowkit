import { artifactDigest } from '../shared/artifact-identity.mjs';

/** Read one explicitly selected document with its recorded Graph revision and byte identity. */
export async function readAuthorDocument(graph, pin, readUrl) {
  const { capabilityId, documentId, revision, contentHash } = pin;
  if (typeof revision !== 'string' || !revision || typeof contentHash !== 'string' || contentHash.length !== 71 ||
    !/^sha256:[a-f0-9]{64}$/.test(contentHash)) throw new TypeError('Choose a recorded document revision and SHA-256');
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
    if (document.meta.revision !== revision || document.contentHash !== contentHash || document.source.path !== source.path) {
      throw new Error('Graph document version or content changed after selection');
    }
    return { text: document.text, evidence: { capabilityId, documentId, revision, contentHash, source } };
  }
  if (source.type !== 'url' || source.url !== pin.url || !source.url.startsWith('https://') || typeof readUrl !== 'function') {
    throw new Error('The Host must authorize the exact published document URL');
  }
  const response = await readUrl(source.url);
  if (response.url !== source.url || !(response.bytes instanceof Uint8Array) || artifactDigest(response.bytes) !== contentHash) {
    throw new Error('Published document URL or content differs from the planned version');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
  return { text, evidence: { capabilityId, documentId, revision, contentHash, source } };
}
