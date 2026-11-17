import path from 'node:path';
import { runVerifiedArtifact } from '../runtime/run.mjs';
import { checkCandidate } from './standard-artifact.mjs';

/** Execute a version the Host approved and installed. Keep required Skill resources pinned for the Run. */
export async function runApprovedCollectionWorkflow(store, { collectionId, skillId, candidateHash, skillDirectory, executionRef },
  { hostProfile, authorizeExecution, runtime }, state, options) {
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
  const checkPreparedSkills = (nodeId, preparedSkills) => {
    const pins = bindings.filter(pin => pin.nodeId === nodeId);
    if (preparedSkills.length !== pins.length || pins.some((pin, index) => {
      const resolved = preparedSkills[index];
      return resolved.logicalId !== pin.id || resolved.resolvedVersion !== pin.version || resolved.digest !== pin.digest;
    })) throw new Error('Prepared Professional Skills differ from the approved Run bindings');
  };
  return runVerifiedArtifact(workflowFile, manifest.artifactHash, runtime, state, options, checkPreparedSkills);
}
