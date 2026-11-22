// Shared by the compiler and the detached Host storage worker.
export const isInteractiveStage = stage => stage === 'P0-A' || stage === 'P0-B';
export const hasStepFrame = kind => kind === 'agent' || kind === 'action' || kind === 'verification';
