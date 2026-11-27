import test from 'node:test';
import assert from 'node:assert/strict';
import { flowkitProvider, createCapabilityGraphActionAdapter } from '../../src/integrations/capability-graph.mjs';

const resolved = status => ({
  nodes: [
    { capability: { id: 'demo::greet' }, applicability: { status } },
    { capability: { id: 'demo::ready' }, applicability: { status: 'applicable' } },
  ],
  unresolved: [], meta: { completeness: 'complete' },
});

test('Provider declares real public capabilities with stable graph IDs', () => {
  assert.equal(flowkitProvider.providerId, 'flowkit');
  assert.equal(flowkitProvider.schemaVersion, 1);
  assert.deepEqual(flowkitProvider.capabilities.map(item => item.id),
    ['define-workflow', 'compile-workflow', 'check-workflow', 'run-workflow', 'deliver-workflow-skill', 'render-mermaid']);
  for (const capability of flowkitProvider.capabilities) {
    assert(capability.documents.length);
    assert.equal(new Set(capability.documents.map(document => document.id)).size, capability.documents.length);
    for (const document of capability.documents) {
      assert.equal(document.source.type, 'url');
      assert.match(document.source.url, /^https:\/\/raw\.githubusercontent\.com\/devcodex-labs\/flowkit\/[a-f0-9]{40}\//);
    }
    assert.doesNotMatch(capability.usage.instructions, /https:\/\//);
  }
  const [define, compile, check, run, deliver, render] = flowkitProvider.capabilities;
  assert.equal(define.relations, undefined);
  for (const capability of [compile, check, run]) assert.deepEqual(capability.relations.requires, ['define-workflow']);
  assert.deepEqual(render.relations.requires, ['compile-workflow']);
  assert.equal(deliver.relations, undefined);
  assert.match(deliver.whenToUse, /export or install/);
  assert.deepEqual(compile.documents[0], check.documents[0]);
  assert.deepEqual(compile.documents[0], render.documents[0]);
});
test('host binding resolves capability and dependencies before executing', async () => {
  const calls = [], ctx = { state: {} };
  const graph = { async resolve(q) { calls.push(q); return resolved('applicable'); } };
  const adapter = createCapabilityGraphActionAdapter({ graph, getContext: () => ({ facts: { runtime: 'node' } }),
    bindings: { greet: { capabilityId: 'demo::greet', async execute({ ctx, resolution }) { assert.equal(resolution.nodes.length, 2); ctx.state.message = 'ok'; } } } });
  await adapter.runAction('greet', 'Greeting', ctx);
  assert.equal(ctx.state.message, 'ok'); assert.deepEqual(calls[0].relations, ['requires']);
  assert.deepEqual(calls[0].context.facts, { runtime: 'node' });
});
test('missing binding, incomplete dependencies and unknown applicability fail closed', async () => {
  let executed = false;
  const binding = { greet: { capabilityId: 'demo::greet', execute() { executed = true; } } };
  const absent = createCapabilityGraphActionAdapter({ graph: { resolve: async () => resolved('applicable') }, bindings: binding });
  await assert.rejects(absent.runAction('missing', 'Missing', {}), { code: 'FK_CG_BINDING_MISSING' });
  const unknown = createCapabilityGraphActionAdapter({ graph: { resolve: async () => resolved('unknown') }, bindings: binding });
  await assert.rejects(unknown.runAction('greet', 'Greeting', {}), { code: 'FK_CG_NOT_APPLICABLE' });
  const partial = createCapabilityGraphActionAdapter({ graph: { resolve: async () => ({ ...resolved('applicable'), unresolved: [{ reason: 'target_unavailable' }] }) }, bindings: binding });
  await assert.rejects(partial.runAction('greet', 'Greeting', {}), { code: 'FK_CG_DEPENDENCIES_INCOMPLETE' });
  assert.equal(executed, false);
});
test('Graph errors remain exact and invalid bindings are rejected', async () => {
  const failure = Object.assign(new Error('denied'), { code: 'CG_ACCESS_DENIED' });
  const adapter = createCapabilityGraphActionAdapter({ graph: { resolve: async () => { throw failure; } },
    bindings: { greet: { capabilityId: 'demo::greet', execute() {} } } });
  await assert.rejects(adapter.runAction('greet', 'Greeting', {}), e => e === failure);
  assert.throws(() => createCapabilityGraphActionAdapter({ graph: {}, bindings: {} }), /graph.resolve/);
  assert.throws(() => createCapabilityGraphActionAdapter({ graph: { resolve() {} }, bindings: { bad: { capabilityId: '../unsafe', execute() {} } } }), /Invalid capability binding/);
});
