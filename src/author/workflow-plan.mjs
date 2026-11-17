import { artifactDigest } from '../shared/artifact-identity.mjs';
import { supportsP0ANodeKind } from '../compiler/interactive/feature-gate.mjs';

const NODE_KINDS = new Set(['agent', 'action', 'verification', 'condition', 'parallel', 'loop', 'human', 'terminal']);
const EDGE_KINDS = new Set(['control', 'data', 'capability', 'resource']);

export function assertReadyStandardPlan(plan) {
  const { planHash, status, revision, ...view } = plan;
  if (status !== 'ready-for-dsl' || view.target.executionMode !== 'standard' ||
    view.unresolvedIssues.some(issue => issue.blocking) || !Number.isSafeInteger(revision) || revision < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(view.intentRef?.effectiveIntentHash) ||
    planHash !== artifactDigest(JSON.stringify(view))) throw new Error('A current Standard WorkflowPlan is required');
}

/** Validate the Author's planning proposal against the effective intent and the selected mode. */
export function createWorkflowPlan(draft, intent, proposal, previous) {
  const { nodes, edges, entryNodeId, assumptions = [], nonGoals = [], unresolvedIssues = [], coverage,
    capabilityRequirements = [], resourceRequirements = [], hostProfileRef } = structuredClone(proposal);
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || nodes.some(node => !node.id || !NODE_KINDS.has(node.kind)) ||
    !ids.has(entryNodeId) || !nodes.some(node => node.kind === 'terminal') ||
    edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to) || !EDGE_KINDS.has(edge.kind))) {
    throw new TypeError('WorkflowPlan requires unique, typed nodes, known edge endpoints, an entry and a terminal');
  }
  if (previous && previous.planId !== draft.id) throw new TypeError('Previous Plan belongs to a different draft');

  const mode = draft.choices.executionMode;
  const issue = (id, description, kind = 'ambiguity') => ({ id, description, kind, blocking: true });
  const issues = [...unresolvedIssues];
  if (mode === undefined) issues.push(issue('execution-mode', 'Choose the target execution mode'));
  if (mode === 'interactive-p0-a') {
    for (const node of nodes) {
      if (!supportsP0ANodeKind(node.kind) || node.kind === 'agent' && node.verification) {
        issues.push(issue(`unsupported-${node.id}`, `Interactive P0-A cannot express ${node.name ?? node.id}`, 'capability-gap'));
      }
    }
  }
  if (intent.coverage !== 'complete' || intent.issues.length || intent.unresolved.length) {
    issues.push(issue('intent-incomplete', 'Resolve relevant intent gaps and conflicts before generating DSL'));
  }
  for (const assumption of assumptions) {
    if (assumption.requiresConfirmation) issues.push(issue(`assumption-${assumption.id}`, assumption.statement));
  }
  for (const intentId of [...intent.goals, ...intent.constraints].map(item => item.id)) {
    if (!coverage.some(entry => entry.intentId === intentId && entry.status === 'covered' && entry.coveredBy.length > 0)) {
      issues.push(issue(`coverage-${intentId}`, `Record how the workflow satisfies ${intentId}`));
    }
  }
  const target = { ...(mode === undefined ? {} : { executionMode: mode }), ...(hostProfileRef ? { hostProfileRef } : {}) };
  const view = { schemaVersion: 1, planId: draft.id, intentRef: intent.intentRef, target,
    goal: draft.goal, constraints: intent.constraints, nonGoals, assumptions, unresolvedIssues: issues,
    entryNodeId, nodes, edges, capabilityRequirements, resourceRequirements, coverage };
  const planHash = artifactDigest(JSON.stringify(view));
  if (previous?.planHash === planHash) return previous;
  return { ...view, revision: (previous?.revision ?? 0) + 1, planHash,
    status: mode === undefined ? 'draft' : issues.some(entry => entry.blocking) ? 'needs-clarification' : 'ready-for-dsl' };
}
