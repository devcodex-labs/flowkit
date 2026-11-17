import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CapabilityGraph, GraphError } from '@devcodex/capability-graph';
import { createCapabilityGraphActionAdapter, flowkitProvider } from '@devcodex-labs/flowkit/capability-graph';
import { executeDemo, demoProvider, toolingProvider } from './host.mjs';

const config = {
  providers: [{ definition: flowkitProvider }, { definition: demoProvider }, { definition: toolingProvider }],
  allowedProviders: ['flowkit', 'demo', 'tooling'],
};
const graph = await CapabilityGraph.open(config);
try {
  const catalog = await graph.listCatalog();
  assert(catalog.items.some(item => item.id === 'flowkit::compile-workflow'));
  const compile = await graph.resolve({ ids: ['flowkit::render-mermaid'] });
  assert.deepEqual(compile.selected, ['flowkit::render-mermaid']);
  assert(compile.nodes.some(item => item.capability.id === 'flowkit::compile-workflow'));
  assert(compile.nodes.some(item => item.capability.id === 'flowkit::define-workflow' && item.applicability.status === 'applicable'));
  const shared = await graph.getCapabilities({ ids: ['flowkit::compile-workflow', 'flowkit::check-workflow'] });
  const sharedDocuments = shared.items.map(item => item.capability.documents.find(doc => doc.id === 'flowkit-doc-compile'));
  assert(sharedDocuments.every(doc => doc?.source.type === 'url'));
  assert.deepEqual(sharedDocuments[0], sharedDocuments[1]);
  await assert.rejects(graph.readDocument({ capabilityId: 'flowkit::compile-workflow', documentId: 'flowkit-doc-compile' }),
    { code: 'CG_DOCUMENT_REFERENCE_ONLY' });
  await assert.rejects(graph.readDocument({ capabilityId: 'flowkit::compile-workflow', documentId: 'missing-document' }),
    { code: 'CG_DOCUMENT_NOT_FOUND' });
  const resolved = await graph.resolve({ ids: ['demo::greet'], context: { facts: { runtime: 'node' } } });
  assert.equal(resolved.meta.completeness, 'complete');
  assert(resolved.nodes.some(item => item.capability.id === 'tooling::ready'));
  const unknown = await graph.getCapabilities({ ids: ['demo::greet'] });
  assert.equal(unknown.items[0].applicability.status, 'unknown');
  const inapplicable = await graph.getCapabilities({ ids: ['demo::greet'], context: { facts: { runtime: 'bun' } } });
  assert.equal(inapplicable.items[0].applicability.status, 'inapplicable');
  await assert.rejects(graph.match({ input: 'greet' }), error => error instanceof GraphError && error.code === 'CG_MODEL_NOT_CONFIGURED');
} finally { await graph.close(); }

// A deterministic selector exercises Graph.match without calling a model or enabling actions.
const matchedGraph = await CapabilityGraph.open({
  ...config,
  model: {
    id: 'deterministic-doc-test',
    async select(request) {
      assert(request.catalog.some(item => item.id === 'flowkit::render-mermaid'));
      return { decision: 'selected', ids: ['flowkit::render-mermaid'] };
    },
  },
});
try {
  const match = await matchedGraph.match({ input: 'Render a Mermaid diagram' });
  assert.equal(match.status, 'matched');
  assert.deepEqual(match.selection.ids, ['flowkit::render-mermaid']);
  assert.equal(match.graph.meta.completeness, 'complete');
} finally { await matchedGraph.close(); }

// The installed example and package are self-contained. This demonstrates the
// SDK file branch using a file shipped with E13. Checkout documents are verified separately.
const localGraph = await CapabilityGraph.open({ providers: [{
  documentRoot: fileURLToPath(new URL('./', import.meta.url)),
  definition: { ...demoProvider, capabilities: [{
    ...demoProvider.capabilities[0],
    documents: [{ id: 'sample', source: { type: 'file', path: 'sample.workflow.js' } }],
  }] },
}, { definition: toolingProvider }] });
try {
  const local = await localGraph.readDocument({ capabilityId: 'demo::greet', documentId: 'sample' });
  assert.match(local.text, /graph-backed-action/);
  assert.match(local.contentHash, /^sha256:[a-f0-9]{64}$/);
} finally { await localGraph.close(); }

const partialGraph = await CapabilityGraph.open({ ...config, allowedProviders: ['demo'] });
try {
  const partial = await partialGraph.resolve({ ids: ['demo::greet'], context: { facts: { runtime: 'node' } } });
  assert.equal(partial.meta.completeness, 'partial');
  let calls = 0;
  const partialAdapter = createCapabilityGraphActionAdapter({
    graph: partialGraph,
    getContext: () => ({ facts: { runtime: 'node' } }),
    bindings: { greet: { capabilityId: 'demo::greet', execute() { calls++; } } },
  });
  await assert.rejects(partialAdapter.runAction('greet', 'Greeting', {}), { code: 'FK_CG_DEPENDENCIES_INCOMPLETE' });
  assert.equal(calls, 0);
} finally { await partialGraph.close(); }

assert.equal((await executeDemo()).status, 'succeeded');
await assert.rejects(executeDemo({ context: { facts: { runtime: 'bun' } } }), error => error.code === 'FK_CG_NOT_APPLICABLE');
await assert.rejects(executeDemo({ context: {} }), error => error.code === 'FK_CG_NOT_APPLICABLE');
await assert.rejects(executeDemo({ allowedProviders: ['demo'] }), error => error.code === 'FK_CG_DEPENDENCIES_INCOMPLETE');
await assert.rejects(executeDemo({ allowedProviders: ['tooling'] }), error => error instanceof GraphError && error.code === 'CG_ACCESS_DENIED');
const adapter = createCapabilityGraphActionAdapter({ graph: { resolve: async () => { throw new Error('Unexpected call'); } }, bindings: {} });
await assert.rejects(adapter.runAction('greet', 'Greeting', {}), error => error.code === 'FK_CG_BINDING_MISSING');
