import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { validateSkillName } from './skill-document.mjs';
import { workflowExecutionModes } from '../interactive/protocol.mjs';

const constraintKinds = Object.freeze({ requirement: 'must', prohibition: 'must_not',
  precondition: 'precondition', preference: 'should' });
const intentNodes = (nodes, parent = '/effective/intents') => nodes.flatMap((node, index) => {
  const pointer = `${parent}/${index}`;
  return [{ node, pointer }, ...intentNodes(node.children, `${pointer}/children`)];
});

/** One sentence starts a draft. Only explicit choices and trusted project defaults are adopted. */
export function startAuthorDraft(goal, { project, collectionName = 'flowkit-workflows', executionMode,
  includeSource = false } = {}) {
  if (typeof goal !== 'string' || !goal.trim()) throw new TypeError('A workflow goal is required');
  validateSkillName(collectionName);
  if (typeof includeSource !== 'boolean') throw new TypeError('includeSource must be boolean');
  if (executionMode !== undefined && !workflowExecutionModes.includes(executionMode)) {
    throw new TypeError('Choose Standard or a supported Interactive stage');
  }
  const choices = Object.freeze({ ...(project === undefined ? {} : { project }), collectionName,
    includeSource, ...(executionMode === undefined ? {} : { executionMode }) });
  const questions = executionMode === undefined ? [{ id: 'execution-mode', question: 'How should this workflow run?',
    options: [{ value: 'standard', label: 'Standard', reason: 'Use for ordinary workflows with approvals and bounded retries.' },
      { value: 'interactive-p0-a', label: 'Interactive P0-A', reason: 'Durable Agent and condition steps.' },
      { value: 'interactive-p0-b', label: 'Interactive P0-B', reason: 'Durable Actions, human decisions and loops.' },
      { value: 'interactive-p1', label: 'Interactive P1', reason: 'Durable parallel execution requiring every branch to succeed.' },
      { value: 'interactive-p2', label: 'Interactive P2', reason: 'Durable parallel execution that can select the first success.' }],
    recommended: 'standard', customAllowed: true }] : [];
  return Object.freeze({ id: randomUUID(), status: 'draft', goal: goal.trim(), choices, questions });
}

/** Consume the actual Intent Runtime result; preserve issues and non-applied changes for planning. */
export function readIntentForPlan(result, { baselineId, confirmedConstraintIds = [] } = {}) {
  const { effective, turn, issues, inferences, evidence = [], fieldResults } = structuredClone(result);
  const nodes = intentNodes(effective.intents);
  const sources = new Map(evidence.map(entry => [entry.target, entry.sourceRefs]));
  const confirmed = new Set(confirmedConstraintIds);
  for (const change of turn.changes) {
    if (change.effect === 'applied' && change.operation === 'confirm' && change.target.kind === 'constraint' &&
      change.sourceRefs.some(ref => ref.root === 'input')) {
      confirmed.add(change.target.id);
    }
  }
  function constraint(item, pointer) {
    const intentId = item.scope.intentId;
    return { id: item.id, statement: item.text, kind: constraintKinds[item.kind],
      scope: intentId ? 'node' : 'global', sourceIntentIds: intentId ? [intentId] : [],
      confidence: confirmed.has(item.id) ? 'confirmed' : 'inferred',
      sourceRefs: sources.get(pointer) ?? sources.get(`${pointer}/text`) ?? [], intentScope: item.scope,
      ...(item.expression === undefined ? {} : { expression: item.expression }) };
  }
  return { intentRef: { ...(baselineId === undefined ? {} : { baselineId }),
      effectiveIntentHash: artifactDigest(JSON.stringify(effective)),
      changeSetHash: artifactDigest(JSON.stringify(turn.changes)) },
    goals: nodes.map(({ node: { id, goal, understanding, expectedOutput, inputs } }) => ({ id, goal, understanding, expectedOutput, inputs })),
    constraints: [...effective.constraints.map((item, index) => constraint(item, `/effective/constraints/${index}`)),
      ...nodes.flatMap(({ node, pointer }) => node.constraints.map((item, index) => constraint(item, `${pointer}/constraints/${index}`)))],
    relations: effective.relations, coverage: effective.coverage, unresolved: effective.unresolved,
    changes: turn.changes, issues, inferences, evidence, fieldResults, facts: turn.facts };
}

/** The Host supplies its configured Intent Runtime instance and explicit current-turn materials. */
export async function analyzeAuthorDraft(draft, intentRuntime, { input = draft.goal, baseline, baselineId,
  context, confirmedConstraintIds, signal } = {}) {
  if ((baseline === undefined) !== (baselineId === undefined)) throw new TypeError('Intent baseline and ID must be supplied together');
  const result = await intentRuntime.parse({ input, context, baseline, output: { evidence: true, suggestions: false } }, { signal });
  return readIntentForPlan(result, { baselineId, confirmedConstraintIds });
}

/** Read-only dependency resolution. Graph relations stay capability information. */
export async function checkPlanCapabilities(graph, ids, context) {
  if (ids.length === 0) return { supported: true, unresolved: [], nodes: [] };
  const { meta, unresolved, nodes } = await graph.resolve({ ids: [...ids], context,relations:['requires'] });
  return { supported: meta.completeness === 'complete' && unresolved.length === 0 && Array.isArray(nodes) &&
      ids.every(id=>nodes.some(item=>item.capability?.id===id)) && nodes.every(item=>item.applicability?.status==='applicable'),
    unresolved, nodes };
}
