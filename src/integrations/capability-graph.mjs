// Keep references on the reviewed documentation snapshot rather than the moving main branch.
const documentationCommit = 'f58a9ed8d109e5d82604a6ff9cce5ed68e3a9377';

function document(id, page) {
  return {
    id,
    source: {
      type: 'url',
      url: `https://raw.githubusercontent.com/devcodex-labs/flowkit/${documentationCommit}/website/content/${page}.mdx`,
    },
  };
}

/**
 * Optional host-side capability-graph bridge. No model, MCP server or second
 * workflow runtime is created by FlowKit.
 */
export const flowkitProvider = Object.freeze({
  schemaVersion: 1, providerId: 'flowkit', name: 'FlowKit', version: '1.0.1',
  description: 'Compile declarative JavaScript/TypeScript workflows and run them with an explicit host Runtime.',
  capabilities: [
    {
      id: 'define-workflow', name: 'Define workflow',
      description: 'Declare a workflow using the static FlowKit DSL.',
      whenToUse: 'A host needs a statically analyzable workflow definition.',
      usage: { instructions: 'Use literal JS/TS DSL. Check the eight Standard node kinds or the supported Interactive P0-A subset before choosing a mode.' },
      documents: [
        document('flowkit-doc-dsl', 'dsl/index'),
        document('flowkit-doc-authoring', 'guide/workflow-authoring'),
        document('flowkit-doc-model', 'guide/workflow-model'),
      ],
    },
    {
      id: 'compile-workflow', name: 'Compile workflow',
      description: 'Statically validate a workflow and emit executable JavaScript and optional Mermaid.',
      whenToUse: 'An application needs a verified compiled workflow.',
      usage: { instructions: 'Call compile or compileSource and inspect diagnostics before using either artifact.' },
      relations: { requires: ['define-workflow'] },
      documents: [
        document('flowkit-doc-compile', 'guide/compile-artifacts'),
        document('flowkit-doc-sdk', 'reference/sdk'),
        document('flowkit-doc-options', 'reference/options'),
      ],
    },
    {
      id: 'check-workflow', name: 'Check workflow',
      description: 'Check source and compare an existing compiled JavaScript artifact without writing.',
      whenToUse: 'An application needs a read-only definition and artifact check.',
      usage: { instructions: 'Call check and inspect diagnostics. A missing compiled file is allowed; check does not compare Mermaid.' },
      relations: { requires: ['define-workflow'] },
      documents: [
        document('flowkit-doc-compile', 'guide/compile-artifacts'),
        document('flowkit-doc-sdk', 'reference/sdk'),
        document('flowkit-doc-compiler-errors', 'troubleshooting/compiler'),
      ],
    },
    {
      id: 'run-workflow', name: 'Run workflow',
      description: 'Execute a verified workflow using a caller-provided host Runtime.',
      whenToUse: 'A host has authorized the workflow and supplied its business methods.',
      usage: { instructions: 'Use run with a host Runtime for Standard. Preserve AOT source identity. Interactive uses its own API and supported subset.' },
      relations: { requires: ['define-workflow'] },
      documents: [
        document('flowkit-doc-runtime', 'reference/runtime'),
        document('flowkit-doc-host', 'guide/host-integration'),
        document('flowkit-doc-aot', 'guide/aot'),
        document('flowkit-doc-direct-host', 'guide/direct-host'),
        document('flowkit-doc-interactive', 'guide/interactive'),
      ],
    },
    {
      id: 'render-mermaid', name: 'Render Mermaid',
      description: 'Produce a Mermaid diagram from the validated control-flow definition.',
      whenToUse: 'A caller needs a view of the workflow graph.',
      usage: { instructions: 'Use compile or compileSource with Mermaid enabled. Display the diagram and execute the JavaScript separately.' },
      relations: { requires: ['compile-workflow'] },
      documents: [
        document('flowkit-doc-compile', 'guide/compile-artifacts'),
        document('flowkit-doc-model', 'guide/workflow-model'),
      ],
    },
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
