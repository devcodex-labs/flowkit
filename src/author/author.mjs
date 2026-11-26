import { analyzeAuthorDraft, checkPlanCapabilities, startAuthorDraft } from './draft.mjs';
import { readAuthorDocument } from './documentation.mjs';
import { prepareImportedStandardSkill, prepareStandardSkill, publishStandardSkill, reviewStandardCandidate } from './standard-artifact.mjs';
import { createWorkflowPlan } from './workflow-plan.mjs';

/** Shared Author operations for a Host Skill or a later MCP adapter. The Host supplies trusted bindings. */
export function createWorkflowAuthor({ intentRuntime, capabilityGraph, publicationHost, readDocumentUrl,
  verifySafetyPolicy, resolveApplicableSafetyPolicies }) {
  const readDocuments=new Map();
  const documentKey=({capabilityId,documentId})=>JSON.stringify([capabilityId,documentId]);
  return Object.freeze({
    start: startAuthorDraft,
    analyze(draft, turnOptions) { return analyzeAuthorDraft(draft, intentRuntime, turnOptions); },
    async readDocument(pin) {
      const result=await readAuthorDocument(capabilityGraph,pin,readDocumentUrl);
      const key=documentKey(result.evidence);readDocuments.delete(key);
      readDocuments.set(key,{pin:structuredClone(pin),evidence:structuredClone(result.evidence)});
      if(readDocuments.size>64)readDocuments.delete(readDocuments.keys().next().value);
      return result;
    },
    async plan(draft, intent, proposal, { previous, graphContext, sourceHash } = {}) {
      const requested = proposal.capabilityRequirements ?? [];
      const result = capabilityGraph ? await checkPlanCapabilities(capabilityGraph, requested, graphContext) : null;
      const unresolvedIssues = [...(proposal.unresolvedIssues ?? [])];
      if (requested.length && !result?.supported) unresolvedIssues.push({ id: 'graph-capabilities', kind: 'capability-gap',
        description: 'The requested capabilities could not all be resolved in this Host’s authorized Graph.', blocking: true,
        relatedIntentIds: [], unresolved: result?.unresolved ?? requested });
      return createWorkflowPlan(draft, intent, { ...proposal, unresolvedIssues }, previous, sourceHash);
    },
    async prepare(plan, options) {
      if (!plan) throw new TypeError('A current WorkflowPlan is required');
      const documents=[];
      for(const evidence of options.documents ?? [...readDocuments.values()].map(entry=>entry.evidence)) {
        const entry=readDocuments.get(documentKey(evidence));
        if(!entry)throw new Error('The selected document was not read through this Author Host');
        const current=await readAuthorDocument(capabilityGraph,entry.pin,readDocumentUrl);
        if(JSON.stringify(current.evidence)!==JSON.stringify(evidence))throw new Error('Document provenance differs from the actual read');
        documents.push(current.evidence);
      }
      return prepareStandardSkill({ ...options, plan, documents, verifySafetyPolicy, resolveApplicableSafetyPolicies });
    },
    review: reviewStandardCandidate,
    prepareImport(candidate, target) { return prepareImportedStandardSkill(candidate, target, publicationHost); },
    publish(candidate, receipts) { return publishStandardSkill(candidate, receipts, publicationHost); }
  });
}
