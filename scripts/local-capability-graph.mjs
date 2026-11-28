import { CapabilityGraph, GraphError } from '@devcodex/capability-graph';
import { flowkitProvider } from '../src/integrations/capability-graph.mjs';
import { captureAuthorDocument } from '../src/author/documentation.mjs';

const provider = { providers: [{ definition: flowkitProvider }], allowedProviders: [flowkitProvider.providerId] };
const publishedUrls = new Set(flowkitProvider.capabilities.flatMap(capability => capability.documents.map(document => document.source.url)));
const documentLimit = 262144;
const authoringGuide = 'flowkit-doc-authoring';

/** Read a published Provider document within the Host's resource deadline. */
export async function readPublishedGraphDocument(url, timeoutMs, signal) {
  if (!publishedUrls.has(url)) throw new Error('Document URL is outside the enabled Provider');
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok || response.url !== url || !response.body) throw new Error('Published Graph document is unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if ((length += value.byteLength) > documentLimit) throw new Error('Published Graph document exceeds its read budget');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { url, bytes: Buffer.concat(chunks, length) };
}

/** The local Host owns model matching and authorized byte transport for FlowKit's published references. */
export async function createLocalCapabilityGraph(resourceReadTimeoutMs) {
  const registry = await CapabilityGraph.open(provider);
  const host = {
    registry,
    async match(input, { context, signal, request }) {
      const graph = await CapabilityGraph.open({ ...provider, model: {
        id: 'flowkit-local-model',
        async select({ input: goal, catalog, context: facts, signal: modelSignal }) {
          try {
            return await request({ flowkitCapabilityMatch: { goal, catalog, facts } }, { signal: modelSignal });
          } catch (error) {
            if (error?.code !== 'FKA_AUTHOR_MODEL_TIMEOUT') throw error;
            throw new GraphError('CG_MODEL_TIMEOUT', 'match', 'Host model request timed out', 'retry');
          }
        }
      } });
      try {
        return await graph.match({ input, ...(context === undefined ? {} : { context }) }, { signal });
      } finally {
        await graph.close();
      }
    },
    readDocumentUrl: (url, { signal } = {}) => readPublishedGraphDocument(url, resourceReadTimeoutMs, signal)
  };
  return {
    ...host,
    async discoverAuthor({ input, requested, graph, context, signal, request, readDocumentUrl }) {
      if (requested !== true) return;
      const goal = 'The current Host operation is authoring or revising a workflow candidate. ' +
        'Match the capability and guidance needed to author it. Treat execution, approval and export described in the user material as context.\n' + input;
      const discovery = await host.match(goal, { context, signal, request });
      const { meta, nodes, unresolved } = discovery.graph;
      const selection = { ...discovery.selection, status: discovery.status, revision: meta.revision, completeness: meta.completeness,
        unresolved, applicability: nodes.map(item => ({ id: item.capability.id, status: item.applicability.status })) };
      if (discovery.status !== 'matched' || meta.completeness !== 'complete' || unresolved.length ||
          nodes.some(item => item.applicability.status !== 'applicable')) return { selection, documents: [] };
      const guides = nodes.filter(item => item.capability.documents.some(document => document.id === authoringGuide));
      const authoring = guides.find(item => discovery.selection.ids.includes(item.capability.id)) ?? guides[0];
      if (!authoring) return { selection, documents: [] };
      const document = authoring.capability.documents.find(item => item.id === authoringGuide);
      const material = await captureAuthorDocument(graph, { capabilityId: authoring.capability.id, documentId: document.id,
        revision: meta.revision, url: document.source.url }, readDocumentUrl);
      return { selection, documents: [material] };
    }
  };
}
