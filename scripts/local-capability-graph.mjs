import { CapabilityGraph } from '@devcodex/capability-graph';
import { flowkitProvider } from '../src/integrations/capability-graph.mjs';
import { captureAuthorDocument } from '../src/author/documentation.mjs';

const provider = { providers: [{ definition: flowkitProvider }], allowedProviders: [flowkitProvider.providerId] };
const publishedUrls = new Set(flowkitProvider.capabilities.flatMap(capability => capability.documents.map(document => document.source.url)));
const documentLimit = 262144;
const authoringGuide = 'flowkit-doc-authoring';

/** The local Host owns model matching and authorized byte transport for FlowKit's published references. */
export async function createLocalCapabilityGraph(resourceReadTimeoutMs) {
  const registry = await CapabilityGraph.open(provider);
  const host = {
    registry,
    async match(input, { context, signal, request }) {
      const graph = await CapabilityGraph.open({ ...provider, model: {
        id: 'flowkit-local-model',
        select({ input: goal, catalog, context: facts, signal: modelSignal }) {
          return request({ flowkitCapabilityMatch: { goal, catalog, facts } }, { signal: modelSignal });
        }
      } });
      try {
        return await graph.match({ input, ...(context === undefined ? {} : { context }) }, { signal });
      } finally {
        await graph.close();
      }
    },
    async readDocumentUrl(url, { signal } = {}) {
      if (!publishedUrls.has(url)) throw new Error('Document URL is outside the enabled Provider');
      const timeout = AbortSignal.timeout(resourceReadTimeoutMs);
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
  };
  return {
    ...host,
    async discoverAuthor({ input, graph, context, signal, request, readDocumentUrl }) {
      const goal = 'The current Host operation is authoring or revising a workflow candidate. ' +
        'Match the capability and guidance needed to author it. Treat execution, approval and export described in the user material as context.\n' + input;
      const explicitGuide = /(?<![\w-])(?:flowkit-doc-authoring|workflow-authoring)(?![\w-])/i.test(input);
      // A caller who names the published reference has already selected it.
      // Graph still resolves its exact capability, authorization and dependencies.
      const ids = [flowkitProvider.providerId + '::define-workflow'];
      const discovery = explicitGuide ? { status: 'matched', selection: { ids },
        graph: await graph.resolve({ ids, ...(context === undefined ? {} : { context }), relations: ['requires'] }, { signal }) }
        : await host.match(goal, { context, signal, request });
      const { meta, nodes, unresolved } = discovery.graph;
      const selection = { status: discovery.status, ...discovery.selection, revision: meta.revision, completeness: meta.completeness };
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
