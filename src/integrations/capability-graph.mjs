/**
 * Optional host-side capability-graph bridge. No model, MCP server or second
 * workflow runtime is created by FlowKit.
 */
export const flowkitProvider = Object.freeze({
  schemaVersion: 1, providerId: 'flowkit', name: 'FlowKit', version: '1.0.0',
  description: 'Compile declarative JavaScript/TypeScript workflows and run them with an explicit host Runtime.',
  capabilities: [
    { id: 'define-workflow', name: 'Define workflow', description: 'Declare eight supported node kinds using the FlowKit DSL.', whenToUse: 'A host needs a statically analyzable workflow definition.', usage: { instructions: 'Import defineWorkflow and DSL constructors from @devcodex-labs/flowkit/dsl. The input must be literal JS/TS DSL.' } },
    { id: 'compile-workflow', name: 'Compile workflow', description: 'Statically validate a workflow and emit executable JavaScript and optional Mermaid.', whenToUse: 'An application needs a verified compiled workflow.', usage: { instructions: 'Call compile or compileSource from @devcodex-labs/flowkit; inspect diagnostics before using artifacts.' }, relations: { requires: ['define-workflow'] } },
    { id: 'check-workflow', name: 'Check workflow', description: 'Check source and compare an existing compiled JavaScript artifact without writing.', whenToUse: 'An application needs a read-only definition and artifact check.', usage: { instructions: 'Call check from @devcodex-labs/flowkit; absence of compiled output is not an error and Mermaid is not compared.' }, relations: { requires: ['define-workflow'] } },
    { id: 'run-workflow', name: 'Run workflow', description: 'Execute a verified workflow using a caller-provided host Runtime.', whenToUse: 'A host has authorized the workflow and supplied its business methods.', usage: { instructions: 'Call run from @devcodex-labs/flowkit with an explicit Runtime. FlowKit does not supply a model or persistent approvals.' }, relations: { requires: ['define-workflow'] } },
    { id: 'render-mermaid', name: 'Render Mermaid', description: 'Produce a Mermaid diagram from the validated control-flow definition.', whenToUse: 'A caller needs a view of the workflow graph.', usage: { instructions: 'Use compile/compileSource with mermaid enabled; the diagram is visualization, not execution.' }, relations: { requires: ['compile-workflow'] } },
  ],
});

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Graph performs discovery, authorization, applicability and dependency resolution.
 * The explicitly bound host callback is the only component that performs actions.
 * Resolving a dependency does not execute that dependency.
 *
 * @param {{ graph: { resolve: Function }, bindings: Record<string, { capabilityId: string, execute: Function }>, getContext?: Function }} options
 */
export function createCapabilityGraphActionAdapter({ graph, bindings, getContext = () => ({}) } = {}) {
  if (!graph || typeof graph.resolve !== 'function') throw new TypeError('graph.resolve must be a function');
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new TypeError('bindings must be an object');
  if (typeof getContext !== 'function') throw new TypeError('getContext must be a function');
  const table = new Map();
  for (const key of Object.keys(bindings)) {
    const descriptor = Object.getOwnPropertyDescriptor(bindings, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('bindings must not contain accessors');
    const binding = descriptor.value;
    if (!binding || typeof binding.capabilityId !== 'string' || !/^[a-z][a-z0-9._-]*::[a-z][a-z0-9._-]*$/.test(binding.capabilityId) || typeof binding.execute !== 'function') {
      throw new TypeError(`Invalid capability binding: ${key}`);
    }
    table.set(key, { capabilityId: binding.capabilityId, execute: binding.execute });
  }
  return {
    async runAction(action, name, ctx) {
      const binding = table.get(action);
      if (!binding) throw adapterError('FK_CG_BINDING_MISSING', `No Graph binding for action: ${action}`);
      const context = getContext(ctx);
      if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('getContext must return Graph MatchContext');
      // Let GraphError (including permission and invalid context) propagate unchanged.
      const result = await graph.resolve({ ids: [binding.capabilityId], context, relations: ['requires'] });
      if (!result || result.meta?.completeness !== 'complete' || !Array.isArray(result.unresolved) || result.unresolved.length || !Array.isArray(result.nodes)) {
        throw adapterError('FK_CG_DEPENDENCIES_INCOMPLETE', 'Capability dependencies are incomplete');
      }
      const root = result.nodes.find(item => item.capability?.id === binding.capabilityId);
      if (!root) throw adapterError('FK_CG_DEPENDENCIES_INCOMPLETE', 'Selected capability is missing from the resolved graph');
      for (const item of result.nodes) if (item.applicability?.status !== 'applicable') {
        throw adapterError('FK_CG_NOT_APPLICABLE', `Capability is not applicable: ${item.capability?.id ?? 'unknown'}`);
      }
      await binding.execute({ action, name, ctx, resolution: result, capability: root.capability });
    },
  };
}
