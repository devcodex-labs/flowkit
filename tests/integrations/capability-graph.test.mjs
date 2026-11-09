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
  assert.equal(new Set(flowkitProvider.capabilities.map(item => item.id)).size, flowkitProvider.capabilities.length);
  assert(flowkitProvider.capabilities.some(item => item.id === 'run-workflow'));
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
