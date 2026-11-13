import {MAX_CHECKPOINT_BYTES,assertSHA256,canonicalBytes,sha256Bytes} from './canonical.mjs';

const finished=new Set(['succeeded','failed','errored','cancelled']);
const phases=new Set(['enter','prepare','dispatch-ready','awaiting','validate','commit','route','finished']);
const hash=value=>sha256Bytes(canonicalBytes(value));
const invalid=()=>Object.assign(new Error('FK_I_INVALID_CHECKPOINT: invalid R5 checkpoint'),{code:'FK_I_INVALID_CHECKPOINT'});
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const text=value=>typeof value==='string' && value.length>0;
const count=value=>Number.isSafeInteger(value) && value>=0;
const keys=(value,required,optional=[])=>object(value) && required.every(key=>Object.hasOwn(value,key))
  && Object.keys(value).every(key=>required.includes(key)||optional.includes(key));

export function checkpointPolicy(policy,policyHash) {
  return {
    id:policy.id??'flowkit-host',version:policy.version??'1',policyHash,
    bindingManifestHash:hash(policy.bindingManifest??{}),
    ...(policy.skillManifestHash ? {skillManifestHash:policy.skillManifestHash} : {}),
  };
}

function pendingFromExecution(cp) {
  const task=cp.pending??cp.prepared;
  if (!task) return [];
  const {requestId,nodeId,kind,attempt,name,instruction,input,missing,resultSchema,reasons,overview}=task;
  const publicTask={name,instruction,input,missing,resultSchema,reasons,...(overview?{overview}:{})};
  return [{requestId,nodeId,kind,attempt,name,activation:cp.controlStack.at(-1).activation,
    issuedRevision:task.issuedRevision??cp.revision,intent:'execute',internalPayload:{},publicTask}];
}

/** The Coordinator's execution view is transient. Stores serialize this R5 envelope. */
export function encodeCheckpoint(cp) {
  const phase=finished.has(cp.status)?'finished':cp.phase;
  const {namespace,runId,startKey,startIntentHash,revision,status,program,policyIdentity,state}=cp;
  const receivedSubmission=phase==='validate' ? cp.receivedSubmission : null;
  const candidate=cp.candidate?.submissionKind==='agent-result' && object(cp.candidate.result)
    ? {kind:'agent',requestId:cp.candidate.requestId,result:cp.candidate.result} : null;
  const causeCode=cp.terminal?.causeCode ?? (
    cp.pauseReason==='skill-temporary'?'FK_I_TEMPORARY_SKILL':undefined);
  return {
    schemaVersion:1,protocolVersion:1,namespace,runId,startKey,startIntentHash,revision,status,program,
    programRef:{namespace,artifactHash:program.artifactHash,programId:program.workflowId},
    policyIdentity,
    execution:{blockId:cp.blockId,phase,activationSeq:cp.activationSeq,agentStepCounter:cp.activationSeq,
      controlStack:phase==='finished'?[]:cp.controlStack,contextError:cp.contextError??null},
    state,candidate,receivedSubmission,pending:pendingFromExecution(cp),inFlightOperations:[],
    terminal:status==='succeeded'||status==='failed'?cp.terminal:null,
    lastTransitionId:cp.lastTransitionId??null,
    limits:{stageCount:cp.stageCount??0,receiptCount:cp.receiptCount??0,bytes:MAX_CHECKPOINT_BYTES},
    ...(causeCode?{causeCode}:{}),
  };
}

export function decodeCheckpoint(cp) {
  if (!keys(cp,['schemaVersion','protocolVersion','namespace','runId','startKey','startIntentHash',
    'revision','status','program','programRef','policyIdentity','execution','state','candidate',
    'receivedSubmission','pending','inFlightOperations','terminal','lastTransitionId','limits'],['causeCode'])
    || cp.schemaVersion!==1 || cp.protocolVersion!==1
    || ![cp.namespace,cp.runId,cp.startKey].every(text) || !count(cp.revision) || !object(cp.state)
    || !keys(cp.programRef,['namespace','artifactHash','programId'])
    || !keys(cp.program,['artifactHash','sourceHash','workflowId','workflowVersion','compilerVersion','programAbiVersion',
      'semanticsVersion','checkpointSchemaVersion','canonicalizationVersion','implementedStage'])
    || ![cp.program.workflowId,cp.program.workflowVersion,cp.program.compilerVersion].every(text)
    || cp.program.programAbiVersion!==1 || cp.program.checkpointSchemaVersion!==1
    || cp.program.semanticsVersion!=='interactive-state-machine-v1' || cp.program.implementedStage!=='P0-A'
    || cp.program.canonicalizationVersion!=='jcs-rfc8785-v1' || cp.programRef.namespace!==cp.namespace
    || cp.programRef.artifactHash!==cp.program.artifactHash || cp.programRef.programId!==cp.program.workflowId
    || !keys(cp.policyIdentity,['id','version','policyHash','bindingManifestHash'],['skillManifestHash'])
    || ![cp.policyIdentity.id,cp.policyIdentity.version].every(text)
    || !keys(cp.execution,['blockId','phase','activationSeq','agentStepCounter','controlStack','contextError'])
    || !text(cp.execution.blockId) || !phases.has(cp.execution.phase)
    || !count(cp.execution.activationSeq) || cp.execution.agentStepCounter!==cp.execution.activationSeq
    || !Array.isArray(cp.execution.controlStack)
    || !keys(cp.limits,['stageCount','receiptCount','bytes'])
    || !count(cp.limits.stageCount) || !count(cp.limits.receiptCount)
    || cp.limits.stageCount>cp.revision || cp.limits.receiptCount>cp.revision
    || cp.limits.bytes!==MAX_CHECKPOINT_BYTES
    || !Array.isArray(cp.pending) || cp.pending.length>1
    || !Array.isArray(cp.inFlightOperations) || cp.inFlightOperations.length) throw invalid();

  const {namespace,runId,startKey,startIntentHash,revision,status,program,policyIdentity,execution,state,
    receivedSubmission,lastTransitionId}=cp;
  const {phase,blockId,controlStack,activationSeq,contextError}=execution;
  const hasPending=status==='waiting'||phase==='dispatch-ready';
  if ((!finished.has(status) && !['waiting','paused','running'].includes(status))
    || (phase==='finished')!==finished.has(status) || (phase==='awaiting')!==(status==='waiting')
    || (cp.pending.length===1)!==hasPending || (phase==='validate')!==(receivedSubmission!==null)
    || (phase!=='finished' && !blockId.endsWith('::'+phase))
    || (cp.terminal!==null)!==['succeeded','failed'].includes(status)
    || (cp.terminal!==null && (!keys(cp.terminal,['status','nodeId']) || cp.terminal.status!==status
      || !text(cp.terminal.nodeId)))) throw invalid();

  for (const digest of [startIntentHash,program.sourceHash,program.artifactHash,policyIdentity.policyHash,
    policyIdentity.bindingManifestHash,...(policyIdentity.skillManifestHash?[policyIdentity.skillManifestHash]:[]),
    ...(lastTransitionId===null?[]:[lastTransitionId])]) assertSHA256(digest);
  let pending=null;
  if (hasPending) {
    const task=cp.pending[0];
    if (!keys(task,['requestId','nodeId','kind','activation','attempt','issuedRevision','intent','name','internalPayload','publicTask'])
      || ![task.requestId,task.nodeId,task.name].every(text) || task.kind!=='agent' || task.intent!=='execute'
      || !count(task.issuedRevision) || task.issuedRevision>revision
      || task.activation!==controlStack.at(-1)?.activation || task.attempt!==controlStack.at(-1)?.attempt
      || task.nodeId!==controlStack.at(-1)?.nodeId || !object(task.internalPayload)
      || !object(task.publicTask) || task.publicTask.name!==task.name) throw invalid();
    pending={...task.publicTask,kind:'agent',id:task.nodeId,nodeId:task.nodeId,runId,requestId:task.requestId,
      attempt:task.attempt,issuedRevision:task.issuedRevision};
  }
  let candidate=null;
  if (phase==='validate') {
    const accepted=receivedSubmission;
    const frame=controlStack.at(-1);
    if (!keys(accepted,['requestId','kind','activation','attempt','canonicalDigest','acceptedRevision','payload','receivedAt'])
      || !text(accepted.requestId) || !text(accepted.receivedAt) || accepted.kind!=='agent'
      || accepted.activation!==frame?.activation || accepted.attempt!==frame?.attempt
      || accepted.acceptedRevision!==revision || !object(accepted.payload)) throw invalid();
    assertSHA256(accepted.canonicalDigest);
    const payload=accepted.payload;
    const succeeded=payload.kind==='agent-result' || (payload.kind==='agent' && payload.outcome==='succeeded');
    const failed=payload.kind==='agent-call-failed' || (payload.kind==='agent' && payload.outcome==='failed');
    if ((!succeeded && !failed) || hash(payload)!==accepted.canonicalDigest
      || payload.runId!==runId || payload.requestId!==accepted.requestId
      || (payload.nodeId!==undefined && payload.nodeId!==frame.nodeId)
      || (payload.attempt!==undefined && payload.attempt!==frame.attempt)
      || (succeeded && !Object.hasOwn(payload,'result'))
      || (failed && !text((payload.failure??payload.error)?.message))
      || (cp.candidate!==null)!==(succeeded && object(payload.result))
      || (cp.candidate && (!keys(cp.candidate,['kind','requestId','result']) || cp.candidate.kind!=='agent'
        || cp.candidate.requestId!==accepted.requestId
        || hash(cp.candidate.result)!==hash(payload.result)))) throw invalid();
    candidate={kind:'agent',requestId:accepted.requestId,nodeId:frame.nodeId,attempt:accepted.attempt,
      submissionKind:succeeded?'agent-result':'agent-call-failed',validated:false,
      ...(succeeded?{result:payload.result}:{failure:{message:(payload.failure??payload.error).message}})};
  } else if (phase==='commit') {
    if (!keys(cp.candidate,['kind','requestId','result']) || cp.candidate.kind!=='agent'
      || !text(cp.candidate.requestId) || !object(cp.candidate.result)) throw invalid();
    const frame=controlStack.at(-1);
    candidate={...cp.candidate,nodeId:frame?.nodeId,attempt:frame?.attempt,submissionKind:'agent-result',validated:true};
  } else if (cp.candidate!==null) throw invalid();

  return {schemaVersion:1,namespace,runId,startKey,startIntentHash,revision,status,state,program,policyIdentity,
    artifactHash:program.artifactHash,policyHash:policyIdentity.policyHash,blockId,
    phase:phase==='finished'?blockId.slice(blockId.lastIndexOf('::')+2):phase,controlStack,activationSeq,contextError,
    candidate,receivedSubmission,lastTransitionId,stageCount:cp.limits.stageCount,receiptCount:cp.limits.receiptCount,
    pending:phase==='awaiting'?pending:null,prepared:phase==='dispatch-ready'?pending:null,
    terminal:status==='errored'?{status,nodeId:blockId.slice(0,blockId.lastIndexOf('::')),causeCode:cp.causeCode}:cp.terminal,
    ...(status==='paused'?{pauseReason:cp.causeCode==='FK_I_TEMPORARY_SKILL'?'skill-temporary':'stage-budget'}:{})};
}
