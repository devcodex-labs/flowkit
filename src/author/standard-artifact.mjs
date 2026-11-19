import { compileArtifactDraft } from '../compiler/api.mjs';
import { STANDARD_ARTIFACT_HEADER, artifactDigest, standardIdentity } from '../shared/artifact-identity.mjs';
import { isSemVer } from '../shared/task-spec.mjs';
import { skillDocument, validateSkillName,workflowReference } from './skill-document.mjs';
import { assertReadyStandardPlan } from './workflow-plan.mjs';
import { compileInteractiveDraft } from '../interactive/compile.mjs';

const SOURCE_PATH = 'source/workflow.dsl.js';
const FORMAL_PATHS = ['SKILL.md', 'workflow.js', 'workflow.mmd'];
const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) && value.length === 71;
const identifier = value => typeof value === 'string' && value.length > 0 && !/\s/.test(value);
const bindingKey = (nodeId, id) => JSON.stringify([nodeId, id]);

function interactiveIdentity(code) {
  const line = code.split('\n').find(line=>line.startsWith('export const interactiveProgram = freezeData('));
  const metadata = JSON.parse(line?.slice('export const interactiveProgram = freezeData('.length,-2));
  if (metadata.artifactFormat !== 'FlowkitInteractiveProgramV1' || metadata.identity.programAbiVersion !== 1 ||
    metadata.identity.semanticsVersion !== 'interactive-state-machine-v1' || metadata.identity.implementedStage !== 'P0-A') {
    throw new TypeError('Invalid Interactive artifact identity');
  }
  return {...metadata.identity,artifactHash:artifactDigest(code)};
}

function resolveSkillPins(definition, pins) {
  if (!Array.isArray(pins)) throw new TypeError('Professional Skill pins must be an array');
  const bindings = new Map();
  for (const { nodeId, id, version, digest: contentDigest } of pins) {
    const key = bindingKey(nodeId, id);
    if (!identifier(nodeId) || !identifier(id) || !isSemVer(version) || !digest(contentDigest) || bindings.has(key)) {
      throw new TypeError('Each Professional Skill pin needs a unique node, logical ID, exact version and digest');
    }
    bindings.set(key, Object.freeze({ nodeId, id, version, digest: contentDigest }));
  }
  const required = definition.nodes.flatMap(node => (node.requiredSkills ?? []).map(skill => {
    const key = bindingKey(node.id, skill.id);
    const pin = bindings.get(key);
    if (!pin || skill.version !== undefined && pin.version !== skill.version) {
      throw new TypeError(`Missing matching Professional Skill pin for ${node.id}/${skill.id}`);
    }
    bindings.delete(key);
    return pin;
  }));
  if (bindings.size) throw new TypeError('Unexpected Professional Skill pins');
  return Object.freeze(required);
}

/** Produce a candidate only. The Host owns review, approval, discovery and execution. */
export async function prepareStandardSkill({ file, collectionId, skillId, name, description, version,
  hostProfile, buildId, includeSource = false, professionalSkills = [], compilerOptions, plan: suppliedPlan,
  executionMode = suppliedPlan?.target.executionMode ?? 'standard',references={},documents=[],
  safetyPolicies=[],verifySafetyPolicy }) {
  references=structuredClone(references);professionalSkills=structuredClone(professionalSkills);
  safetyPolicies=structuredClone(safetyPolicies);
  if (!['standard','interactive-p0-a'].includes(executionMode)) throw new TypeError('Unsupported Workflow Skill mode');
  if(!references || Object.entries(references).some(([name,body])=>!workflowReference(name)||typeof body!=='string') ||
    Object.keys(references).length!==new Set(Object.keys(references).map(name=>name.toLowerCase())).size) {
    throw new TypeError('Only portable workflow-specific references may be attached');
  }
  const documentEvidence=structuredClone(documents);
  if(!Array.isArray(documentEvidence)||documentEvidence.some(item=>!identifier(item?.capabilityId)||!identifier(item?.documentId)||
    !identifier(item?.revision)||!digest(item?.contentHash)||!['file','url'].includes(item?.source?.type))) {
    throw new TypeError('Document provenance needs the actual read revision, source and content hash');
  }
  if (!identifier(collectionId) || !identifier(skillId) || !isSemVer(version) ||
    !identifier(hostProfile?.id) || !digest(hostProfile.digest) || !identifier(buildId)) {
    throw new TypeError('A collection, a versioned Skill, a pinned Host profile and a build ID are required');
  }
  if (typeof includeSource !== 'boolean' || includeSource && (typeof file !== 'string' || !file.endsWith('.workflow.js'))) {
    throw new TypeError('Only a JavaScript DSL source can be retained as source/workflow.dsl.js');
  }
  const entry = skillDocument(name, description,
    '# Run this workflow\n\nAsk the Host to verify this Skill’s approved Artifact and required capabilities. ' +
    (executionMode === 'standard' ? 'Use the Host’s FlowKit `runArtifact` entry point with `workflow.js` and its approved SHA-256. ' :
      'Use the Host’s Interactive start/resume entry points with `workflow.js`, its approved Program identity and the original Run. ') +
    'Use `workflow.mmd` to view the static workflow.\n\n' +
    '[FlowKit documentation](https://devcodex-labs.github.io/flowkit/).' +
    (documentEvidence.length?'\n\nReviewed documentation:\n'+documentEvidence.map(item=>
      `- ${item.documentId}: ${item.source.type==='url'?item.source.url:item.source.path} (${item.revision}, ${item.contentHash})`).join('\n'):''));
  const profile = Object.freeze({ id: hostProfile.id, digest: hostProfile.digest });
  const plan = suppliedPlan === undefined ? undefined : structuredClone(suppliedPlan);
  if (plan !== undefined) assertReadyStandardPlan(plan,executionMode);
  const compiled = executionMode === 'standard' ? await compileArtifactDraft(file, { ...compilerOptions, mermaid: true }) :
    await compileInteractiveDraft(file, {...compilerOptions,output:'memory',featureStage:'P0-A'});
  const {snapshot,definition,graph} = compiled;
  const artifact = executionMode === 'standard' ? compiled.artifact : {...compiled,artifactHash:compiled.programIdentity?.artifactHash};
  if (!artifact.artifactHash) return { candidate: null, diagnostics: artifact.diagnostics };
  if (plan?.sourceHash !== undefined && plan.sourceHash !== `sha256:${snapshot.sourceHash}`) {
    throw Object.assign(new Error('Compiled source bytes differ from the WorkflowPlan.'), {
      code: 'FKA_PLAN_MISMATCH', detail: { expectedSourceHash: plan.sourceHash, actualSourceHash: `sha256:${snapshot.sourceHash}` }
    });
  }
  const approvedSafety=[];
  if(!Array.isArray(safetyPolicies))throw new TypeError('Host safety policies must be an array');
  for(const node of definition.nodes) {
    if(node.type==='human' && !Number.isSafeInteger(node.maxRevisions)) {
      throw Object.assign(new Error('Author requires a finite maxRevisions for automated Human revision'), { code: 'FKA_HUMAN_LIMIT_REQUIRED', nodeId: node.id });
    }
    if(node.type==='parallel' && node.join.strategy==='any' && node.branches.some(id=>
      ['agent','action'].includes(graph.byId.get(id)?.type))) {
      const binding=safetyPolicies.find(item=>item?.nodeId===node.id);
      if(!identifier(binding?.policyRef)||typeof verifySafetyPolicy!=='function'||await verifySafetyPolicy({
        node:structuredClone(node),branches:node.branches.map(id=>structuredClone(graph.byId.get(id))),
        artifactHash:artifact.artifactHash,hostProfile:profile,policyRef:binding.policyRef})!==true) {
        throw Object.assign(new Error('parallel.any with possible writes requires a Host-approved policy for the exact artifact'), {
          code: 'FKA_SAFETY_POLICY_REQUIRED', nodeId: node.id, artifactHash: artifact.artifactHash });
      }
      approvedSafety.push({nodeId:node.id,policyRef:binding.policyRef});
    }
  }
  if (plan && (definition.nodes[0].id !== plan.entryNodeId || definition.nodes.length !== plan.nodes.length ||
    plan.nodes.some(node => graph.byId.get(node.id)?.type !== node.kind))) {
    throw Object.assign(new Error('Compiled entry or node identities differ from the WorkflowPlan.'), {
      code: 'FKA_PLAN_MISMATCH',
      detail: { expectedEntry: plan.entryNodeId, actualEntry: definition.nodes[0].id,
        expectedNodes: plan.nodes.map(({id,kind}) => [id,kind]), actualNodes: definition.nodes.map(({id,type}) => [id,type]) }
    });
  }
  if (plan) {
    const loopMismatches = plan.nodes.filter(node => node.kind === 'loop').flatMap(node => {
      const actual = graph.byId.get(node.id);
      if (node.onSuccess === actual.onSuccess && node.onMaxExceeded === actual.onMaxExceeded) return [];
      return [{ nodeId: node.id, expected: { onSuccess: node.onSuccess, onMaxExceeded: node.onMaxExceeded },
        actual: { onSuccess: actual.onSuccess, onMaxExceeded: actual.onMaxExceeded } }];
    });
    if (loopMismatches.length) {
      throw Object.assign(new Error('Compiled Loop exits differ from the WorkflowPlan.'), {
        code: 'FKA_PLAN_MISMATCH', detail: { loopMismatches }
      });
    }
    const controlKey = ({ from, to }) => JSON.stringify([from, to]);
    const compiledEdges = new Set([...graph.referenceEdges, ...graph.executionEdges].map(controlKey));
    const plannedEdges=new Set(plan.edges.filter(edge=>edge.kind==='control').map(controlKey));
    if (plannedEdges.size!==compiledEdges.size || [...plannedEdges].some(edge=>!compiledEdges.has(edge))) {
      throw Object.assign(new Error('Compiled control flow differs from the WorkflowPlan.'), {
        code: 'FKA_PLAN_MISMATCH',
        detail: { missingEdges: [...plannedEdges].filter(edge => !compiledEdges.has(edge)).map(edge => JSON.parse(edge)),
          extraEdges: [...compiledEdges].filter(edge => !plannedEdges.has(edge)).map(edge => JSON.parse(edge)) }
      });
    }
  }
  const files = Object.freeze({ 'SKILL.md': entry, 'workflow.js': artifact.code, 'workflow.mmd': artifact.mermaid,
    ...(includeSource ? { [SOURCE_PATH]: snapshot.sourceText } : {}),...references });
  const manifest = Object.freeze({ mode: executionMode, collectionId, skillId, name, version,
    workflowDefinition:structuredClone(definition),
    workflowId: definition.id, workflowVersion: definition.version,
    sourceHash: `sha256:${snapshot.sourceHash}`, ...(executionMode === 'standard' ? standardIdentity(artifact.code) : artifact.programIdentity), hostProfile: profile,
    professionalSkills: resolveSkillPins(definition, professionalSkills), buildId, builtAt: new Date().toISOString(),
    ...(documentEvidence.length?{documents:documentEvidence}:{}),
    ...(approvedSafety.length?{safetyPolicies:approvedSafety}:{}),
    ...(plan ? { planRef: Object.freeze({ planId: plan.planId, revision: plan.revision, planHash: plan.planHash,
      effectiveIntentHash: plan.intentRef.effectiveIntentHash }) } : {}),
    files: Object.freeze(Object.fromEntries(Object.entries(files).map(([filename, body]) => [filename, artifactDigest(body)]))) });
  return { candidate: Object.freeze({ files, manifest, hash: artifactDigest(JSON.stringify(manifest)) }),
    diagnostics: artifact.diagnostics };
}

export function checkCandidate({ files, manifest, hash }) {
  validateSkillName(manifest.name);
  const names = Object.keys(files);
  const expected = [...FORMAL_PATHS,...(Object.hasOwn(files, SOURCE_PATH)?[SOURCE_PATH]:[])];
  const referenceNames=names.filter(workflowReference);expected.push(...referenceNames);
  const interactive = manifest.mode === 'interactive-p0-a';
  if (!['standard','interactive-p0-a'].includes(manifest.mode) || !identifier(manifest.collectionId) || !identifier(manifest.skillId) ||
    !isSemVer(manifest.version) || !digest(manifest.sourceHash) || !identifier(manifest.hostProfile?.id) ||
    !digest(manifest.hostProfile.digest) || !Array.isArray(manifest.professionalSkills) ||
    manifest.documents && (!Array.isArray(manifest.documents)||manifest.documents.some(item=>!identifier(item?.capabilityId)||
      !identifier(item?.documentId)||!identifier(item?.revision)||!digest(item?.contentHash)||!['file','url'].includes(item?.source?.type))) ||
    manifest.professionalSkills.some(pin => !identifier(pin?.nodeId) || !identifier(pin?.id) || !isSemVer(pin.version) || !digest(pin.digest)) ||
    names.length !== expected.length ||
    names.length!==new Set(names.map(name=>name.toLowerCase())).size ||
    Object.keys(manifest.files).length !== expected.length ||
    expected.some(name => !Object.hasOwn(files, name) || typeof files[name] !== 'string' ||
      artifactDigest(files[name]) !== manifest.files[name]) ||
    hash !== artifactDigest(JSON.stringify(manifest)) || !files['SKILL.md'].startsWith(`---\nname: ${manifest.name}\n`) ||
    !files['workflow.mmd'].startsWith('flowchart TD\n') || !files['workflow.js'].startsWith(interactive ?
      '// @generated by FlowKit Interactive — P0-A / Program ABI V1\n' : `${STANDARD_ARTIFACT_HEADER}\n`) ||
    Object.entries(interactive ? interactiveIdentity(files['workflow.js']) : standardIdentity(files['workflow.js'])).some(([key, value]) => manifest[key] !== value) ||
    Object.hasOwn(files, SOURCE_PATH) && manifest.sourceHash !== manifest.files[SOURCE_PATH]) {
    throw new TypeError('Workflow Skill candidate bytes or manifest differ');
  }
}

/** Describe compiler facts separately from the rendered Mermaid view. */
export function standardReviewEvidence({ manifest, files }) {
  const nodes = manifest.workflowDefinition?.nodes ?? [];
  const rendererOnlyIds = [...files['workflow.mmd'].matchAll(/^\s*(_Flowkit\w+)\(/gm)].map(match => match[1]);
  return {
    declaredNodeIds: nodes.map(node => node.id),
    declaredTerminalIds: nodes.filter(node => node.type === 'terminal').map(node => node.id),
    rendererOnlyIds: [...new Set(rendererOnlyIds)],
    documentationFiles: ['SKILL.md', 'workflow.mmd'],
    conditions: nodes.filter(node => node.type === 'condition').map(node => ({
      nodeId: node.id, firstMatch: node.branches.map(({ when, next }) => ({ when, next }))
    })),
    parallel: nodes.filter(node => node.type === 'parallel').map(node => ({
      nodeId: node.id, members: [...node.branches], continuation: node.join.next, strategy: node.join.strategy,
      continuationRequires: node.join.strategy === 'all_succeeded' ? 'all-members-succeeded' : 'one-member-succeeded',
      memberToContinuationEdges: 'derived-after-join'
    }))
  };
}

/** Show exactly what a candidate would change before the Host collects approval. */
export function reviewStandardCandidate(candidate, previous = null) {
  checkCandidate(candidate);
  if (previous) checkCandidate(previous);
  const { collectionId, skillId } = candidate.manifest;
  if (previous && (previous.manifest.collectionId !== collectionId || previous.manifest.skillId !== skillId)) {
    throw new Error('Previous artifact belongs to a different Skill');
  }
  const before = previous?.manifest.files ?? {};
  const after = candidate.manifest.files;
  const files = [...new Set([...Object.keys(before), ...Object.keys(after)])].map(path => ({
    path, previousHash: before[path] ?? null, candidateHash: after[path] ?? null
  })).filter(entry => entry.previousHash !== entry.candidateHash);
  return { collectionId, skillId, previousHash: previous?.hash ?? null, candidateHash: candidate.hash,
    previousVersion: previous?.manifest.version ?? null, candidateVersion: candidate.manifest.version, files,
    compilerEvidence: standardReviewEvidence(candidate),
    semantics:{previousMode:previous?.manifest.mode??null,candidateMode:candidate.manifest.mode,
      previousDefinitionAvailable:!!previous?.manifest.workflowDefinition,
      nodes:[...new Set([...(previous?.manifest.workflowDefinition?.nodes??[]).map(node=>node.id),
        ...(candidate.manifest.workflowDefinition?.nodes??[]).map(node=>node.id)])].map(nodeId=>({nodeId,
          before:previous?.manifest.workflowDefinition?.nodes.find(node=>node.id===nodeId)??null,
          after:candidate.manifest.workflowDefinition?.nodes.find(node=>node.id===nodeId)??null}))
        .filter(change=>JSON.stringify(change.before)!==JSON.stringify(change.after))}};
}

/** The trusted Host verifies both receipts and performs one conditional commit at its discovery boundary. */
export async function publishReviewedCandidate(candidate, { reviewRef, approvalRef, previousHash }, host, validate) {
  if (!identifier(reviewRef) || !identifier(approvalRef) || previousHash !== null && !digest(previousHash)) {
    throw new TypeError('Publication requires review, approval and the expected previous candidate');
  }
  const snapshot = structuredClone(candidate);
  validate(snapshot);
  return host.publishAtomically({ candidate: snapshot, reviewRef, approvalRef, previousHash });
}

export function publishStandardSkill(candidate, receipts, host) {
  return publishReviewedCandidate(candidate, receipts, host, checkCandidate);
}

/** Restore a vouched-for source. A new collection gets its own candidate and approval. */
export async function prepareImportedStandardSkill(candidate, { mode, collectionId, skillId, sourceRef }, host) {
  const source = structuredClone(candidate);
  checkCandidate(source);
  const current = source.manifest;
  if (!identifier(collectionId) || !identifier(skillId) || !identifier(sourceRef) ||
    !['new-collection', 'migration'].includes(mode) ||
    mode === 'migration' && (current.collectionId !== collectionId || current.skillId !== skillId) ||
    mode === 'new-collection' && current.collectionId === collectionId) {
    throw new TypeError('Import requires a distinct new collection or an explicit identity-preserving migration');
  }
  if (typeof host?.verifyImport !== 'function' || await host.verifyImport({ mode, sourceRef, collectionId, skillId,
    approvedSource: structuredClone(current), sourceHash: source.hash }) !== true) {
    throw new Error('Host could not verify the source approval or destination prerequisites for this Workflow Skill');
  }
  if (mode === 'migration') return source;
  const manifest = { ...current, collectionId, skillId,
    importedFrom: { collectionId: current.collectionId, skillId: current.skillId, hash: source.hash } };
  return { files: source.files, manifest, hash: artifactDigest(JSON.stringify(manifest)) };
}
