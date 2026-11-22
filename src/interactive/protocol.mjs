// Shared by the compiler and the detached Host storage worker.
export const isInteractiveStage = stage => stage === 'P0-A' || stage === 'P0-B';
export const hasStepFrame = kind => kind === 'agent' || kind === 'action' || kind === 'verification' || kind==='human';

export function isHumanProof(proof) {
  return !!proof && typeof proof==='object' && Object.keys(proof).length===3
    && [proof.subjectId,proof.proofId].every(value=>typeof value==='string' && value.length>0 && value.length<=256)
    && typeof proof.evidenceHash==='string' && /^sha256:[a-f0-9]{64}$/.test(proof.evidenceHash);
}
