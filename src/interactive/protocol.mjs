// Shared by the compiler and the detached Host storage worker.
export const isInteractiveStage = stage => ['P0-A','P0-B','P1','P2'].includes(stage);
export const hasStepFrame = kind => kind === 'agent' || kind === 'action' || kind === 'verification' || kind==='human';

export function publishedInteractivePending(checkpoint) {
  if (checkpoint.status!=='waiting') return [];
  if (checkpoint.parallel) return checkpoint.parallel.lanes.flatMap(lane=>lane.pending?[lane.pending]:[]);
  return checkpoint.pending?[checkpoint.pending]:[];
}

export function isHumanProof(proof) {
  return !!proof && typeof proof==='object' && Object.keys(proof).length===3
    && [proof.subjectId,proof.proofId].every(value=>typeof value==='string' && value.length>0 && value.length<=256)
    && typeof proof.evidenceHash==='string' && /^sha256:[a-f0-9]{64}$/.test(proof.evidenceHash);
}
