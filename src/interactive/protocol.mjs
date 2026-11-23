// Shared by the compiler and the detached Host storage worker.
export const isInteractiveStage = stage => ['P0-A','P0-B','P1','P2'].includes(stage);
export const hasStepFrame = kind => kind === 'agent' || kind === 'action' || kind === 'verification' || kind==='human';

const authorModes=Object.freeze({
  'interactive-p0-a':'P0-A', 'interactive-p0-b':'P0-B', 'interactive-p1':'P1', 'interactive-p2':'P2',
});
export const workflowExecutionModes=Object.freeze(['standard',...Object.keys(authorModes)]);
export const interactiveStageForMode=mode=>Object.hasOwn(authorModes,mode)?authorModes[mode]:undefined;
export const interactiveModeForStage=stage=>'interactive-'+stage.toLowerCase();

/** Sequential and all-succeeded runs cannot progress past their shared task budget. */
export function runDeadlineExpired(cp, now=Date.now()) {
  return ['P0-B','P1'].includes(cp.program.implementedStage) && cp.taskContext?.deadlineMs<=now;
}

export function publishedInteractivePending(checkpoint) {
  if (checkpoint.status!=='waiting') return [];
  if (checkpoint.parallel) return parallelPendingEntries(checkpoint.parallel).map(entry=>entry.pending);
  return checkpoint.pending?[checkpoint.pending]:[];
}

/** Traverse only live scopes. Sealed groups may retain cancelled snapshots for reconciliation. */
export function parallelPendingEntries(group,ancestors=[]) {
  if (group.decision) return [];
  return group.lanes.flatMap(lane=>{
    if (['cancelled','failed','errored','succeeded'].includes(lane.status)) return [];
    const scope=lane.scope;
    const groups=[...ancestors,group];
    if (scope?.parallel) return parallelPendingEntries(scope.parallel,groups);
    const pending=scope?.pending??lane.pending;
    return pending?[{pending,activation:scope?.controlStack.at(-1)?.activation??lane.activation,
      groups,lane}]:[];
  });
}

export function laneRequestIds(lane) {
  return [...(lane.requestIds??[]),...(lane.scope?.parallel?.lanes.flatMap(laneRequestIds)??[])];
}

export function groupOwnsCompensation(group,requestId) {
  if (!group) return false;
  return group.lanes.some(lane=>
    group.strategy==='any' && group.effectMode==='compensate' && group.decision &&
      lane.nodeId!==group.decision.winner && laneRequestIds(lane).includes(requestId)
    || groupOwnsCompensation(lane.scope?.parallel,requestId));
}

export function isHumanProof(proof) {
  return !!proof && typeof proof==='object' && (Object.keys(proof).length===3
    || Object.keys(proof).length===5 && /^sha256:[a-f0-9]{64}$/.test(proof.bundleHash)
    && ['approve','revise','decline'].includes(proof.decision))
    && [proof.subjectId,proof.proofId].every(value=>typeof value==='string' && value.length>0 && value.length<=256)
    && typeof proof.evidenceHash==='string' && /^sha256:[a-f0-9]{64}$/.test(proof.evidenceHash);
}
