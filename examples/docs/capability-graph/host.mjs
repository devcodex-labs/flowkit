import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { createCapabilityGraphActionAdapter, flowkitProvider } from '@devcodex-labs/flowkit/capability-graph';
import { CapabilityGraph } from '@devcodex/capability-graph';
import { fileURLToPath } from 'node:url';

export const demoProvider = {
  schemaVersion: 1, providerId: 'demo', name: 'Demo actions', version: '1',
  capabilities: [{
    id: 'greet', name: 'Greet', description: 'Write a greeting into workflow state.',
    appliesTo: { all: [{ field: 'runtime', op: 'eq', value: 'node' }] },
    relations: { requires: ['tooling::ready'] },
  }],
};
export const toolingProvider = {
  schemaVersion: 1, providerId: 'tooling', name: 'Host prerequisites', version: '1',
  capabilities: [{ id: 'ready', name: 'Ready', description: 'The host has confirmed the required greeting implementation.' }],
};

const entry = fileURLToPath(new URL('./sample.workflow.js', import.meta.url));
export async function executeDemo({ allowedProviders = ['flowkit', 'demo', 'tooling'], context = { facts: { runtime: 'node' } } } = {}) {
  const graph = await CapabilityGraph.open({ providers: [{ definition: flowkitProvider }, { definition: demoProvider }, { definition: toolingProvider }], allowedProviders });
  try {
    const adapter = createCapabilityGraphActionAdapter({
      graph, getContext: () => context,
      bindings: {
        greet: { capabilityId: 'demo::greet', async execute({ ctx, resolution }) {
          // Graph does not execute requires. This host has explicitly provided the required implementation.
          if (!resolution.nodes.some(item => item.capability.id === 'tooling::ready')) throw new Error('Missing host prerequisite');
          ctx.state.message = `你好，${ctx.state.name}！`;
        } },
      },
    });
    return await run(entry, { isControlSignal, ...adapter }, { name: 'FlowKit' });
  } finally { await graph.close(); }
}
if (process.argv[1] && process.argv[1].endsWith('host.mjs')) {
  console.log(JSON.stringify(await executeDemo()));
}
