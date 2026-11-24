import path from 'node:path';
import {readFile} from 'node:fs/promises';
import { runVerifiedArtifact } from '../runtime/run.mjs';
import { assertPreparedProfessionalSkills } from '../runtime/tasks.mjs';
import {createInteractiveCoordinator} from '../interactive/coordinator.mjs';
import {artifactDigest, professionalSkillFileHashes} from '../shared/artifact-identity.mjs';
import { checkCandidate } from './standard-artifact.mjs';
import { interactiveStageForMode } from '../interactive/protocol.mjs';
import { start as startInteractive } from '../interactive/versioned.mjs';
import { resolveTrustedProfessionalPin } from './professional-skills.mjs';

/** Execute a version the Host approved and installed. Keep required Skill resources pinned for the Run. */
export async function runApprovedCollectionWorkflow(store, { collectionId, skillId, candidateHash, skillDirectory, executionRef },
  { hostProfile, authorizeExecution, runtime, interactive, resolveRunProfessionalSkill }, state, options) {
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
  if (await authorizeExecution(authorization) !== true) throw new Error('Host denied Workflow Skill execution');
  const bindings = manifest.professionalSkills;
  const checkPreparedSkills = (nodeId, preparedSkills) => assertPreparedProfessionalSkills(bindings, nodeId, preparedSkills);
  const policyPins = bindings.length ? { professionalSkillPins: bindings } : {};
  const stage=interactiveStageForMode(manifest.mode);
  const sourced = bindings.filter(pin => pin.source !== undefined);
  if (sourced.length) {
    async function read(pin, signal) {
      signal?.throwIfAborted();
      const scope = { ...authorization, signal };
      const material = await resolveTrustedProfessionalPin(store, pin, { collectionId, resolve: resolveRunProfessionalSkill, scope });
      signal?.throwIfAborted();
      if (!material) throw Object.assign(new Error(`Approved Professional Skill is unavailable: ${pin.id}@${pin.version}`),
        { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
      return material;
    }
    for (const pin of sourced) await read(pin, interactive?.signal ?? options?.signal);
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
          const material = await read(pin, context.signal);
          skills.push(material);
        }
        return { ...base, skills };
      };
    }
    if (!stage || stage === 'P0-A' && !interactive?.programRegistry) {
      runtime = { ...runtime, prepareAgentTask: prepareWithPins(runtime.prepareAgentTask?.bind(runtime)) };
    } else if (runtime.prepareAgentTask) {
      runtime = { ...runtime, prepareAgentTask: { ...runtime.prepareAgentTask,
        implementation: prepareWithPins(runtime.prepareAgentTask.implementation) } };
    }
  }
  if (stage) {
    const bytes = await readFile(workflowFile);
    if (artifactDigest(bytes) !== manifest.artifactHash) throw new Error('Installed Program differs from the approved artifact');
    const programIdentity = Object.fromEntries(['artifactHash','sourceHash','workflowId','workflowVersion','compilerVersion',
      'programAbiVersion','semanticsVersion','checkpointSchemaVersion','canonicalizationVersion','implementedStage']
      .map(key=>[key,manifest[key]]));
    if (stage!=='P0-A' || interactive?.programRegistry) {
      if (!interactive?.programRegistry || interactive.policy?.capabilityStage!==stage) {
        throw new Error('Approved Interactive execution requires a matching versioned Host');
      }
      const authorize=runtime.authorizeAgentTask;
      const pinnedRuntime=authorize ? {...runtime,authorizeAgentTask:{...authorize,implementation(prepared,context) {
        checkPreparedSkills(prepared.task.node.id,prepared.skills);
        return authorize.implementation(prepared,context);
      }}} : runtime;
      const reference=await interactive.programRegistry.putImmutable(bytes,programIdentity);
      return startInteractive(reference,pinnedRuntime,state,{...interactive,
        policy:{...interactive.policy,approvedSkillHash:candidateHash,...policyPins}});
    }
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
