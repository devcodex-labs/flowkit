import { checkProfessionalSkill, prepareProfessionalSkill } from './professional-skills.mjs';
import { isWorkflowId } from '../shared/contracts.mjs';

/** Search always precedes drafting. Only Host-supplied material can become a Plan pin. */
export async function bindProfessionalNeeds(proposal, { catalog, collection, requestContext, signal, read, draftSkill, drafts, selectionFor, verifyApplicability }) {
  const requirements = [...(proposal.resourceRequirements ?? [])];
  const question = (node, need, reason, candidates = []) => ({
    id: `skill-${node.id}-${need.id}`, kind: 'resource-gap', blocking: true, relatedIntentIds: [],
    description: `${node.id}/${need.id}: ${reason}`,
    options: [
      ...candidates.slice(0, 4).map(({ source, candidate: { manifest } }) => ({
        value: JSON.stringify([source, manifest.skillId, manifest.version, manifest.digest]),
        label: `${manifest.name} ${manifest.version} (${source})`, reason: 'Use this exact approved Skill and source.'
      })),
      { value: 'resolve-catalog', label: 'Review Skill access and selection', reason: 'Keep the workflow blocked until the required Skill can be verified.' },
      { value: 'revise-workflow', label: 'Revise the workflow requirement', reason: 'Change the explicit Skill requirement in a new reviewed Plan.' }
    ].slice(0, 5), recommended: candidates.length ? JSON.stringify([candidates[0].source, candidates[0].candidate.manifest.skillId,
      candidates[0].candidate.manifest.version, candidates[0].candidate.manifest.digest]) : 'resolve-catalog'
  });
  const issues = [], nodes = [];
  for (const node of proposal.nodes) {
    const needs = node.professionalNeeds;
    if (needs === undefined) { nodes.push(node); continue; }
    if (node.kind !== 'agent' || !Array.isArray(needs) || !needs.length || needs.length > 8 ||
        needs.some(need => !isWorkflowId(need?.id) || typeof need.description !== 'string' || !need.description.trim() ||
          need.description.length > 500) ||
        new Set(needs.map(need => need.id)).size !== needs.length || node.options?.requiredSkills?.length) {
      throw new TypeError('Agent Professional Skill needs require unique IDs and descriptions, outside DSL options');
    }
    const requiredSkills = [];
    for (const { id, description } of needs) {
      const selection = selectionFor(node.id, id);
      const result = catalog && await read({ findProfessionalSkill: id }, () =>
        catalog.search({ id, description, collection, requestContext, signal, verifyApplicability }));
      if (result?.denied === true || result?.complete !== true || !Array.isArray(result.matches) || result.matches.length > 32) {
        issues.push(question(node, { id }, result?.denied ? 'Skill discovery was denied' : 'Skill discovery was incomplete or unavailable'));
        continue;
      }
      const matches = result.matches.map(match => {
        const { candidate, source, approved } = match;
        if (approved !== true || typeof source !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(source)) {
          throw new TypeError('Catalog matches must identify an approved Skill and authorized source');
        }
        checkProfessionalSkill(candidate);
        return match;
      });
      let matched = selection === undefined && matches.length === 1 ? matches[0] : matches.find(({ source, candidate: { manifest } }) =>
        selection === JSON.stringify([source, manifest.skillId, manifest.version, manifest.digest]));
      if (!matched && !matches.length && result.occupied) {
        issues.push(question(node, { id }, 'Existing Skill does not satisfy this procedure. Select a different Skill ID or review the existing one.'));
        continue;
      }
      if (!matched && (matches.length > 0 || selection !== undefined)) {
        issues.push(question(node, { id }, 'Select an approved exact Skill from the current catalog', matches));
        continue;
      }
      if (!matched) {
        let candidate = drafts.get(id);
        if (candidate && candidate.manifest.description !== description) {
          issues.push(question(node, { id }, 'Different procedures require different logical Skill IDs'));
          continue;
        }
        if (!candidate) {
          const body = await draftSkill({ id, description, lookup: { complete: true, matches: 0 },
            node: { inputs: node.options?.inputs ?? [], output: node.options?.output } });
          if (!body) { issues.push(question(node, { id }, 'No matching Skill exists and the Host did not produce a draft')); continue; }
          candidate = prepareProfessionalSkill(collection, { id, name: id, version: '1.0.0', description, body });
          drafts.set(id, candidate);
        }
        matched = { candidate, source: 'collection:' + collection.id, approved: false };
      }
      const { skillId, version, digest } = matched.candidate.manifest;
      if (requiredSkills.some(skill => skill.id === skillId)) {
        if (!requirements.some(pin => pin.nodeId === node.id && pin.id === skillId && pin.version === version &&
            pin.digest === digest && pin.source === matched.source)) {
          issues.push(question(node, { id }, 'Conflicting versions or sources use the same logical Skill ID'));
        }
        continue;
      }
      requiredSkills.push({ id: skillId, version });
      requirements.push({ kind: 'professional-skill', nodeId: node.id, needId: id, id: skillId, version, digest, source: matched.source,
        required: true, lookup: { complete: true, matches: matches.length, resolution: matched.approved ? 'reuse-approved' : 'draft-after-no-match' },
        ...(selection === undefined ? {} : { selection }) });
    }
    nodes.push({ ...node, options: { ...node.options, requiredSkills } });
  }
  return { ...proposal, nodes, resourceRequirements: requirements, unresolvedIssues: [...(proposal.unresolvedIssues ?? []), ...issues] };
}
