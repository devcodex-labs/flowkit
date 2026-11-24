import path from 'node:path';
import {readFile} from 'node:fs/promises';
import { runVerifiedArtifact } from '../runtime/run.mjs';
import { assertPreparedProfessionalSkills } from '../runtime/tasks.mjs';
import {createInteractiveCoordinator} from '../interactive/coordinator.mjs';
import {loadInteractiveProgram} from '../interactive/load.mjs';
import {canonicalBytes, sha256Bytes} from '../interactive/canonical.mjs';
import {artifactDigest, professionalSkillFileHashes} from '../shared/artifact-identity.mjs';
import { checkCandidate } from './standard-artifact.mjs';
import { interactiveStageForMode } from '../interactive/protocol.mjs';
import { restrictInteractiveHostContext, start as startInteractive } from '../interactive/versioned.mjs';
import { resolveTrustedProfessionalPin } from './professional-skills.mjs';

async function approvedWorkflow(store, { collectionId, skillId, candidateHash, skillDirectory, executionRef },
  { hostProfile, authorizeExecution, resolveRunProfessionalSkill }) {
  if (typeof executionRef !== 'string' || !executionRef.trim() || typeof authorizeExecution !== 'function') {
    throw new Error('Host execution authorization is required');
  }
  const candidate = store.readVersion(collectionId, skillId, candidateHash);
  if (!candidate || candidate.manifest.collectionId !== collectionId || candidate.manifest.skillId !== skillId ||
    candidate.hash !== candidateHash) throw new Error('No approved Workflow Skill at the requested identity');
  checkCandidate(candidate);
  const manifest = candidate.manifest;
  if (!hostProfile || hostProfile.id !== manifest.hostProfile.id || hostProfile.digest !== manifest.hostProfile.digest) {
    throw new Error('Current Host profile differs from the approved Workflow Skill');
  }
  const workflowFile = path.join(path.resolve(skillDirectory), 'workflow.js');
  const authorization = Object.freeze({ collectionId, skillId, candidateHash, executionRef, workflowFile, artifactHash: manifest.artifactHash });
  const allowed = async () => await authorizeExecution(authorization) === true;
  if (!await allowed()) throw new Error('Host denied Workflow Skill execution');
  const bindings = manifest.professionalSkills;
  const checkPreparedSkills = (nodeId, preparedSkills) => assertPreparedProfessionalSkills(bindings, nodeId, preparedSkills);
  const policyPins = bindings.length ? { professionalSkillPins: bindings } : {};
  const sourced = bindings.filter(pin => pin.source !== undefined);
  async function read(pin, signal) {
    signal?.throwIfAborted();
    const scope = { ...authorization, signal };
    const material = await resolveTrustedProfessionalPin(store, pin, { collectionId, resolve: resolveRunProfessionalSkill, scope });
    signal?.throwIfAborted();
    if (!material) throw Object.assign(new Error(`Approved Professional Skill is unavailable: ${pin.id}@${pin.version}`),
      { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    return material;
  }
  async function checkSources(signal, nodeId) {
    for (const pin of sourced) if (nodeId === undefined || pin.nodeId === nodeId) await read(pin, signal);
  }
  function prepareWithPins(previous) {
    return async (task, context) => {
      const base = previous ? await previous(task, context) :
        { protocolVersion: 2, task, descriptionResources: context.descriptionResources, skills: [] };
      const skills = [];
      for (const [index, requirement] of (task.task.requiredSkills ?? []).entries()) {
        const pin = sourced.find(item => item.nodeId === task.node.id && item.id === requirement.id);
        const supplied = base.skills[index];
        if (!pin) { skills.push(supplied); continue; }
        if (supplied && (supplied.logicalId !== pin.id || supplied.resolvedVersion !== pin.version || supplied.digest !== pin.digest ||
            supplied.source !== undefined && supplied.source !== pin.source ||
            supplied.files !== undefined && artifactDigest(JSON.stringify(professionalSkillFileHashes(supplied.files))) !== pin.digest)) {
          throw Object.assign(new Error('Host prepared a different Professional Skill identity'), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
        }
        skills.push(await read(pin, context.signal));
      }
      return { ...base, skills };
    };
  }
  return { manifest, workflowFile, allowed, checkPreparedSkills, policyPins, checkSources, prepareWithPins, hasSourcedPins: sourced.length > 0 };
}

async function approvedProgram({ manifest, workflowFile }) {
  const bytes = await readFile(workflowFile);
  if (artifactDigest(bytes) !== manifest.artifactHash) throw new Error('Installed Program differs from the approved artifact');
  const program = await loadInteractiveProgram(bytes, manifest.artifactHash);
  return { bytes, identity: { ...program.interactiveProgram.identity, artifactHash: program.artifactHash } };
}

function bindInteractive(approved, candidateHash, { runtime, interactive }) {
  const stage = interactiveStageForMode(approved.manifest.mode);
  if (!stage || !interactive?.programRegistry || interactive.policy?.capabilityStage !== stage) {
    throw new Error('Approved Interactive execution requires a matching versioned Host');
  }
  const { artifactHash } = approved.manifest;
  const policy = { ...interactive.policy, approvedSkillHash: candidateHash, ...approved.policyPins };
  const policyHash = sha256Bytes(canonicalBytes(policy));
  const auth = restrictInteractiveHostContext(interactive.auth, {
    async authorize(request) {
      if (!await approved.allowed()) return false;
      if (request.action === 'run:create') return request.artifactHash === artifactHash;
      const checkpoint = await interactive.store.load(request.runId);
      if (checkpoint?.program.artifactHash !== artifactHash || checkpoint.policyIdentity.policyHash !== policyHash) return false;
      // The P0-A receipt path authorizes through the original Runtime callback.
      // Recheck the source here as well for a new, still-pending receipt.
      if (stage === 'P0-A' && request.action === 'run:complete') {
        const pending = checkpoint.pending.find(task => task.requestId === request.requestId);
        if (pending) await approved.checkSources(interactive.signal, pending.nodeId);
      }
      return true;
    },
    async authorizeTask(request) {
      await approved.checkSources(interactive.signal, request.nodeId);
      return true;
    }
  });
  const prepare = runtime.prepareAgentTask;
  if (prepare && approved.hasSourcedPins) runtime = { ...runtime, prepareAgentTask: { ...prepare,
    implementation: approved.prepareWithPins(prepare.implementation) } };
  const authorize = runtime.authorizeAgentTask;
  if (authorize) runtime = { ...runtime, authorizeAgentTask: { ...authorize, implementation(prepared, context) {
    approved.checkPreparedSkills(prepared.task.node.id, prepared.skills);
    return authorize.implementation(prepared, context);
  } } };
  return { runtime, options: { ...interactive, auth, policy } };
}

/** Rebind the same approved workflow to a versioned Interactive Host before continuing an existing Run. */
export async function bindApprovedInteractiveWorkflow(store, target, host) {
  const approved = await approvedWorkflow(store, target, host);
  return bindInteractive(approved, target.candidateHash, host);
}

/** Execute a version the Host approved and installed. Keep required Skill resources pinned for the Run. */
export async function runApprovedCollectionWorkflow(store, target, host, state, options) {
  const approved = await approvedWorkflow(store, target, host);
  const { manifest, workflowFile, checkPreparedSkills, policyPins } = approved;
  const { candidateHash } = target;
  let { runtime, interactive } = host;
  await approved.checkSources(interactive?.signal ?? options?.signal);
  const stage = interactiveStageForMode(manifest.mode);
  if (stage && (stage !== 'P0-A' || interactive?.programRegistry)) {
    const bound = bindInteractive(approved, candidateHash, host);
    const { bytes, identity } = await approvedProgram(approved);
    const reference = await interactive.programRegistry.putImmutable(bytes, identity);
    return startInteractive(reference, bound.runtime, state, bound.options);
  }
  if (approved.hasSourcedPins) {
    runtime = { ...runtime, prepareAgentTask: approved.prepareWithPins(runtime.prepareAgentTask?.bind(runtime)) };
  }
  if (stage) {
    const { bytes, identity: programIdentity } = await approvedProgram(approved);
    if (!interactive?.store || typeof runtime.authorizeAgentTask !== 'function') {
      throw new Error('Approved Interactive execution requires Host persistence and task authorization');
    }
    const pinnedRuntime = {...runtime,authorizeAgentTask(prepared,context) {
      checkPreparedSkills(prepared.task.node.id,prepared.skills);
      return runtime.authorizeAgentTask(prepared,context);
    }};
    const api = createInteractiveCoordinator({store:interactive.store,runtime:pinnedRuntime,
      policy:{...interactive.policy,approvedSkillHash:candidateHash,...policyPins}});
    return api.start({programBytes:bytes,programIdentity,state,startKey:interactive.startKey,runId:interactive.runId});
  }
  return runVerifiedArtifact(workflowFile, manifest.artifactHash, runtime, state, options, checkPreparedSkills);
}
