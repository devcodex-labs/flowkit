import { flowkitProvider, createCapabilityGraphActionAdapter } from '../../types/capability-graph.js';
import type { FlowkitDocumentRef, GraphResolver, GraphContext, GraphActionBinding, GraphResolution } from '../../types/capability-graph.js';
const provider: { providerId: string; version: string; capabilities: { id: string; name: string; description: string }[] } = flowkitProvider;
const context: GraphContext = { facts: { runtime: 'node', 'runtime.version': '22.13.0' } };
const result: GraphResolution = { nodes: [{ capability: { id: 'demo::greet' }, applicability: { status: 'applicable' } }], unresolved: [], meta: { completeness: 'complete' } };
const graph: GraphResolver = { async resolve(query) { const ids: string[] = query.ids; void ids; return result; } };
const binding: GraphActionBinding = { capabilityId: 'demo::greet', async execute({ action, resolution }) { const id: string = resolution.nodes[0].capability.id; void [action,id]; } };
const adapter = createCapabilityGraphActionAdapter({ graph, bindings: { greet: binding }, getContext: () => context });
const execution: Promise<void> = adapter.runAction('greet', 'Greeting', { state: {} });
void [provider, execution];
const local: FlowkitDocumentRef = { id: 'local', source: { type: 'file', path: 'reference.mdx' } };
const remote: FlowkitDocumentRef = { id: 'remote', source: { type: 'url', url: 'https://docs.example.test/reference' } };
const references: FlowkitDocumentRef[] | undefined = flowkitProvider.capabilities[0]?.documents;
void [local, remote, references];
// @ts-expect-error File sources require path rather than url
const mismatched: FlowkitDocumentRef = { id: 'invalid', source: { type: 'file', url: 'https://docs.example.test/reference' } };
void mismatched;
// @ts-expect-error Graph binding requires a capability ID
const invalid: GraphActionBinding = { execute() {} };
void invalid;
