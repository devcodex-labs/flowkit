import { artifactDigest } from '../shared/artifact-identity.mjs';
import { isWorkflowId, isWorkflowNodeName, WORKFLOW_ID_MAX_LENGTH, WORKFLOW_NODE_NAME_MAX_LENGTH } from '../shared/contracts.mjs';
import { analyzeSource } from '../compiler/analyze.mjs';
import { supportsInteractiveNodeKind } from '../compiler/interactive/feature-gate.mjs';
import { interactiveStageForMode } from '../interactive/protocol.mjs';
import { workflowContract } from '../shared/workflow-contract.mjs';

const NODE_KINDS = new Set(['agent', 'action', 'verification', 'condition', 'parallel', 'loop', 'human', 'terminal']);
const EDGE_KINDS = new Set(['control', 'data', 'capability', 'resource']);

/** Find successful exits reachable without a declared producer for a required output. */
export function missingRootOutputSources(definition, graph) {
  const { input, output } = definition.contract ?? {};
  const requiredInputs = new Set(input?.required ?? []);
  const missing = [];
  for (const key of output?.required ?? []) {
    if (requiredInputs.has(key)) continue;
    const missingAtJoin = new Map();

    function successfulExits(entry, join) {
      const found = new Set();
      const visited = new Set();
      const pending = [entry];
      while (pending.length) {
        const id = pending.pop();
        if (id === join) return [join];
        if (visited.has(id)) continue;
        visited.add(id);
        const node = graph.byId.get(id);
        if (node.type === 'terminal') {
          if (node.status === 'succeeded') found.add(id);
          continue;
        }
        if (node.type === 'parallel') {
          if (!missingAtJoin.has(id)) {
            const branchCanOmit = branch => node.branchMode === 'subflow'
              ? successfulExits(branch, node.join.next).length > 0
              : !graph.writeSets.get(branch).has(key);
            // An all join applies every successful branch, while any applies only its winner.
            missingAtJoin.set(id, node.join.strategy === 'any'
              ? node.branches.some(branchCanOmit)
              : node.branches.every(branchCanOmit));
          }
          if (missingAtJoin.get(id)) pending.push(node.join.next);
          continue;
        }
        const writes = graph.writeSets.get(id).has(key);
        for (const edge of graph.outgoing.get(id)) {
          if (node.type === 'condition' && node.branches[Number(edge.path.split('/')[2])].when.trim() === 'false') continue;
          if (!writes || edge.role === 'action-failure' || edge.path === '/onError') pending.push(edge.to);
        }
      }
      return [...found];
    }

    for (const nodeId of successfulExits(definition.nodes[0].id)) missing.push({ key, nodeId });
  }
  return missing;
}

/** Derive the Plan's control edges from the same literal source used by the compiler. */
export async function materializePlan(draft, proposal, compilerOptions) {
  const { nodes, entryNodeId } = proposal;
  if (!Array.isArray(nodes) || !nodes.some(node => node?.id === entryNodeId)) {
    throw new TypeError('Plan must identify an existing entry node');
  }
  const builders = new Set(['defineWorkflow']);
  const steps = [];
  const ordered = [...nodes.filter(node => node?.id === entryNodeId), ...nodes.filter(node => node?.id !== entryNodeId)];
  for (const node of ordered) {
    if (!node || !NODE_KINDS.has(node.kind) || !node.options || typeof node.options !== 'object' ||
      Array.isArray(node.options) || !isWorkflowNodeName(node.name) ||
      Object.hasOwn(node.options, 'name') || Object.hasOwn(node.options, 'type')) {
      throw new TypeError('Each Plan node must include its ID, kind, display name and DSL options without name or type');
    }
    const builder = node.kind === 'agent' ? 'node' : node.kind;
    builders.add(builder);
    steps.push(`  ${builder}(${JSON.stringify(node.id)},${JSON.stringify({ name: node.name, ...node.options })})`);
  }
  const id = JSON.stringify(draft.target.name);
  const contract=proposal.contract===undefined?'':`contract:${JSON.stringify(proposal.contract)},`;
  const source = `import { ${[...builders].join(', ')} } from '@devcodex-labs/flowkit/dsl';\n` +
    `export default defineWorkflow({id:${id},name:${id},version:${JSON.stringify(draft.target.version)},${contract}nodes:[\n${steps.join(',\n')}\n]});\n`;
  const stage=interactiveStageForMode(draft.choices?.executionMode);
  const analysis = await analyzeSource(source, { ...compilerOptions, skillCheck: false },
    {interactiveStage:stage});
  if (analysis.diagnostics.some(item => item.severity === 'error')) return { diagnostics: analysis.diagnostics };
  const missingOutputs = missingRootOutputSources(analysis.literal.definition, analysis.graph);
  if (missingOutputs.length) return { diagnostics: missingOutputs.map(({ key, nodeId }) => ({
    code: 'FKA_PLAN_OUTPUT_SOURCE_REQUIRED',
    nodeId,
    message: `A route to successful terminal ${nodeId} has no declared source for required root output ${JSON.stringify(key)}.`
  })) };
  const control = new Map();
  for (const { from, to } of [...analysis.graph.referenceEdges, ...analysis.graph.executionEdges]) {
    control.set(JSON.stringify([from, to]), { from, to, kind: 'control' });
  }
  const suppliedEdges = proposal.edges ?? [];
  if (!Array.isArray(suppliedEdges)) throw new TypeError('Plan edges must be an array when supplied');
  // Only compiler-derived control edges can run. Preserve typed supplementary links for validation.
  const annotations = suppliedEdges.filter(edge => edge?.kind !== 'control' &&
    (EDGE_KINDS.has(edge?.kind) || !control.has(JSON.stringify([edge?.from, edge?.to]))));
  const edges = [...control.values(), ...annotations];
  const plannedNodes = nodes.map(({ id, kind, name, options }) => ({ id, kind, name, options,
    ...(kind === 'loop' ? { onSuccess: options.onSuccess, onMaxExceeded: options.onMaxExceeded } : {}) }));
  return { source, proposal: { ...proposal, nodes: plannedNodes, edges }, sourceHash: artifactDigest(source) };
}

export function assertReadyStandardPlan(plan, mode = 'standard') {
  const { planHash, status, revision, ...view } = plan;
  if (status !== 'ready-for-dsl' || view.target.executionMode !== mode ||
    view.unresolvedIssues.some(issue => issue.blocking) || !Number.isSafeInteger(revision) || revision < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(view.intentRef?.effectiveIntentHash) ||
    planHash !== artifactDigest(JSON.stringify(view))) throw new Error('A current Standard WorkflowPlan is required');
}

/** Validate the Author's planning proposal against the effective intent and the selected mode. */
export function createWorkflowPlan(draft, intent, proposal, previous, sourceHash) {
  const { nodes, edges, entryNodeId, contract, assumptions = [], nonGoals = [], unresolvedIssues = [], coverage: suppliedCoverage,
    capabilityRequirements = [], resourceRequirements = [], hostProfileRef } = structuredClone(proposal);
  const constraintIds = new Set(intent.constraints.map(item => item.id));
  const requirementIds = new Set([...intent.goals.map(item => item.id), ...constraintIds]);
  const declaredContract=workflowContract(contract);
  if (!suppliedCoverage || typeof suppliedCoverage !== 'object') {
    throw new TypeError('Plan coverage must map authorized requirement IDs to the enforcing node IDs');
  }
  const coverageRows = Array.isArray(suppliedCoverage) ? suppliedCoverage :
    Object.entries(suppliedCoverage).map(([intentId, coveredBy]) => {
      if (!requirementIds.has(intentId) || !Array.isArray(coveredBy)) {
        throw new TypeError('Plan coverage maps require exact authorized requirement IDs and arrays of node IDs');
      }
      return { intentId, status: 'covered', coveredBy };
    });
  const coverage = coverageRows.map(entry => {
    if (!Object.hasOwn(entry, 'constraintId')) return entry;
    const { constraintId, intentId, ...mapping } = entry;
    if (!constraintIds.has(constraintId) || (intentId !== undefined && intentId !== constraintId)) {
      throw new TypeError('Plan coverage constraintId must identify the exact authorized constraint without a conflicting intentId');
    }
    return { intentId: constraintId, ...mapping };
  });
  const ids = new Set(nodes.map(node => node.id));
  const namedNodes = nodes.filter(node => node.name !== undefined);
  const invalidName = namedNodes.find(node => !isWorkflowNodeName(node.name));
  if (invalidName) throw new TypeError(`WorkflowPlan node ${invalidName.id} needs a valid display name of at most ${WORKFLOW_NODE_NAME_MAX_LENGTH} characters`);
  const names = namedNodes.map(node => node.name);
  if (new Set(names).size !== names.length) throw new TypeError('WorkflowPlan node display names must be distinct');
  if (assumptions.some(item => !item || typeof item.id !== 'string' || typeof item.statement !== 'string' ||
    typeof item.requiresConfirmation !== 'boolean')) throw new TypeError('Plan assumptions must declare id, statement and requiresConfirmation');
  const invalidId = nodes.find(node => !isWorkflowId(node.id));
  if (invalidId) throw new TypeError(`WorkflowPlan node ID ${JSON.stringify(invalidId.id)} must be kebab-case with at most ${WORKFLOW_ID_MAX_LENGTH} characters`);
  if (ids.size !== nodes.length) throw new TypeError('WorkflowPlan node IDs must be unique');
  if (nodes.some(node => !NODE_KINDS.has(node.kind))) {
    throw new TypeError(`WorkflowPlan node kinds must use ${[...NODE_KINDS].join(', ')}. A Parallel join is not a separate node kind.`);
  }
  if (!ids.has(entryNodeId)) throw new TypeError('WorkflowPlan entryNodeId must identify an existing node');
  if (!nodes.some(node => node.kind === 'terminal')) {
    throw new TypeError('WorkflowPlan needs a terminal node and control edges from the last steps that reach it');
  }
  if (!Array.isArray(edges)) throw new TypeError('WorkflowPlan edges must be an array');
  const invalidEdgeIndex = edges.findIndex(edge => !ids.has(edge?.from) || !ids.has(edge?.to) || !EDGE_KINDS.has(edge?.kind));
  if (invalidEdgeIndex !== -1) {
    const edge = edges[invalidEdgeIndex];
    if (!ids.has(edge?.from) || !ids.has(edge?.to)) {
      throw new TypeError(`WorkflowPlan edges[${invalidEdgeIndex}] must connect existing node IDs using from and to`);
    }
    throw new TypeError(`WorkflowPlan edges[${invalidEdgeIndex}].kind must be control, data, capability, or resource`);
  }
  if (previous && previous.planId !== draft.id) throw new TypeError('Previous Plan belongs to a different draft');

  const mode = draft.choices.executionMode;
  if (mode === 'standard') {
    const successors = new Map(nodes.map(node => [node.id, new Set()]));
    for (const { from, to, kind } of edges) {
      if (kind === 'control') successors.get(from).add(to);
    }
    for (const node of nodes.filter(node => node.kind === 'loop')) {
      const exits = [node.onSuccess, node.onMaxExceeded];
      if (node.onSuccess === node.onMaxExceeded || exits.some(target => target === node.id ||
        !successors.get(node.id).has(target))) {
        throw new TypeError(`WorkflowPlan Loop ${node.id} must name distinct onSuccess and onMaxExceeded targets with matching control edges`);
      }
    }
    if (!sourceHash && !unresolvedIssues.some(issue => issue.blocking) && !assumptions.some(item => item.requiresConfirmation)) {
      for (const parallel of nodes.filter(node => node.kind === 'parallel')) {
        const targets = [...successors.get(parallel.id)];
        const joins = targets.filter(join => targets.every(id => id === join ||
          (successors.get(id).size === 1 && successors.get(id).has(join))));
        if (targets.length < 3 || targets.length > 17 || joins.length !== 1) {
          throw new TypeError(`WorkflowPlan Parallel ${parallel.id} must point to its members and one join continuation. Each member's only control edge goes to that continuation. Failures propagate without an added member-to-failure edge.`);
        }
      }
    }
  }
  const issue = (id, description, kind = 'ambiguity') => ({ id, description, kind, blocking: true });
  const issues = [...unresolvedIssues];
  if (issues.some(item => item.kind === 'coverage-gap')) throw new TypeError('Plan coverage gaps must be derived from the authorized intent');
  if (mode === undefined) issues.push(issue('execution-mode', 'Choose the target execution mode'));
  const stage=interactiveStageForMode(mode);
  if (stage) {
    for (const node of nodes) {
      if (!supportsInteractiveNodeKind(stage,node.kind) || stage==='P0-A' && node.kind==='agent' && node.verification) {
        issues.push(issue(`unsupported-${node.id}`, `Interactive ${stage} cannot express ${node.name ?? node.id}`, 'capability-gap'));
      }
    }
  }
  if (intent.coverage !== 'complete' || intent.issues.length || intent.unresolved.length) {
    issues.push(issue('intent-incomplete', 'Resolve relevant intent gaps and conflicts before generating DSL'));
  }
  for (const assumption of assumptions) {
    if (assumption.requiresConfirmation) issues.push(issue(`assumption-${assumption.id}`, assumption.statement));
  }
  const onlyGoal = intent.goals.length === 1 && intent.constraints.length === 0 && !intent.relations?.length;
  const introducesControls = nodes.some(node => ['condition', 'verification', 'parallel', 'loop', 'human'].includes(node.kind));
  if (draft.operation === 'create' && mode === 'standard' && onlyGoal && introducesControls && !issues.some(item => item.blocking)) {
    issues.push({
      ...issue('workflow-control-policy', 'Which rules should govern the proposed branches, failure paths, or approvals?'),
      options: [
        { value: 'provide-rules', label: 'Specify the decision rules', reason: 'Use the actual branch, failure, or approval rules before building.' },
        { value: 'keep-draft', label: 'Keep this as a draft', reason: 'Wait until the intended behavior is decided.' }
      ],
      recommended: 'provide-rules'
    });
  }
  for (const item of [...intent.goals, ...intent.constraints]) {
    if (!coverage.some(entry => entry.intentId === item.id && entry.status === 'covered' &&
      Array.isArray(entry.coveredBy) && entry.coveredBy.length > 0 && entry.coveredBy.every(nodeId => ids.has(nodeId)))) {
      issues.push({ ...issue(`coverage-${item.id}`, item.statement ?? item.goal ?? 'Map the authorized requirement to existing nodes', 'coverage-gap'),
        intentId: item.id });
    }
  }
  if (stage && !issues.some(item => item.blocking && item.kind !== 'coverage-gap')) {
    for (const node of nodes.filter(node => node.kind === 'action')) {
      const effect = node.options?.effect ?? node.effect;
      if (!['read-only', 'write'].includes(effect) || node.effect !== undefined && node.effect !== effect) {
        throw new TypeError(`Interactive Action ${node.id} must declare an external effect of read-only or write consistently`);
      }
      node.effect = effect;
    }
  }
  const target = { ...(mode === undefined ? {} : { executionMode: mode }), ...(hostProfileRef ? { hostProfileRef } : {}) };
  const view = { schemaVersion: 1, planId: draft.id, intentRef: intent.intentRef, target,
    goal: draft.goal, constraints: intent.constraints, nonGoals, assumptions, unresolvedIssues: issues,
    entryNodeId, nodes, edges, capabilityRequirements, resourceRequirements, coverage,
    ...(declaredContract?{contract,contractDigest:declaredContract.digest}:{}),
    ...(sourceHash === undefined ? {} : { sourceHash }) };
  const planHash = artifactDigest(JSON.stringify(view));
  if (previous?.planHash === planHash) return previous;
  return { ...view, revision: (previous?.revision ?? 0) + 1, planHash,
    status: mode === undefined ? 'draft' : issues.some(entry => entry.blocking) ? 'needs-clarification' : 'ready-for-dsl' };
}
