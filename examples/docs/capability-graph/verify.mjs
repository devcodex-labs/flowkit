import assert from 'node:assert/strict';
import { CapabilityGraph, GraphError } from '@devcodex/capability-graph';
import { createCapabilityGraphActionAdapter, flowkitProvider } from '@devcodex-labs/flowkit/capability-graph';
import { executeDemo, demoProvider, toolingProvider } from './host.mjs';

const graph = await CapabilityGraph.open({
  providers: [{ definition: flowkitProvider }, { definition: demoProvider }, { definition: toolingProvider }],
  allowedProviders: ['flowkit', 'demo', 'tooling'],
});
try {
  const catalog = await graph.listCatalog();
  assert(catalog.items.some(item => item.id === 'flowkit::compile-workflow'));
  const compile = await graph.resolve({ ids: ['flowkit::render-mermaid'] });
  assert.deepEqual(compile.selected, ['flowkit::render-mermaid']);
  assert(compile.nodes.some(item => item.capability.id === 'flowkit::compile-workflow'));
  const resolved = await graph.resolve({ ids: ['demo::greet'], context: { facts: { runtime: 'node' } } });
  assert.equal(resolved.meta.completeness, 'complete');
  assert(resolved.nodes.some(item => item.capability.id === 'tooling::ready'));
  const unknown = await graph.getCapabilities({ ids: ['demo::greet'] });
  assert.equal(unknown.items[0].applicability.status, 'unknown');
  await assert.rejects(graph.match({ input: 'greet' }), error => error instanceof GraphError && error.code === 'CG_MODEL_NOT_CONFIGURED');
} finally { await graph.close(); }

assert.equal((await executeDemo()).status, 'succeeded');
await assert.rejects(executeDemo({ context: { facts: { runtime: 'bun' } } }), error => error.code === 'FK_CG_NOT_APPLICABLE');
await assert.rejects(executeDemo({ context: {} }), error => error.code === 'FK_CG_NOT_APPLICABLE');
await assert.rejects(executeDemo({ allowedProviders: ['demo'] }), error => error.code === 'FK_CG_DEPENDENCIES_INCOMPLETE');
await assert.rejects(executeDemo({ allowedProviders: ['tooling'] }), error => error instanceof GraphError && error.code === 'CG_ACCESS_DENIED');
const adapter = createCapabilityGraphActionAdapter({ graph: { resolve: async () => { throw new Error('Unexpected call'); } }, bindings: {} });
await assert.rejects(adapter.runAction('greet', 'Greeting', {}), error => error.code === 'FK_CG_BINDING_MISSING');
