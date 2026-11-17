import { analyzeAuthorDraft, checkPlanCapabilities, startAuthorDraft } from './draft.mjs';
import { readAuthorDocument } from './documentation.mjs';
import { prepareImportedStandardSkill, prepareStandardSkill, publishStandardSkill, reviewStandardCandidate } from './standard-artifact.mjs';
import { createWorkflowPlan } from './workflow-plan.mjs';

/** Shared Author operations for a Host Skill or a later MCP adapter. The Host supplies trusted bindings. */
export function createWorkflowAuthor({ intentRuntime, capabilityGraph, publicationHost, readDocumentUrl }) {
  return Object.freeze({
    start: startAuthorDraft,
    analyze(draft, turnOptions) { return analyzeAuthorDraft(draft, intentRuntime, turnOptions); },
    readDocument(pin) { return readAuthorDocument(capabilityGraph, pin, readDocumentUrl); },
    async plan(draft, intent, proposal, { previous, graphContext } = {}) {
      const requested = proposal.capabilityRequirements ?? [];
      const result = capabilityGraph ? await checkPlanCapabilities(capabilityGraph, requested, graphContext) : null;
      const unresolvedIssues = [...(proposal.unresolvedIssues ?? [])];
      if (requested.length && !result?.supported) unresolvedIssues.push({ id: 'graph-capabilities', kind: 'capability-gap',
        description: 'The requested capabilities could not all be resolved in this Host’s authorized Graph.', blocking: true,
        relatedIntentIds: [], unresolved: result?.unresolved ?? requested });
      return createWorkflowPlan(draft, intent, { ...proposal, unresolvedIssues }, previous);
    },
    async prepare(plan, options) {
      if (!plan) throw new TypeError('A current WorkflowPlan is required');
      return prepareStandardSkill({ ...options, plan });
    },
    review: reviewStandardCandidate,
    prepareImport(candidate, target) { return prepareImportedStandardSkill(candidate, target, publicationHost); },
    publish(candidate, receipts) { return publishStandardSkill(candidate, receipts, publicationHost); }
  });
}
