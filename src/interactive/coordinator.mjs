import {randomUUID} from 'node:crypto';
import {MAX_INLINE_AGENT_RESULT_BYTES, canonicalBytes, safeJSONSnapshot, sha256Bytes, assertSHA256} from './canonical.mjs';
import {loadInteractiveProgram} from './load.mjs';
import {checkpointPolicy} from './checkpoint.mjs';
import {stepFrameRule} from '../compiler/interactive/validate-ir.mjs';
import {hasStepFrame,isHumanProof,publishedInteractivePending,runDeadlineExpired,interactiveModeForStage,
  parallelPendingEntries,laneRequestIds} from './protocol.mjs';
import {createBudget, during, prepareTaskV2} from '../runtime/tasks.mjs';
import {createDescriptionResources} from '../runtime/task-resources.mjs';

const FINISHED = new Set(['succeeded','failed','errored','cancelled']);
const MAX_REASONS = 32;
const MAX_REASON_LENGTH = 512;
const PROPOSAL_COMMON = ['kind','fromBlockId','nodeId','stackEffect','mergeIntent'];
const PROPOSAL_TARGET = [...PROPOSAL_COMMON,'toBlockId'];
const STACK_FIELDS = {
  none:['kind'],
  push:['kind','frame'],
  pop:['kind','expectedKind','expectedNodeId'],
  update:['kind','expectedKind','expectedNodeId','field','value'],
};

function hasFields(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(field=>Object.hasOwn(value,field))
    && Reflect.ownKeys(value).every(field=>required.includes(field)||optional.includes(field));
}

function failure(code, message) {
  return Object.assign(new Error(code + ': ' + message), {code});
}
function nonempty(value, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Invalid ' + field);
  return value;
}
function fingerprint(value) { return sha256Bytes(canonicalBytes(value)); }
function copy(value) { return safeJSONSnapshot(value); }
function validStageCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) {
    throw new RangeError('maxStagesPerCall must be in [1, 128]');
  }
  return value;
}
function internalEvent(cp, kind, extra = {}) {
  const payload = {
    schemaVersion:1, forBlockId:cp.blockId, kind,
    ...extra,
  };
  const eventDigest = fingerprint([cp.runId,cp.revision,payload]);
  return Object.freeze({...payload,eventDigest,eventId:'e:' + eventDigest.slice(7)});
}
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function programView(cp) {
  return freezeDeep(copy({
    schemaVersion:1,namespace:cp.namespace,runId:cp.runId,revision:cp.revision,
    blockId:cp.blockId,phase:cp.phase,state:cp.state,
    controlStack:cp.controlStack,candidate:cp.candidate ?? null,
  }));
}
function confirmCurrentBlock(cp, program) {
  const block = program.programTable.blocks.find(item=>item.id===cp.blockId);
  if (!block || block.phase !== cp.phase || !program.programTable.nodes[block.nodeId]) {
    throw failure('FK_I_INVALID_CHECKPOINT','block does not belong to immutable Program');
  }
  const record = program.programTable.nodes[block.nodeId];
  if (cp.parallel && (record.kind!=='parallel' || cp.parallel.nodeId!==block.nodeId
    || cp.parallel.strategy!==record.metadata.strategy
    || cp.parallel.lanes.length!==record.metadata.branches.length
    || cp.parallel.lanes.some((lane,index)=>lane.nodeId!==record.metadata.branches[index]))) {
    throw failure('FK_I_INVALID_CHECKPOINT','Parallel lanes differ from the immutable Program');
  }
  const frames = cp.controlStack;
  if (!Array.isArray(frames) || frames.length > 1 || frames.some(x=>x.kind!==record.kind)) {
    throw failure('FK_I_INVALID_CHECKPOINT','illegal step control stack');
  }
  if (hasStepFrame(record.kind) && cp.phase !== 'enter') {
    const frame = frames.at(-1);
    if (!frame || frame.nodeId !== block.nodeId || !Number.isSafeInteger(frame.activation)
      || frame.activation < 1 || !Number.isSafeInteger(frame.attempt)
      || frame.attempt < 1 || frame.attempt > (record.metadata.retries??0) + 1
      || !Array.isArray(frame.reasons)) {
      throw failure('FK_I_INVALID_CHECKPOINT','invalid current Agent frame');
    }
  }
  if (cp.status === 'waiting') {
    if (!cp.parallel && (cp.phase !== 'awaiting' || cp.pending?.requestId == null
      || cp.pending.kind!==record.kind || cp.candidate != null)) {
      throw failure('FK_I_INVALID_CHECKPOINT','waiting without certified pending request');
    }
    if (cp.pending?.preparedTask && (!cp.taskContext?.active ||
      fingerprint(cp.pending.preparedTask) !== fingerprint(cp.taskContext.active.prepared) ||
      cp.pending.preparedTask.task.execution.requestId !== cp.pending.requestId ||
      cp.pending.preparedTask.task.run.runId !== cp.runId || cp.pending.preparedTask.task.workflow.artifactHash !== cp.artifactHash)) {
      throw failure('FK_I_INVALID_CHECKPOINT','Pending Task V2 differs from its persisted preparation');
    }
  } else if (cp.phase === 'awaiting' && !FINISHED.has(cp.status)) {
    throw failure('FK_I_INVALID_CHECKPOINT','awaiting must be a published waiting state');
  }
  if (cp.candidate != null && cp.phase !== 'validate' && cp.phase !== 'commit') {
    throw failure('FK_I_INVALID_CHECKPOINT','candidate outside validation or commit phase');
  }
  if (cp.prepared != null && cp.phase !== 'dispatch-ready') {
    throw failure('FK_I_INVALID_CHECKPOINT','prepared request outside dispatch-ready phase');
  }
  if (!Number.isSafeInteger(cp.activationSeq) || cp.activationSeq < 0) {
    throw failure('FK_I_INVALID_CHECKPOINT','invalid activation counter');
  }
  return {block,record};
}
/** Internal runtime validation of the current P0-A proposal contract. */
export function validateProposalFields(rawProposal, block, record) {
  let proposal;
  try { proposal=copy(rawProposal); }
  catch { throw failure('FK_I_INVALID_TRANSITION','Program proposal is not canonical data'); }
  if (!proposal || !block.proposalKinds.includes(proposal.kind)) {
    throw failure('FK_I_INVALID_TRANSITION','Program returned uncertified proposal kind');
  }
  if (proposal.kind === 'terminal') {
    const status=record.kind==='parallel'?'failed':record.metadata.status;
    if (!hasFields(proposal,[...PROPOSAL_COMMON,'terminal'])
      || !hasFields(proposal.terminal,['status','nodeId'])
      || proposal.terminal.nodeId!==block.nodeId
      || proposal.terminal.status!==status) {
      throw failure('FK_I_INVALID_TRANSITION','invalid terminal proposal fields');
    }
  } else if (proposal.kind === 'raise-error') {
    if (!hasFields(proposal,[...PROPOSAL_COMMON,'causeCode'],['diagnosticCode'])
      || typeof proposal.causeCode!=='string' || !proposal.causeCode.length
      || (Object.hasOwn(proposal,'diagnosticCode') && typeof proposal.diagnosticCode!=='string')) {
      throw failure('FK_I_INVALID_TRANSITION','invalid error proposal fields');
    }
  } else if (!hasFields(proposal,PROPOSAL_TARGET,['requestId'])
    || (Object.hasOwn(proposal,'requestId') && typeof proposal.requestId!=='string')
    || !block.legalTargets.includes(proposal.toBlockId)) {
    throw failure('FK_I_INVALID_TRANSITION','Program target not in legalTargets');
  }
  if ((proposal.kind==='retry-agent' && proposal.toBlockId!==block.nodeId+'::prepare')
    || (proposal.kind==='commit-candidate' && proposal.toBlockId!==block.nodeId+'::commit')) {
    throw failure('FK_I_INVALID_TRANSITION','proposal kind does not match its successor phase');
  }
  const {stackEffect,mergeIntent}=proposal;
  const stackKind=stackEffect?.kind;
  let expectedStack='none';
  if (proposal.kind==='retry-agent') expectedStack='update';
  if (proposal.kind==='move' && hasStepFrame(record.kind)) {
    if (block.phase==='enter') expectedStack='push';
    if (block.phase==='route') expectedStack='pop';
  }
  if (proposal.kind==='apply-external') expectedStack='pop';
  if (stackKind!==expectedStack || !hasFields(stackEffect,STACK_FIELDS[expectedStack])
    || (stackKind==='push' && !hasFields(stackEffect.frame,stepFrameRule(block.nodeId,record.kind).fields))) {
    throw failure('FK_I_INVALID_TRANSITION','invalid control stack effect');
  }
  const commits=proposal.kind==='commit-state';
  if (!hasFields(mergeIntent,commits?['kind','requestId']:['kind'])
    || mergeIntent.kind!==(commits?'commit-candidate':'none')
    || (commits && typeof mergeIntent.requestId!=='string')) {
    throw failure('FK_I_INVALID_TRANSITION','invalid merge intent');
  }
  return proposal;
}
function certifiedProposal(cp, program, event, rawProposal) {
  const {block,record} = confirmCurrentBlock(cp,program);
  const proposal=validateProposalFields(rawProposal,block,record);
  if (!block.eventKinds.includes(event.kind)
    || proposal.fromBlockId !== cp.blockId || proposal.nodeId !== block.nodeId) {
    throw failure('FK_I_INVALID_TRANSITION','Program returned uncertified proposal');
  }
  if (record.kind==='parallel' && proposal.kind==='terminal' && event.kind!=='parallel-rejected') {
    throw failure('FK_I_INVALID_TRANSITION','Parallel failure requires a rejected branch');
  }
  if (proposal.stackEffect.kind==='push') {
    const {frame}=proposal.stackEffect;
    if (frame.kind!==record.kind || frame.nodeId!==block.nodeId || frame.phase!=='prepare'
      || frame.attempt!==stepFrameRule(block.nodeId,record.kind).initialAttempt
      || frame.activation!==event.activation || frame.overviewStep!==(event.overviewStep??event.activation)
      || !Array.isArray(frame.reasons) || frame.reasons.length) {
      throw failure('FK_I_INVALID_TRANSITION','invalid initial Agent frame');
    }
  }
  return proposal;
}
function applyStack(cp, effect) {
  const frames = copy(cp.controlStack);
  if (effect.kind === 'none') return frames;
  if (effect.kind === 'push') {
    if (frames.length || !hasStepFrame(effect.frame?.kind)
      || effect.frame.nodeId !== cp.blockId.split('::')[0]) {
      throw failure('FK_I_INVALID_TRANSITION','illegal Agent frame push');
    }
    frames.push(copy(effect.frame));
  } else if (effect.kind === 'pop') {
    if (frames.length !== 1
      || frames[0].kind !== effect.expectedKind
      || frames[0].nodeId !== effect.expectedNodeId) {
      throw failure('FK_I_INVALID_TRANSITION','illegal Agent frame pop');
    }
    frames.pop();
  } else if (effect.kind === 'update') {
    if (frames.length !== 1 || frames[0].kind !== effect.expectedKind
      || frames[0].nodeId !== effect.expectedNodeId || effect.field !== 'attempt'
      || effect.value !== frames[0].attempt + 1) {
      throw failure('FK_I_INVALID_TRANSITION','illegal Agent frame update');
    }
    frames[0].attempt = effect.value;
    frames[0].reasons = [];
  }
  return frames;
}
function asPublicFrame(cp) {
  const {issuedRevision:_issuedRevision,...publicPending}=cp.pending??{};
  return copy({
    namespace:cp.namespace,runId:cp.runId,status:cp.status,revision:cp.revision,
    ...(FINISHED.has(cp.status) ? {state:cp.state} : {}),
    ...(cp.status === 'waiting' && !cp.parallel ? {pending:publicPending} : {}),
    ...(cp.cancelledRequests?.length?{cancelledRequests:cp.cancelledRequests}:{}),
    ...(cp.status === 'paused' ? {pauseReason:cp.pauseReason ?? 'stage-budget'} : {}),
    ...(FINISHED.has(cp.status) ? {terminal:cp.terminal ?? null} : {}),
  });
}
function inputForAgent(state, fields) {
  const input = Object.create(null);
  const missing=[];
  for (const key of fields) {
    if (Object.hasOwn(state,key)) Object.defineProperty(input,key,{
      value:state[key],enumerable:true,writable:true,configurable:true,
    });
    else missing.push(key);
  }
  return {input,missing};
}
function reasonsFromValidation(value) {
  // Snapshot *before* array inspection: reject sparse arrays, proxies, getters,
  // cycles and post-return mutation instead of accepting holes as undefined.
  value = copy(value);
  if (!Array.isArray(value) || value.length > MAX_REASONS
    || value.some(v => typeof v !== 'string' || !v.length || v.length > MAX_REASON_LENGTH)) {
    throw failure('FK_I_VALIDATOR_CONTRACT','validateResult must return bounded string[]');
  }
  return [...value];
}
function assertRuntime(program,runtime) {
  if (typeof runtime !== 'object' || !runtime || Array.isArray(runtime)) {
    throw new TypeError('InteractiveRuntime must be an object');
  }
  // A Host may expose shared Standard runtime callbacks. Ignore an unused
  // checkStep only when the verified Program has no Agent/validation bindings.
  // Agent P0-A still fails closed: we must not silently skip its checkStep.
  if (program.interactiveProgram.identity.implementedStage==='P0-A' && runtime.checkStep !== undefined
    && program.programTable.requiredBindings.length > 0) {
    throw failure('FK_I_UNSUPPORTED_GRAPH','P0-A cannot silently skip Agent checkStep');
  }
  for (const binding of program.programTable.requiredBindings) {
    if (binding.id === 'runtime.validateResult' && typeof runtime.validateResult !== 'function'
      || binding.id === 'runtime.skillResolver' && typeof runtime.skillResolver !== 'function'
      || binding.id === 'runtime.authorizeAgentTask' && typeof runtime.authorizeAgentTask !== 'function'
      || binding.id === 'runtime.verifyAgentResult' && typeof runtime.verifyAgentResult !== 'function') {
      throw failure('FK_I_BINDING_MISSING','Required Interactive binding ' + binding.id);
    }
  }
}
function initialCheckpoint(namespace, runId, program, policyIdentity, state) {
  let snapshot;
  try { snapshot=copy(state); }
  catch(error) {
    if (error instanceof RangeError && /Canonical JSON exceeds maximum bytes/.test(error.message)) {
      throw failure('FK_I_CHECKPOINT_CAPACITY', 'initial State exceeds Checkpoint hard limit');
    }
    throw error;
  }
  return {
    schemaVersion:1,namespace,runId,revision:0,
    artifactHash:program.artifactHash,program:{...program.interactiveProgram.identity,artifactHash:program.artifactHash},
    policyHash:policyIdentity.policyHash,policyIdentity,status:'running',
    blockId:program.programTable.entryBlockId,
    phase:'enter',state:snapshot,
    controlStack:[],activationSeq:0,agentStepCounter:0,stageCount:0,receiptCount:0,lastTransitionId:null,
    pending:null,prepared:null,candidate:null,terminal:null,
    contextError:null,receivedSubmission:null,
  };
}

/**
 * P0-A host-owned Coordinator. The immutable generated JS Program is the
 * authority for routing, frame effects and stage proposals. No runAgent,
 * network write, or unverified external event is executed by this component.
 *
 * Only the trusted Host may call start/complete/resume and provide bindings.
 * Host identity/provenance adapters are added in M5, NOT simulated here.
 */
export function createInteractiveCoordinator(options) {
  return buildCoordinator(options, false);
}

export function buildCoordinator({store, runtime, policy = {}, maxStagesPerCall = 128, signal} = {}, versioned) {
  if (!store || typeof store.load !== 'function'
    || typeof store.createRun !== 'function'
    || typeof store.compareAndSwap !== 'function'
    || typeof store.putArtifact !== 'function'
    || typeof store.getArtifact !== 'function' || typeof store.getReceipt !== 'function') {
    throw new TypeError('A CheckpointStore with atomic CAS and artifact retention is required');
  }
  nonempty(store.namespace,'store.namespace');
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new TypeError('InteractiveRuntime object required');
  }
  const execution = Object.freeze({
    validateResult:runtime.validateResult,
    skillResolver:runtime.skillResolver,
    checkStep:runtime.checkStep,
    verifyAgentResult:runtime.verifyAgentResult,
    prepareAgentTask:runtime.prepareAgentTask,
    authorizeAgentTask:runtime.authorizeAgentTask,
    taskResourcePolicy:runtime.taskResourcePolicy,
  });
  const policySnapshot = copy(policy);
  const policyHash = fingerprint(policySnapshot);
  const policyIdentity=checkpointPolicy(policySnapshot,policyHash);
  const stageBudget = validStageCount(maxStagesPerCall);
  // Only verified immutable Program objects are cached, never Store records.
  // Even on a cache hit every stage re-reads the Host's Store, checks exact
  // Program bytes and identity, then verifies the current Run phase/policy.
  // Small fixed LRU avoids a broad, implicit process-global cache.
  const verifiedPrograms = new Map();
  const MAX_VERIFIED_PROGRAMS = 4;
  function checkSignal() { signal?.throwIfAborted(); }

  async function loadPinned(cp) {
    if (cp.namespace !== store.namespace || cp.policyHash !== policyHash) {
      throw failure('FK_I_POLICY_MISMATCH','Run policy and namespace must match');
    }
    if (!versioned && cp.program.implementedStage!=='P0-A') {
      throw failure('FK_I_UNSUPPORTED_GRAPH','This Program requires the authorized Interactive Host API');
    }
    assertSHA256(cp.artifactHash);
    const saved = versioned ? await store.getArtifact(cp.artifactHash) : store.getArtifact(cp.artifactHash);
    if (!saved || saved.programIdentity?.artifactHash !== cp.artifactHash
      || !(saved.bytes instanceof Uint8Array)
      || sha256Bytes(saved.bytes) !== cp.artifactHash) {
      throw failure('FK_I_PROGRAM_MISMATCH','Missing or modified compiler Program bytes');
    }
    const identityBytes=canonicalBytes(saved.programIdentity);
    const cached=verifiedPrograms.get(cp.artifactHash);
    let program;
    if (cached && cached.identityBytes.equals(identityBytes)) {
      program=cached.program;
      // Update LRU order; no change to the frozen Program or Store.
      verifiedPrograms.delete(cp.artifactHash);
      verifiedPrograms.set(cp.artifactHash,cached);
    } else {
      // Never trust stale cached ABI/identity after a Store metadata change.
      program=await loadInteractiveProgram(saved.bytes,cp.artifactHash);
      const declared={...program.interactiveProgram.identity,artifactHash:cp.artifactHash};
      if (!canonicalBytes(declared).equals(identityBytes)) {
        throw failure('FK_I_PROGRAM_MISMATCH','Stored Program manifest mismatch');
      }
      verifiedPrograms.delete(cp.artifactHash);
      verifiedPrograms.set(cp.artifactHash,{program,identityBytes});
      if (verifiedPrograms.size>MAX_VERIFIED_PROGRAMS) {
        verifiedPrograms.delete(verifiedPrograms.keys().next().value);
      }
    }
    assertRuntime(program,execution);
    const activeTasks=cp.parallel
      ? publishedInteractivePending(cp).flatMap(task=>task.preparedTask?[task.preparedTask]:[])
      : cp.taskContext?.active?[cp.taskContext.active.prepared]:[];
    const p2WithoutDispatch=cp.program.implementedStage==='P2' && !activeTasks.length
      && (!cp.parallel || cp.parallel.decision);
    const mustCloseExpiredParallel=cp.parallel && (cp.parallel.decision?.deadline
      || !cp.parallel.decision && cp.taskContext?.deadlineMs<=Date.now());
    if (!FINISHED.has(cp.status) && cp.taskContext && !runDeadlineExpired(cp) && !p2WithoutDispatch && !mustCloseExpiredParallel) {
      const budget = createBudget(policySnapshot.taskPolicy ?? {}, signal, cp.taskContext);
      budget.check();
      const expires = AbortSignal.timeout(Math.max(1, Math.min(2147483647,budget.deadlineMs-Date.now())));
      const currentSignal = signal ? AbortSignal.any([signal,expires]) : expires;
      for (const task of activeTasks) {
        if (await during(currentSignal,()=>execution.authorizeAgentTask(
          freezeDeep(copy(task)),{runId:cp.runId,signal:currentSignal,deadlineMs:budget.deadlineMs}))!==true) {
          throw failure('FK_I_HOST_DENIED','Pinned task resources are no longer authorized');
        }
      }
      budget.check();
    }
    if (!FINISHED.has(cp.status)) confirmCurrentBlock(cp,program);
    return program;
  }

  function advanceSafely(cp, program, event) {
    try {
      const proposal = program.advance(programView(cp),event);
      return {event,proposal:certifiedProposal(cp,program,event,proposal)};
    } catch(error) {
      if (error?.code === 'FK_R002') {
        const rejected=internalEvent(cp,'deterministic-failure',{error:{code:'FK_R002'}});
        return {event:rejected,proposal:certifiedProposal(cp,program,rejected,program.advance(programView(cp),rejected))};
      }
      throw error;
    }
  }
  async function writeTransition(cp,args,event,proposal,receiptOutcome) {
    checkSignal();
    const eventDigest=event.eventDigest ?? fingerprint(event);
    const proposalDigest=fingerprint(proposal);
    const transitionId=fingerprint([cp.namespace,cp.runId,cp.revision,cp.blockId,
      eventDigest,cp.artifactHash,proposalDigest]);
    const transition={
      namespace:cp.namespace,runId:cp.runId,transitionId,
      fromRevision:cp.revision,toRevision:args.nextCheckpoint.revision,
      fromBlockId:cp.blockId,toBlockId:FINISHED.has(args.nextCheckpoint.status)?null:args.nextCheckpoint.blockId,
      programHash:cp.artifactHash,eventDigest,proposalDigest,committedAt:new Date().toISOString(),
    };
    return store.compareAndSwap({...args,transitionId,nextCheckpoint:{...args.nextCheckpoint,lastTransitionId:transitionId},journalEntry:{
      ...args.journalEntry,transition,...(receiptOutcome ? {receiptOutcome} : {}),
    }});
  }
  async function failRun(cp,causeCode,kind) {
    if (FINISHED.has(cp.status)) return {committed:false,checkpoint:cp};
    const nodeId=cp.blockId.slice(0,cp.blockId.lastIndexOf('::'));
    const next={
      ...cp,revision:cp.revision+1,status:'errored',
      terminal:{status:'errored',nodeId,causeCode},
      pending:null,prepared:null,candidate:null,receivedSubmission:null,
      pauseReason:null,parallel:null,
      cancelledRequests:[...new Set([...(cp.cancelledRequests??[]),
        ...publishedInteractivePending(cp).map(task=>task.requestId)])],
    };
    // This terminal transition may use the Store's reserved 256 KiB; it
    // never drops State or accepted receipt identities.
    return writeTransition(cp,{
      runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:{kind,causeCode,from:cp.blockId},
    },{kind},{kind,causeCode});
  }
  async function casOrCapacityExit(cp, args, event, proposal, receiptOutcome) {
    try { return await writeTransition(cp,args,event,proposal,receiptOutcome); }
    catch(error) {
      if (error?.code==='FK_I_RUN_DEADLINE') return {committed:false,checkpoint:cp};
      if (error?.code!=='FK_I_CHECKPOINT_CAPACITY') throw error;
      const terminal=await failRun(cp,'FK_I_CHECKPOINT_CAPACITY','capacity-terminal');
      return {...terminal,capacityExit:terminal.committed};
    }
  }
  function oversizedInline(value) {
    try { canonicalBytes(value,MAX_INLINE_AGENT_RESULT_BYTES);return false; }
    catch(error) {
      if (error instanceof RangeError && /Canonical JSON exceeds maximum bytes/.test(error.message)) {
        return true;
      }
      throw error;
    }
  }

  function stepCheckpoint(cp,proposal,extras) {
    const next = {...cp,revision:cp.revision+1,stageCount:cp.stageCount+1,receivedSubmission:null,pauseReason:null};
    if (proposal.kind === 'raise-error') {
      next.status='errored';
      next.terminal={status:'errored',nodeId:proposal.nodeId,causeCode:proposal.causeCode};
      next.pending=null;next.prepared=null;next.candidate=null;
    } else if (proposal.kind === 'terminal') {
      next.status=proposal.terminal.status;
      next.terminal=copy(proposal.terminal);
      next.pending=null;next.prepared=null;next.candidate=null;
    } else {
      next.blockId=proposal.toBlockId;
      next.phase=proposal.toBlockId.slice(proposal.toBlockId.lastIndexOf('::')+2);
      next.controlStack=applyStack(cp,proposal.stackEffect);
      next.status=proposal.kind === 'publish-pending' ? 'waiting' : 'running';
    }
    if (proposal.kind === 'publish-pending') {
      if (cp.prepared == null) throw failure('FK_I_INVALID_CHECKPOINT','publish without prepared request');
      next.pending={...cp.prepared,issuedRevision:next.revision};next.prepared=null;
    }
    if (proposal.kind === 'commit-state') {
      if (proposal.mergeIntent.kind !== 'commit-candidate'
        || cp.candidate?.requestId !== proposal.mergeIntent.requestId
        || cp.candidate?.validated !== true
        || cp.candidate.kind !== 'agent'
        || !cp.candidate.result || typeof cp.candidate.result !== 'object'
        || Array.isArray(cp.candidate.result)) {
        throw failure('FK_I_INVALID_TRANSITION','commit requires verified object candidate');
      }
      next.state=copy({...cp.state,...cp.candidate.result});
      next.candidate=null;
    }
    if (proposal.kind === 'retry-agent') {
      next.candidate=null;next.pending=null;next.prepared=null;
      if (extras?.retryReasons) next.controlStack[0].reasons=copy(extras.retryReasons);
    }
    if (proposal.kind === 'commit-candidate') {
      if (cp.candidate?.kind !== 'agent') throw failure('FK_I_INVALID_CHECKPOINT','no Agent candidate');
      next.candidate={...cp.candidate,validated:true};
    }
    if (extras.patch) {
      next.state=copy({...cp.state,...extras.patch.set});
      for (const key of extras.patch.remove??[]) delete next.state[key];
    }
    if (cp.unavailableParallelKeys?.length || extras.unavailableParallelKeys?.length) {
      next.unavailableParallelKeys=[...new Set([...(cp.unavailableParallelKeys??[]),...(extras.unavailableParallelKeys??[])])]
        .filter(key=>!Object.hasOwn(next.state,key)).sort();
    }
    if (extras.counter) {
      const {id,count}=extras.counter;
      next.regionCounters={...cp.regionCounters,[id]:count};
      if (count===0) delete next.regionCounters[id];
    }
    if (proposal.kind==='apply-external') next.candidate=null;
    if (proposal.kind==='begin-parallel') {
      next.parallel=extras.parallel;
      next.activationSeq=extras.activationSeq;
      next.agentStepCounter=extras.agentStepCounter;
      if (cp.taskContext?.active) {
        const {active,...budget}=cp.taskContext;
        next.taskContext=budget;
      }
    }
    if (proposal.kind==='finish-parallel' || FINISHED.has(next.status)) next.parallel=null;
    if (Object.hasOwn(extras,'contextError')) next.contextError=extras.contextError;
    if (proposal.kind === 'prepare-pending') {
      if (!extras.prepared) throw failure('FK_I_INVALID_CHECKPOINT','prepared data missing');
      const {taskContext,skillSnapshot,...pending} = extras.prepared;
      next.prepared=copy(pending);
      if (taskContext) next.taskContext=copy(taskContext);
      if (skillSnapshot) next.skillSnapshot=skillSnapshot;
    }
    if (proposal.stackEffect?.kind==='pop' && proposal.stackEffect.expectedKind==='agent') delete next.skillSnapshot;
    if (proposal.kind === 'move' && cp.phase === 'enter' && cp.blockId !== next.blockId
      && proposal.stackEffect.kind === 'push') {
      next.activationSeq=cp.activationSeq+1;
      if (proposal.stackEffect.frame.kind==='agent') next.agentStepCounter=cp.agentStepCounter+1;
    }
    return next;
  }

  function stepCAS(cp,proposal,event,legacyEventKind,extras={}) {
    const next=stepCheckpoint(cp,proposal,extras);
    return casOrCapacityExit(cp,{
      runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:{
        kind:proposal.kind,event:legacyEventKind,from:cp.blockId,
        to:proposal.toBlockId ?? null,causeCode:proposal.causeCode ?? null,
      },
    },Object.keys(extras).length ? {
      eventDigest:fingerprint([event.eventDigest,extras]),
    } : event,proposal);
  }

  async function makePrepared(cp,program) {
    const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
    const node=program.programTable.nodes[block.nodeId];
    const frame=cp.controlStack.at(-1);
    if (!hasStepFrame(node.kind) || cp.phase!=='prepare' || !frame) {
      throw failure('FK_I_INVALID_CHECKPOINT','not at a step prepare phase');
    }
    if (node.kind!=='agent') {
      const {name,action,reads,writes,verifier,effect}=node.metadata;
      const input=reads===undefined?cp.state:inputForAgent(cp.state,reads).input;
      if (node.kind==='action' && (reads?.some(key=>!Object.hasOwn(input,key))
        || reads===undefined && cp.unavailableParallelKeys?.some(key=>!Object.hasOwn(cp.state,key)))) {
        throw failure('FK_I_PARALLEL_INPUT','Action requires declared inputs available in the current state');
      }
      const requestId='req:'+fingerprint([cp.namespace,cp.runId,cp.artifactHash,block.nodeId,
        frame.activation,frame.attempt]).slice(7);
      const task={name,input,contextError:cp.contextError,
        ...(node.kind==='action'?{action,writes,...(effect?{effect}:{}),operationKey:fingerprint([
          cp.namespace,cp.runId,cp.artifactHash,block.nodeId,frame.activation,
        ])}:node.kind==='verification'?{verifier}:{reviewDigest:fingerprint([requestId,name,cp.state,cp.contextError])})};
      return copy({kind:node.kind,runId:cp.runId,nodeId:block.nodeId,id:block.nodeId,name,
        requestId,attempt:frame.attempt,task});
    }
    if (node.metadata.inputs.some(key=>cp.unavailableParallelKeys?.includes(key)&&!Object.hasOwn(cp.state,key))) {
      throw failure('FK_I_PARALLEL_INPUT','Agent input was available only from a losing branch');
    }
    if (node.metadata.task) {
      const policy = {...policySnapshot.taskPolicy, fetch:execution.taskResourcePolicy?.fetch,
        authorizeRemote:execution.taskResourcePolicy?.authorizeRemote,isImmutableResource:execution.taskResourcePolicy?.isImmutableResource};
      const budget = createBudget(policySnapshot.taskPolicy ?? {}, signal, cp.taskContext);
      const timeout = AbortSignal.timeout(Math.max(1,Math.min(2147483647,budget.deadlineMs-Date.now())));
      const taskSignal = signal ? AbortSignal.any([signal,timeout]) : timeout;
      const activationId = 'activation:' + fingerprint([cp.runId,cp.artifactHash,frame.activation]).slice(7);
      const saved = cp.taskContext?.active?.activationId === activationId ? cp.taskContext.active : null;
      const {input,missing} = saved ?? inputForAgent(cp.state,node.metadata.inputs);
      const descriptionResources = saved?.prepared.descriptionResources ?? await during(taskSignal, () =>
        createDescriptionResources(node.metadata.task.descriptionRefs ?? [],policy,
          {remoteSkillHosts:policy.remoteSkillHosts},budget,taskSignal));
      const requestId = 'req:' + fingerprint([cp.namespace,cp.runId,cp.artifactHash,frame.nodeId,frame.activation,frame.attempt]).slice(7);
      const mode=interactiveModeForStage(cp.program.implementedStage);
      const task = freezeDeep(copy({protocolVersion:2,
        workflow:{id:program.interactiveProgram.identity.workflowId,version:program.interactiveProgram.identity.workflowVersion,
          ...program.interactiveProgram.identity,artifactHash:cp.artifactHash,mode},
        run:{runId:cp.runId},node:{id:block.nodeId,name:node.metadata.name},task:node.metadata.task,
        input,missing,outputSchema:node.metadata.output,
        execution:{activationId,requestId,deadlineMs:budget.deadlineMs,attempt:frame.attempt,reasons:frame.reasons}}));
      const context = Object.freeze({signal:taskSignal,budget,deadlineMs:budget.deadlineMs,
        descriptionResources,projectRoot:policy.projectRoot,hostProfile:policy.hostProfile,
        authorizationContextRef:policy.authorizationContextRef});
      const prepared = await prepareTaskV2(task,execution,policy,context,mode);
      if (saved && prepared.resourceManifest.manifestHash !== saved.prepared.resourceManifest.manifestHash) {
        throw failure('FK_I_PROGRAM_MISMATCH','Prepared task resources changed within the activation');
      }
      if (await during(taskSignal,()=>execution.authorizeAgentTask(prepared,context)) !== true) {
        throw failure('FK_I_HOST_DENIED','Host denied Task V2 preparation');
      }
      budget.dispatch();
      return copy({kind:'agent',runId:cp.runId,nodeId:block.nodeId,id:block.nodeId,name:node.metadata.name,
        requestId,attempt:frame.attempt,instruction:Array.isArray(node.metadata.task.description) ?
          node.metadata.task.description.join('\n') : node.metadata.task.description ?? '',input,missing,
        resultSchema:node.metadata.output,reasons:frame.reasons,preparedTask:prepared,
        taskContext:{...cp.taskContext,...budget.snapshot(),active:{activationId,input,missing,prepared}}});
    }
    const pin=program.interactiveProgram.identity.implementedStage!=='P0-A';
    const instruction = cp.skillSnapshot?.instruction ?? await execution.skillResolver(Object.freeze(copy({
      runId:cp.runId,nodeId:block.nodeId,name:node.metadata.name,
      agent:node.metadata.agent ?? null,skill:node.metadata.skill ?? null,
      integrity:node.metadata.integrity ?? null,
    })));
    if (typeof instruction !== 'string' || !instruction.length || instruction.length > 128*1024) {
      throw failure('FK_I_SKILL_CONTRACT','skillResolver must supply bounded text');
    }
    const {input,missing}=inputForAgent(cp.state,node.metadata.inputs);
    const requestId = 'req:' + fingerprint([
      cp.namespace,cp.runId,cp.artifactHash,frame.nodeId,frame.activation,frame.attempt,
    ]).slice(7);
    return copy({
      kind:'agent',runId:cp.runId,nodeId:block.nodeId,id:block.nodeId,
      name:node.metadata.name,requestId,attempt:frame.attempt,
      instruction,input,missing,resultSchema:node.metadata.output,
      reasons:frame.reasons,
      ...(pin?{skillSnapshot:{activation:frame.activation,nodeId:block.nodeId,instruction}}:{}),
      ...(node.metadata.overview ? {overview:{step:frame.overviewStep}} : {}),
    });
  }

  async function validateCandidate(cp,program) {
    if (cp.phase!=='validate' || !hasStepFrame(cp.candidate?.kind)
      || cp.candidate.requestId == null || cp.candidate.validated === true) {
      throw failure('FK_I_INVALID_CHECKPOINT','unvalidated candidate required');
    }
    const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
    const {kind,metadata}=program.programTable.nodes[block.nodeId];
    if (kind!=='agent') {
      const {result,submissionKind,failure:executionFailure}=cp.candidate;
      if (submissionKind===kind+'-call-failed') {
        const operationKey=cp.receivedSubmission?.payload?.operationKey;
        const contextError={code:executionFailure.code??'FK_I_STEP_FAILED',message:executionFailure.message,
          ...(operationKey?{operationKey,sideEffectStatus:executionFailure.sideEffectStatus}:{})};
        return kind==='action'
          ? {kind:'external-rejected',contextError}
          : {kind:'deterministic-failure',causeCode:contextError.code,contextError};
      }
      if (kind==='verification') {
        if (!hasFields(result,['passed']) || typeof result.passed!=='boolean') {
          return {kind:'deterministic-failure',causeCode:'FK_I_VERIFICATION_CONTRACT'};
        }
        const {loop}=metadata;
        if (!loop) return {kind:result.passed?'external-passed':'external-rejected'};
        const attempt=(Object.hasOwn(cp.regionCounters??{},loop.id)?cp.regionCounters[loop.id]:0)+1;
        const exhausted=attempt>=loop.maxIterations;
        return {kind:result.passed?'external-passed':exhausted?'loop-exhausted':'external-rejected',
          counter:{id:loop.id,count:result.passed||exhausted?0:attempt}};
      }
      if (kind==='human') {
        if (!hasFields(result,['approved'],['comment']) || typeof result.approved!=='boolean'
          || (result.comment!=null && typeof result.comment!=='string')) {
          return {kind:'deterministic-failure',causeCode:'FK_I_HUMAN_CONTRACT'};
        }
        const id=block.nodeId;
        const used=Object.hasOwn(cp.regionCounters??{},id)?cp.regionCounters[id]:0;
        const exhausted=!result.approved && metadata.maxRevisions!==undefined && used>=metadata.maxRevisions;
        return {kind:result.approved?'external-passed':exhausted?'deterministic-failure':'external-rejected',
          ...(exhausted?{causeCode:'FK_R004'}:{}),
          patch:{set:{[id]:{approved:result.approved,comment:result.comment??null}}},
          counter:{id,count:result.approved||exhausted?0:used+1}};
      }
      const patch=result;
      if (!hasFields(patch,['set'],['remove']) || !patch.set || typeof patch.set!=='object'
        || Array.isArray(patch.set) || (Object.hasOwn(patch,'remove')&&!Array.isArray(patch.remove))) {
        return {kind:'deterministic-failure',causeCode:'FK_I_ACTION_PATCH'};
      }
      const written=[...Object.keys(patch.set),...(patch.remove??[])];
      if (new Set(written).size!==written.length || written.some(key=>!metadata.writes.includes(key))) {
        return {kind:'deterministic-failure',causeCode:'FK_I_ACTION_PATCH'};
      }
      return {kind:'external-passed',patch,contextError:null};
    }
    const schema=copy(metadata.output);
    if (cp.candidate.submissionKind === 'agent-call-failed') {
      if ((cp.program.implementedStage!=='P0-A' || program.programTable.nodes[block.nodeId].metadata.task) &&
        (cp.candidate.failure.retryable !== true || cp.candidate.failure.sideEffectStatus !== 'none')) {
        return {kind:'deterministic-failure',causeCode:'FK_I_AGENT_EXECUTION_FAILED'};
      }
      return {kind:'agent-call-failed',reasons: ['runAgent threw: ' +
        cp.candidate.failure.message.slice(0,MAX_REASON_LENGTH-16)]};
    }
    // Compiler output schema is an object. An incorrectly permissive Host validator
    // must not pass a primitive that would later strand the commit stage.
    if (!cp.candidate.result || typeof cp.candidate.result !== 'object'
      || Array.isArray(cp.candidate.result)) {
      return {kind:'validation-rejected',reasons:['Agent result must be object']};
    }
    let reasons;
    try {
      reasons=execution.validateResult(schema,copy(cp.candidate.result));
      if (reasons && typeof reasons.then === 'function') {
        throw failure('FK_I_VALIDATOR_CONTRACT','validateResult must be synchronous and pure');
      }
      reasons=reasonsFromValidation(reasons);
      const evaluationIdentity={runId:cp.runId,requestId:cp.candidate.requestId,attempt:cp.candidate.attempt};
      const validationContext=()=> {
        const budget=createBudget(policySnapshot.taskPolicy??{},signal,cp.taskContext);
        const timeout=AbortSignal.timeout(Math.max(1,Math.min(2147483647,budget.deadlineMs-Date.now())));
        return Object.freeze({signal:signal?AbortSignal.any([signal,timeout]):timeout});
      };
      if (!reasons.length && execution.checkStep) {
        const context=validationContext();
        const reason=await during(context.signal,()=>execution.checkStep(freezeDeep(copy({...evaluationIdentity,
          id:block.nodeId,name:metadata.name,result:cp.candidate.result,state:cp.state,contextError:cp.contextError})),context));
        if (typeof reason==='string') reasons=reasonsFromValidation([reason]);
        else if (reason!=null) throw failure('FK_I_VALIDATOR_CONTRACT','checkStep requires text or null');
      }
      if (!reasons.length && metadata.verify) {
        const context=validationContext();
        const approved=await during(context.signal,()=>execution.verifyAgentResult(freezeDeep(copy({...evaluationIdentity,
          id:block.nodeId,name:metadata.name,verifier:metadata.verify,state:{...cp.state,...cp.candidate.result},
          contextError:cp.contextError})),context));
        if (typeof approved!=='boolean') throw failure('FK_I_VALIDATOR_CONTRACT','Agent verification requires a boolean');
        if (!approved) reasons=reasonsFromValidation(['verify '+metadata.verify+' failed']);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return {kind:'deterministic-failure',causeCode:'FK_I_VALIDATOR_CONTRACT'};
    }
    return reasons.length
      ? {kind:'validation-rejected',reasons}
      : {kind:'validation-passed',reasons:[]};
  }

  function createParallel(cp,program,block,record,scoped=false) {
    let activationSeq=cp.activationSeq,agentStepCounter=cp.agentStepCounter;
    const structured=scoped || record.metadata.branchNodes!==undefined;
    const lanes=record.metadata.branches.map(nodeId=>({
      nodeId,activation:++activationSeq,attempt:1,reasons:[],status:'ready',
      overviewStep:program.programTable.nodes[nodeId].kind==='agent'?++agentStepCounter:activationSeq,
      ...(structured?{scope:{blockId:nodeId+'::enter',phase:'enter',status:'running',
        state:cp.state,controlStack:[],contextError:cp.contextError,regionCounters:{},
        unavailableParallelKeys:cp.unavailableParallelKeys??[]}}:{})
    }));
    return {parallel:{nodeId:block.nodeId,strategy:record.metadata.strategy,lanes,...(structured?{structured}:{}),
      ...(policySnapshot.parallelEffectMode?{effectMode:policySnapshot.parallelEffectMode}:{})},activationSeq,agentStepCounter};
  }

  async function prepareLane(cp,program,lane,revision) {
    const kind=program.programTable.nodes[lane.nodeId].kind;
    const taskContext=cp.taskContext && copy(cp.taskContext);
    if (taskContext && lane.resources) taskContext.active=lane.resources;
    const {taskContext:preparedBudget,skillSnapshot,...pending}=await makePrepared({
      ...cp,phase:'prepare',blockId:lane.nodeId+'::prepare',
      controlStack:[{...lane,kind}],taskContext,skillSnapshot:lane.skillSnapshot,
    },program);
    const {active,...budget}=preparedBudget??{};
    return {lane:{...lane,status:'pending',pending:{...pending,issuedRevision:revision},
      requestIds:[...(lane.requestIds??[]),pending.requestId],
      ...(skillSnapshot?{skillSnapshot}:{}),...(active?{resources:active}:{})},
    ...(preparedBudget?{taskContext:budget}:{})};
  }

  function scopedWork(cp) {
    return {revision:cp.revision+1,activationSeq:cp.activationSeq,agentStepCounter:cp.agentStepCounter,
      taskContext:cp.taskContext,cancelled:new Set(cp.cancelledRequests),retryRequests:new Set()};
  }

  function syncScopedWork(work,local) {
    work.activationSeq=local.activationSeq;
    work.agentStepCounter=local.agentStepCounter;
    if (local.taskContext) {
      const {active,...budget}=local.taskContext;
      work.taskContext=budget;
    }
  }

  function storeScope(lane,local) {
    const {blockId,phase,status,state,controlStack,contextError,regionCounters,
      pending,prepared,candidate,receivedSubmission,skillSnapshot,parallel,unavailableParallelKeys}=local;
    lane.scope={blockId,phase,status,state,controlStack,contextError,regionCounters,
      ...(pending?{pending}:{}),...(prepared?{prepared}:{}),...(candidate?{candidate}:{}),
      ...(receivedSubmission?{receivedSubmission}:{}),...(skillSnapshot?{skillSnapshot}:{}),
      ...(parallel?{parallel}:{}),...(unavailableParallelKeys?.length?{unavailableParallelKeys}:{}),
      ...(local.taskContext?.active?{resources:local.taskContext.active}:{})};
  }

  function branchPatch(before,after) {
    return {set:Object.fromEntries(Object.entries(after).filter(([key,value])=>
      !Object.hasOwn(before,key)||fingerprint(before[key])!==fingerprint(value))),
    remove:Object.keys(before).filter(key=>!Object.hasOwn(after,key))};
  }

  function closeScopedLane(lane,group,baseline,local,work) {
    if (local.parallel) {
      lane.requestIds=[...new Set([...(lane.requestIds??[]),...local.parallel.lanes.flatMap(laneRequestIds)])];
    }
    delete lane.scope;
    lane.status=local.status;
    if (lane.status==='succeeded') lane.patch=branchPatch(baseline,local.state);
    else lane.failure={outcome:lane.status,...(local.terminal?.causeCode?{code:local.terminal.causeCode}:{})};
    if (lane.status==='succeeded' && group.strategy==='any') {
      group.decision={outcome:'succeeded',winner:lane.nodeId,revision:work.revision};
    } else if (group.strategy==='all_succeeded' && lane.failure) {
      group.decision={...lane.failure,revision:work.revision};
    }
    if (group.decision) {
      for (const other of group.lanes) {
        if (!other.scope) continue;
        if (other.scope.pending) work.cancelled.add(other.scope.pending.requestId);
        if (other.scope.parallel) {
          for (const entry of parallelPendingEntries(other.scope.parallel)) work.cancelled.add(entry.pending.requestId);
        }
        other.status='cancelled';
      }
    }
  }

  async function advanceScope(root,parent,group,lane,program,work) {
    const record=program.programTable.nodes[group.nodeId];
    const allowed=record.metadata.branchNodes?.[group.lanes.indexOf(lane)]??[lane.nodeId];
    const scope=lane.scope;
    let local={...root,...scope,parallel:scope.parallel??null,pending:scope.pending??null,
      prepared:scope.prepared??null,candidate:scope.candidate??null,receivedSubmission:scope.receivedSubmission??null,
      skillSnapshot:scope.skillSnapshot,terminal:null,revision:work.revision-1,activationSeq:work.activationSeq,
      agentStepCounter:work.agentStepCounter,taskContext:work.taskContext&&{...work.taskContext,active:scope.resources}};
    let reason='ready';
    for (let step=0;step<16;step++) {
      checkSignal();
      if (local.blockId===record.metadata.next+'::enter' || FINISHED.has(local.status)) {
        if (!FINISHED.has(local.status)) local.status='succeeded';
        closeScopedLane(lane,group,parent.state,local,work);
        return 'ready';
      }
      if (!allowed.includes(local.blockId.slice(0,local.blockId.lastIndexOf('::')))) {
        throw failure('FK_I_INVALID_CHECKPOINT','Subflow escaped its immutable branch');
      }
      if (local.parallel) {
        const nested=local.parallel;
        reason=await tickScopedGroup(root,local,program,work);
        if (local.parallel) break;
        lane.requestIds=[...new Set([...(lane.requestIds??[]),...nested.lanes.flatMap(laneRequestIds)])];
        local.activationSeq=work.activationSeq;
        local.agentStepCounter=work.agentStepCounter;
        if (work.taskContext) local.taskContext=work.taskContext;
        continue;
      }
      if (local.pending) {
        if (!(local.pending.preparedTask?.task.execution.deadlineMs<=Date.now())) {
          reason='waiting';
          break;
        }
        work.cancelled.add(local.pending.requestId);
        local.status='errored';
        local.terminal={causeCode:'FK_R004'};
        continue;
      }
      const {block,record:node}=confirmCurrentBlock(local,program);
      let event;
      const extras={};
      if (local.phase==='prepare') {
        try {
          extras.prepared=await makePrepared(local,program);
          event=internalEvent(local,'internal-step');
        } catch (error) {
          if (signal?.aborted) throw error;
          const code=['FK_I_PARALLEL_INPUT','FK_R004'].includes(error?.code)?error.code:'FK_I_PARALLEL_PREPARE';
          event=internalEvent(local,'deterministic-failure',{error:{code}});
        }
      } else if (local.phase==='validate') {
        let evaluation=await validateCandidate(local,program);
        if (local.candidate.kind==='agent' && ['validation-rejected','agent-call-failed'].includes(evaluation.kind)) {
          const effects=await store.parallelEffects(root.runId,[local.candidate.requestId]);
          if (effects.some(effect=>effect.settlement?.effect!=='no-effect')) {
            evaluation={kind:'deterministic-failure',causeCode:'FK_I_RECONCILIATION_PENDING'};
          } else work.retryRequests.add(local.candidate.requestId);
        }
        if (node.metadata.parallelOwner===group.nodeId && evaluation.kind==='external-rejected') {
          local.status='failed';
          continue;
        }
        event=internalEvent(local,evaluation.kind,evaluation.causeCode?{error:{code:evaluation.causeCode}}:{});
        if (evaluation.patch) extras.patch=evaluation.patch;
        if (evaluation.counter) extras.counter=evaluation.counter;
        if (evaluation.reasons?.length) extras.retryReasons=evaluation.reasons;
        if (Object.hasOwn(evaluation,'contextError')) extras.contextError=evaluation.contextError;
        if (node.kind==='verification'&&node.metadata.parallelOwner===group.nodeId&&evaluation.kind==='external-passed') {
          extras.patch={set:{[block.nodeId]:true}};
        }
      } else {
        const kind=local.phase==='dispatch-ready'?'pending-prepared':'internal-step';
        event=internalEvent(local,kind,local.phase==='enter'&&hasStepFrame(node.kind)?
          {activation:work.activationSeq+1,...(node.kind==='agent'?{overviewStep:work.agentStepCounter+1}:{})}:{});
      }
      const certified=advanceSafely(local,program,event);
      if (certified.proposal.kind==='begin-parallel') Object.assign(extras,createParallel(local,program,block,node,true));
      local=stepCheckpoint(local,certified.proposal,extras);
      local.revision=work.revision-1;
      syncScopedWork(work,local);
      if (local.pending && !lane.requestIds?.includes(local.pending.requestId)) {
        lane.requestIds=[...(lane.requestIds??[]),local.pending.requestId];
      }
    }
    storeScope(lane,local);
    return reason;
  }

  async function tickScopedGroup(root,parent,program,work) {
    const group=parent.parallel;
    if (group.decision) {
      const {decision}=group;
      if (decision.revision===work.revision) return 'ready';
      const winners=decision.winner?group.lanes.filter(lane=>lane.nodeId===decision.winner):group.lanes;
      if (group.strategy==='any') {
        const lost=group.lanes.filter(lane=>lane.nodeId!==decision.winner).flatMap(laneRequestIds);
        const effects=await store.parallelEffects(root.runId,lost);
        if (effects.some(effect=>!effect.settlement||keyRequiresCompensation(effect))) return 'reconciliation';
      }
      const patch=decision.outcome==='succeeded'?mergeParallel(winners):null;
      const code=decision.code??(decision.outcome==='succeeded'&&!patch?'FK_I_PARALLEL_CONFLICT':null);
      const event=internalEvent(parent,code?'deterministic-failure':patch?'parallel-passed':'parallel-rejected',
        code?{error:{code}}:{});
      const {proposal}=advanceSafely(parent,program,event);
      const after=patch?{...parent.state,...patch.set}:{};
      for (const key of patch?.remove??[]) delete after[key];
      const unavailableParallelKeys=decision.winner&&patch
        ? branchOutputKeys(program,program.programTable.nodes[group.nodeId]).filter(key=>!Object.hasOwn(after,key))
        : [];
      Object.assign(parent,stepCheckpoint(parent,proposal,patch&&!code?{patch,unavailableParallelKeys}:{}));
      return 'ready';
    }
    const progress=[];
    for (const lane of group.lanes) {
      if (group.decision) break;
      if (lane.scope) progress.push(await advanceScope(root,parent,group,lane,program,work));
    }
    if (!group.decision && group.lanes.every(lane=>!lane.scope)) {
      group.decision={...(group.lanes.find(lane=>lane.failure?.code)?.failure??
        (group.lanes.every(lane=>lane.status==='succeeded')?{outcome:'succeeded'}:{outcome:'failed'})),
      revision:work.revision};
    }
    return group.decision||progress.includes('ready')?'ready'
      :progress.includes('reconciliation')?'reconciliation':'waiting';
  }

  function publishScoped(cp,next,work,progress) {
    if (next.parallel) {
      next.status=parallelPendingEntries(next.parallel).length?'waiting'
        :progress==='reconciliation'?'paused':'running';
      next.pauseReason=next.status==='paused'?'reconciliation':null;
    }
    next.revision=work.revision;
    next.stageCount=cp.stageCount+1;
    next.activationSeq=work.activationSeq;
    next.agentStepCounter=work.agentStepCounter;
    if (work.taskContext) next.taskContext=work.taskContext;
    if (work.cancelled.size) next.cancelledRequests=[...work.cancelled];
  }

  async function driveStructured(cp,program) {
    const next=copy(cp);
    const work=scopedWork(cp);
    const progress=await tickScopedGroup(cp,next,program,work);
    publishScoped(cp,next,work,progress);
    if (cp.status===next.status && cp.pauseReason===next.pauseReason && next.parallel
      && fingerprint(cp.parallel)===fingerprint(next.parallel)) return {committed:false,idle:true};
    const transition={kind:'scoped-parallel-step',nodeId:cp.parallel.nodeId};
    return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:transition},transition,transition);
  }

  async function acceptStructured(cp,program,submission,digest,operationSafety,subjectId,humanProof,receivedPayload) {
    const {requestId,nodeId,attempt,kind}=submission;
    const stepKind=kind.split('-')[0];
    const success=kind===stepKind+'-result';
    const next=copy(cp);
    const active=parallelPendingEntries(next.parallel).find(entry=>entry.pending.requestId===requestId);
    if (!active || active.pending.nodeId!==nodeId || active.pending.attempt!==attempt || active.pending.kind!==stepKind) {
      throw failure('FK_I_STALE_RECEIPT','Subflow request is not current');
    }
    if (active.pending.preparedTask?.task.execution.deadlineMs<=Date.now()) {
      throw failure('FK_I_STALE_RECEIPT','Subflow task deadline expired');
    }
    if (stepKind==='agent'&&success) {
      const effects=await store.parallelEffects(cp.runId,[requestId]);
      if (effects.some(effect=>!effect.settlement)) throw failure('FK_I_RECONCILIATION_PENDING','Agent has an unsettled external write');
      operationSafety='settled';
    }
    const work=scopedWork(cp);
    const scope=active.lane.scope;
    delete scope.pending;
    scope.phase='validate';
    scope.status='running';
    scope.blockId=nodeId+'::validate';
    scope.receivedSubmission={payload:receivedPayload??submission};
    scope.candidate={kind:stepKind,requestId,nodeId,attempt,submissionKind:kind,
      ...(success?{result:submission.result}:{failure:submission.failure}),validated:false};
    const progress=await tickScopedGroup(cp,next,program,work);
    publishScoped(cp,next,work,progress);
    if (work.retryRequests.has(requestId)) operationSafety='no-effect';
    next.receiptCount++;
    next.parallel.receipt={requestId,nodeId,attempt,kind:stepKind,canonicalDigest:digest,
      acceptedRevision:next.revision,...(humanProof?{humanProof}:{})};
    const transition={kind:'scoped-parallel-receipt',requestId,nodeId,digest};
    return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:{kind:'receipt-accepted',stepKind,nodeId,attempt,requestId,digest,
        ...(subjectId?{subjectId}:{}),...(operationSafety?{operationSafety}:{})}},
    transition,transition,success?'succeeded':'failed');
  }

  function mergeParallel(lanes) {
    const entries=[],remove=[],seen=new Set();
    for (const {patch} of lanes) {
      const updates=Object.entries(patch?.set??{});
      for (const key of [...updates.map(([name])=>name),...(patch?.remove??[])]) {
        if (seen.has(key)) return null;
        seen.add(key);
      }
      entries.push(...updates);
      remove.push(...(patch?.remove??[]));
    }
    return {set:Object.fromEntries(entries),remove};
  }

  async function driveParallel(cp,program) {
    const {decision}=cp.parallel;
    if (!decision) {
      const next=copy(cp);
      next.revision++;
      next.stageCount++;
      for (const [index,lane] of next.parallel.lanes.entries()) {
        if (lane.status!=='ready') continue;
        try {
          const prepared=await prepareLane(next,program,lane,next.revision);
          next.parallel.lanes[index]=prepared.lane;
          if (prepared.taskContext) next.taskContext=prepared.taskContext;
        } catch (error) {
          if (signal?.aborted) throw error;
          const code=error?.code==='FK_I_PARALLEL_INPUT'?error.code:'FK_I_PARALLEL_PREPARE';
          if (next.parallel.strategy==='all_succeeded') {
            const event=internalEvent(cp,'deterministic-failure',{error:{code}});
            const {proposal}=advanceSafely(cp,program,event);
            return stepCAS(cp,proposal,event,event.kind);
          }
          lane.status='errored';
          lane.failure={outcome:'errored',code};
        }
      }
      if (next.parallel.lanes.some(lane=>lane.status==='pending')) next.status='waiting';
      else {
        next.parallel.decision=next.parallel.lanes.find(lane=>lane.failure).failure;
        next.status='running';
      }
      return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
        journalEntry:{kind:'parallel-dispatch',nodeId:cp.parallel.nodeId}},
      {kind:'parallel-dispatch'},{kind:'parallel-dispatch'});
    }
    const joined=decision.winner
      ? cp.parallel.lanes.filter(lane=>lane.nodeId===decision.winner) : cp.parallel.lanes;
    if (cp.parallel.strategy==='any') {
      const losingIds=cp.parallel.lanes.filter(lane=>lane.nodeId!==decision.winner)
        .flatMap(lane=>lane.requestIds??[]);
      const unsettled=await store.parallelEffects(cp.runId,losingIds);
      const blocked=unsettled.some(operation=>!operation.settlement
        || keyRequiresCompensation(operation));
      if (blocked) {
        if (cp.pauseReason==='reconciliation') return {committed:false,waitingForSettlement:true,checkpoint:cp};
        const next={...cp,status:'paused',pauseReason:'reconciliation',revision:cp.revision+1};
        return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
          journalEntry:{kind:'parallel-await-reconciliation',nodeId:cp.parallel.nodeId}},
        {kind:'parallel-await-reconciliation'},{kind:'parallel-await-reconciliation'});
      }
    }
    const patch=decision.outcome==='succeeded'?mergeParallel(joined):null;
    const unavailableParallelKeys=decision.winner&&patch
      ? losingOutputKeys(cp,program,patch) : [];
    const causeCode=decision.outcome==='errored'?decision.code
      :decision.outcome==='succeeded'&&!patch?'FK_I_PARALLEL_CONFLICT':null;
    const event=internalEvent(cp,causeCode?'deterministic-failure'
      :patch?'parallel-passed':'parallel-rejected',causeCode?{error:{code:causeCode}}:{});
    const certified=advanceSafely(cp,program,event);
    return stepCAS(cp,certified.proposal,certified.event,event.kind,
      patch&&!causeCode?{patch,unavailableParallelKeys}:decision.error?{contextError:decision.error}:{});
  }

  function keyRequiresCompensation(operation) {
    return policySnapshot.parallelEffectMode==='compensate'
      && operation.settlement.effect==='applied' && !operation.compensation?.evidenceHash;
  }

  function losingOutputKeys(cp,program,patch) {
    const after={...cp.state,...patch.set};
    for (const key of patch.remove??[]) delete after[key];
    return parallelOutputKeys(program,cp.parallel.lanes.map(lane=>lane.nodeId)).filter(key=>!Object.hasOwn(after,key));
  }

  function parallelOutputKeys(program,branchIds) {
    return [...new Set(branchIds.flatMap(id=>{
      const {kind,metadata}=program.programTable.nodes[id];
      if (kind==='human'||kind==='verification'&&metadata.parallelOwner) return [id];
      if (kind==='action') return metadata.writes;
      return kind==='agent'?Object.keys(metadata.output.properties??{}):[];
    }))];
  }

  function branchOutputKeys(program,record) {
    return parallelOutputKeys(program,record.metadata.branchNodes?.flat()??record.metadata.branches);
  }

  function missingMandatoryParallelInput(cp,program,record) {
    if (record.metadata.branchNodes) return false;
    let successor=record.metadata.next;
    const visited=new Set();
    while (!visited.has(successor)) {
      const node=program.programTable.nodes[successor];
      if (node.kind==='agent') {
        const writes=branchOutputKeys(program,record);
        return node.metadata.inputs.some(key=>writes.includes(key)&&!Object.hasOwn(cp.state,key));
      }
      if (node.kind!=='condition' || new Set(node.metadata.branches.map(branch=>branch.next)).size!==1) break;
      visited.add(successor);
      successor=node.metadata.branches[0].next;
    }
    return false;
  }

  async function acceptParallel(cp,program,submission,digest,operationSafety,subjectId) {
    const {requestId,nodeId,attempt,kind}=submission;
    const index=cp.parallel.lanes.findIndex(lane=>lane.pending?.requestId===requestId);
    const current=cp.parallel.lanes[index];
    const stepKind=kind.split('-')[0];
    if (!current || cp.parallel.decision || cp.status!=='waiting' || current.attempt!==attempt
      || current.nodeId!==nodeId || current.pending.kind!==stepKind) {
      throw failure('FK_I_STALE_RECEIPT','Parallel request is not active');
    }
    const didSucceed=kind===stepKind+'-result';
    if (stepKind==='agent'&&didSucceed) {
      const effects=await store.parallelEffects(cp.runId,[requestId]);
      if (effects.some(effect=>!effect.settlement)) {
        throw failure('FK_I_RECONCILIATION_PENDING','Agent has an unsettled external write');
      }
      operationSafety='settled';
    }
    const candidate={kind:stepKind,requestId,nodeId,attempt,submissionKind:kind,
      ...(didSucceed?{result:submission.result}:{failure:submission.failure})};
    const evaluation=await validateCandidate({...cp,phase:'validate',blockId:nodeId+'::validate',candidate},program);
    const next=copy(cp);
    next.revision++;
    next.receiptCount++;
    const parallel=next.parallel;
    const lane=parallel.lanes[index];
    delete lane.pending;
    function rejectLane(code,error) {
      lane.status=code?'errored':'failed';
      lane.failure={outcome:lane.status,...(code?{code}:{}),...(error?{error}:{})};
      if (parallel.strategy==='all_succeeded') parallel.decision=lane.failure;
      else if (!parallel.lanes.some(item=>item.status==='pending')) {
        parallel.decision=parallel.lanes.find(item=>item.status==='errored')?.failure??{outcome:'failed'};
      }
    }
    const retry=['validation-rejected','agent-call-failed'].includes(evaluation.kind);
    const canRetry=retry && attempt<=program.programTable.nodes[nodeId].metadata.retries;
    const effects=canRetry?await store.parallelEffects(cp.runId,[requestId]):[];
    if (canRetry && effects.some(effect=>effect.settlement?.effect!=='no-effect')) {
      rejectLane('FK_I_RECONCILIATION_PENDING');
    } else if (canRetry) {
      try {
        const prepared=await prepareLane(next,program,{...lane,attempt:attempt+1,reasons:evaluation.reasons},next.revision);
        parallel.lanes[index]=prepared.lane;
        if (prepared.taskContext) next.taskContext=prepared.taskContext;
        operationSafety='no-effect';
      } catch (error) {
        if (signal?.aborted) throw error;
        rejectLane(error.code==='FK_I_PARALLEL_INPUT'?error.code:'FK_I_PARALLEL_PREPARE');
      }
    } else if (evaluation.kind==='validation-passed'||evaluation.kind==='external-passed') {
      lane.status='succeeded';
      lane.patch=evaluation.patch??{set:stepKind==='verification'?{[nodeId]:true}:submission.result};
      if (parallel.strategy==='any') parallel.decision={outcome:'succeeded',winner:nodeId};
      else if (parallel.lanes.every(item=>item.status==='succeeded')) parallel.decision={outcome:'succeeded'};
    } else {
      const code=evaluation.causeCode??evaluation.contextError?.code??(retry?'FK_R004':null);
      rejectLane(code,evaluation.contextError);
    }
    if (parallel.decision) {
      const cancelled=[];
      for (const loser of parallel.lanes) {
        if (loser.status!=='pending') continue;
        cancelled.push(loser.pending.requestId);
        loser.status='cancelled';
        delete loser.pending;
      }
      if (cancelled.length) next.cancelledRequests=[...(next.cancelledRequests??[]),...cancelled];
    }
    parallel.receipt={requestId,nodeId,attempt,kind:stepKind,canonicalDigest:digest,acceptedRevision:next.revision};
    next.status=parallel.decision?'running':'waiting';
    return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:{kind:'receipt-accepted',stepKind,nodeId,attempt,requestId,digest,
        ...(subjectId?{subjectId}:{}),
        ...(operationSafety?{operationSafety}:{})}},
    {kind:'parallel-receipt',nodeId,requestId,submissionDigest:digest},
    {kind:'parallel-receipt',decision:parallel.decision??null},didSucceed?'succeeded':'failed');
  }

  async function expireParallelAgents(cp) {
    if (cp.status!=='waiting' || !cp.parallel || !cp.taskContext || cp.taskContext.deadlineMs>Date.now()) return null;
    const expired=cp.parallel.lanes.filter(lane=>lane.pending?.preparedTask);
    if (!expired.length) return null;
    const next=copy(cp);
    next.revision++;
    const group=next.parallel;
    const failure={outcome:'errored',code:'FK_R004',deadline:true};
    const expiredIds=new Set(expired.map(lane=>lane.nodeId));
    if (group.strategy==='all_succeeded') group.decision=failure;
    const cancelled=[];
    for (const lane of group.lanes) {
      if (!lane.pending || (!group.decision && !expiredIds.has(lane.nodeId))) continue;
      cancelled.push(lane.pending.requestId);
      delete lane.pending;
      lane.status=expiredIds.has(lane.nodeId)?'errored':'cancelled';
      if (lane.status==='errored') lane.failure=failure;
    }
    if (!group.decision && !group.lanes.some(lane=>lane.status==='pending')) {
      group.decision=group.lanes.find(lane=>lane.status==='errored')?.failure??failure;
    }
    next.status=group.decision?'running':'waiting';
    next.cancelledRequests=[...(next.cancelledRequests??[]),...cancelled];
    return casOrCapacityExit(cp,{runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      journalEntry:{kind:'parallel-agent-deadline',cancelled}},
    {kind:'parallel-agent-deadline',cancelled},{kind:'parallel-agent-deadline'});
  }

  async function drive(runId) {
    for (let count=0; count < stageBudget; ) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible in this namespace');
      if (cp.status==='cancelled' && cp.namespace===store.namespace && cp.policyHash===policyHash) return asPublicFrame(cp);
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status)) return asPublicFrame(cp);
      if (runDeadlineExpired(cp)) {
        const expired=await failRun(cp,'FK_R004','run-deadline');
        if (expired.committed) return asPublicFrame(expired.checkpoint);
        continue;
      }
      if (cp.parallel?.structured) {
        const scoped=await driveStructured(cp,program);
        if (!scoped.committed) {
          if (scoped.idle) return asPublicFrame(cp);
          continue;
        }
        count++;
        if (scoped.checkpoint.status==='paused'&&scoped.checkpoint.pauseReason==='reconciliation') {
          return asPublicFrame(scoped.checkpoint);
        }
        continue;
      }
      if (cp.status==='waiting') {
        const expired=await expireParallelAgents(cp);
        if (!expired) return asPublicFrame(cp);
        if (expired.committed) count++;
        continue;
      }
      if (cp.status === 'paused' && cp.pauseReason!=='reconciliation') {
        if (!['stage-budget','skill-temporary'].includes(cp.pauseReason)) return asPublicFrame(cp);
        const unpause={...cp,status:'running',revision:cp.revision+1,pauseReason:null};
        const committed=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
          nextCheckpoint:unpause,
          journalEntry:{kind:'resume-budget'}},{kind:'resume-budget'},{kind:'resume-budget'});
        if (!committed.committed) continue;
        // Budget unpause is a control action, not a Program stage.
        continue;
      }
      if (cp.parallel) {
        const advanced=await driveParallel(cp,program);
        if (advanced.waitingForSettlement || advanced.committed&&advanced.checkpoint.pauseReason==='reconciliation') {
          return asPublicFrame(advanced.checkpoint);
        }
        if (advanced.committed) count++;
        if (advanced.committed && (advanced.checkpoint.status==='waiting'||FINISHED.has(advanced.checkpoint.status))) {
          return asPublicFrame(advanced.checkpoint);
        }
        continue;
      }
      const {block,record}=confirmCurrentBlock(cp,program);
      if (cp.phase === 'awaiting') {
        throw failure('FK_I_INVALID_CHECKPOINT','awaiting without waiting Pending');
      }
      let event,extras={};
      if (cp.phase === 'prepare') {
        let prepared;
        try { prepared=await makePrepared(cp,program); }
        catch (error) {
          if (['FK_R014','FK_I_TEMPORARY_SKILL'].includes(error?.code)) {
            const paused={...cp,revision:cp.revision+1,status:'paused',
              pauseReason:'skill-temporary'};
            const result=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
              nextCheckpoint:paused,
              journalEntry:{kind:'pause',reason:'skill-temporary'}},
              {kind:'skill-temporary'},{kind:'pause',reason:'skill-temporary'});
            if (!result.committed) continue;
            return asPublicFrame(result.checkpoint);
          }
          const causeCode=['FK_R010','FK_R011','FK_I_PARALLEL_INPUT'].includes(error?.code)
            ? error.code : 'FK_I_SKILL_CONTRACT';
          event=internalEvent(cp,'deterministic-failure',{error:{code:causeCode}});
        }
        if (prepared) {
          event=internalEvent(cp,'internal-step');
          extras.prepared=prepared;
        }
      } else if (cp.phase === 'validate') {
        let evaluation=await validateCandidate(cp,program);
        if (cp.candidate.kind==='agent' && cp.program.implementedStage!=='P0-A'
          && ['validation-rejected','agent-call-failed'].includes(evaluation.kind)) {
          const effects=await store.parallelEffects(cp.runId,[cp.candidate.requestId]);
          if (effects.some(effect=>effect.settlement?.effect!=='no-effect')) {
            evaluation={kind:'deterministic-failure',causeCode:'FK_I_RECONCILIATION_PENDING'};
          }
        }
        event=evaluation.kind === 'deterministic-failure'
          ? internalEvent(cp,'deterministic-failure',{error:{code:evaluation.causeCode}})
          : internalEvent(cp,evaluation.kind);
        if (evaluation.reasons?.length) extras.retryReasons=evaluation.reasons;
        if (evaluation.patch) extras.patch=evaluation.patch;
        if (evaluation.counter) extras.counter=evaluation.counter;
        if (Object.hasOwn(evaluation,'contextError')) extras.contextError=evaluation.contextError;
      } else {
        const kind=cp.phase==='dispatch-ready' ? 'pending-prepared' : 'internal-step';
        const extra=cp.phase==='enter' && block.nodeId in program.programTable.nodes
          && hasStepFrame(program.programTable.nodes[block.nodeId].kind)
          ? {activation:cp.activationSeq+1,
            ...(program.programTable.nodes[block.nodeId].kind==='agent'&&cp.program.implementedStage!=='P0-A'
              ? {overviewStep:cp.agentStepCounter+1}:{})} : {};
        event=cp.phase==='enter' && record.kind==='parallel' && record.metadata.strategy==='any'
          && missingMandatoryParallelInput(cp,program,record)
          ? internalEvent(cp,'deterministic-failure',{error:{code:'FK_I_PARALLEL_INPUT'}})
          : internalEvent(cp,kind,extra);
      }
      const certified=advanceSafely(cp,program,event);
      if (certified.proposal.kind==='begin-parallel') extras=createParallel(cp,program,block,record);
      const advanced=await stepCAS(cp,certified.proposal,certified.event,event.kind,extras);
      if (!advanced.committed) continue;
      count++;
      if (FINISHED.has(advanced.checkpoint.status) || advanced.checkpoint.status==='waiting') {
        return asPublicFrame(advanced.checkpoint);
      }
    }
    // A stage budget is observable and resumable. Never misreport it as waiting.
    for (;;) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (cp.status==='cancelled' && cp.namespace===store.namespace && cp.policyHash===policyHash) return asPublicFrame(cp);
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status) || cp.status==='waiting' || cp.status==='paused') {
        return asPublicFrame(cp);
      }
      const paused={...cp,revision:cp.revision+1,status:'paused',
        pauseReason:'stage-budget'};
      const result=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
        nextCheckpoint:paused,
        journalEntry:{kind:'pause',reason:'stage-budget'}},
        {kind:'budget-exhausted'},{kind:'pause',reason:'stage-budget'});
      if (result.committed) return asPublicFrame(result.checkpoint);
    }
  }

  /** Register compiler-verified bytes before the idempotent start transaction. */
  async function start({programBytes,programIdentity,startKey,runId=randomUUID(),state={},startIntent=null,
    authorizeExisting}={}) {
    nonempty(startKey,'startKey');nonempty(runId,'runId');
    if (!(programBytes instanceof Uint8Array) || !programIdentity) {
      throw new TypeError('Compiler Program bytes and identity are required');
    }
    const byteSnapshot=Buffer.from(programBytes);
    const declared=copy(programIdentity);
    assertSHA256(declared.artifactHash);
    // The first await yields even when the loader is already settled. Copy
    // caller-owned State and startIntent before that yield. Checkpoint
    // creation, the start intent hash, and Store writes all use these copies.
    let stateSnapshot;
    try { stateSnapshot=copy(state); }
    catch(error) {
      if (error instanceof RangeError && /Canonical JSON exceeds maximum bytes/.test(error.message)) {
        throw failure('FK_I_CHECKPOINT_CAPACITY', 'initial State exceeds Checkpoint hard limit');
      }
      throw error;
    }
    const intentSnapshot=copy(startIntent);
    const program=await loadInteractiveProgram(byteSnapshot,declared.artifactHash);
    if (!versioned && declared.implementedStage!=='P0-A') {
      throw failure('FK_I_UNSUPPORTED_GRAPH','This Program requires the authorized Interactive Host API');
    }
    if (!canonicalBytes({...program.interactiveProgram.identity,artifactHash:declared.artifactHash})
      .equals(canonicalBytes(declared))) {
      throw failure('FK_I_PROGRAM_MISMATCH','identity and verified Program differ');
    }
    assertRuntime(program,execution); // before any mutation, reject unavailable Stage bindings
    if (!policySnapshot.parallelEffectMode && Object.values(program.programTable.nodes).some(node=>
      node.kind==='parallel'&&node.metadata.strategy==='any'&&(node.metadata.branchNodes?.flat()??node.metadata.branches).some(id=>
        program.programTable.nodes[id].kind==='action'
          && program.programTable.nodes[id].metadata.effect!=='read-only'))) {
      throw failure('FK_I_INVALID_OPERATION','Parallel any Actions require an explicit effect policy');
    }
    const initial=initialCheckpoint(store.namespace,runId,program,policyIdentity,stateSnapshot);
    if (Object.values(program.programTable.nodes).some(node=>node.metadata.task)) {
      initial.taskContext=createBudget(policySnapshot.taskPolicy ?? {},signal).snapshot();
    }
    checkSignal();
    const registered=store.putArtifact({programIdentity:declared,bytes:byteSnapshot});
    if (versioned) await registered;
    checkSignal();
    const opening=store.createRun({startKey,startIntent:intentSnapshot,checkpoint:initial});
    const opened=versioned ? await opening : opening;
    if (versioned && !opened.created) await authorizeExisting(opened.checkpoint.runId);
    return drive(opened.checkpoint.runId);
  }

  /** Only a trusted Host may call complete; M5 will bind provenance/transport. */
  async function complete({runId,requestId,nodeId,attempt,kind='agent-result',result,failure:callFailure,
    submissionDigest,receivedPayload,humanProof,operationSafety,subjectId}={}) {
    nonempty(runId,'runId');nonempty(requestId,'requestId');nonempty(nodeId,'nodeId');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('Invalid Agent attempt');
    const stepKind=typeof kind==='string'?kind.split('-')[0]:null;
    const didSucceed=kind===stepKind+'-result';
    if (!hasStepFrame(stepKind) || !didSucceed && kind!==stepKind+'-call-failed') {
      throw failure('FK_I_INVALID_RECEIPT','Unsupported step receipt type');
    }
    if (stepKind==='human' && !isHumanProof(humanProof)) throw failure('FK_I_HOST_DENIED','Human proof is required');
    let safeFailure;
    if (!didSucceed) {
      safeFailure=copy(callFailure);
      if (!safeFailure || typeof safeFailure !== 'object' || Array.isArray(safeFailure)
        || typeof safeFailure.message !== 'string' || !safeFailure.message.length
        || safeFailure.message.length > 4096 || Object.keys(safeFailure).some(key=>!['message','retryable','sideEffectStatus','code'].includes(key))
        || safeFailure.retryable !== undefined && typeof safeFailure.retryable !== 'boolean'
        || safeFailure.sideEffectStatus !== undefined && !['none','known','unknown'].includes(safeFailure.sideEffectStatus)
        || safeFailure.code !== undefined && typeof safeFailure.code !== 'string') {
        throw failure('FK_I_INVALID_RECEIPT','Agent failure requires bounded {message:string}');
      }
    }
    // Size-only rejection must not require serializing an enormous receipt
    // into the 2 MiB Checkpoint budget before we can mark a matched Run errored.
    const rawSubmission=didSucceed
      ? {runId,requestId,nodeId,attempt,kind,result}
      : {runId,requestId,nodeId,attempt,kind,failure:safeFailure};
    // Both the value AND its actual receipt envelope must be serializable
    // under the protocol's 2 MiB bound. Otherwise snapshotting first would
    // throw a raw RangeError while leaving an authenticated Pending waiting.
    const inlineTooLarge=didSucceed
      && (oversizedInline(result) || oversizedInline(rawSubmission));
    const submission=inlineTooLarge ? null : copy(rawSubmission);
    if (versioned) assertSHA256(submissionDigest);
    const digest=inlineTooLarge ? null : (submissionDigest??fingerprint(submission));
    for (;;) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible');
      if (cp.status==='cancelled') throw failure('FK_I_STALE_RECEIPT','Run has been terminated');
      const program=await loadPinned(cp);
      const receiptLookup=store.getReceipt(runId,requestId);
      const already=versioned ? await receiptLookup : receiptLookup;
      if (already) {
        if (already.subjectId && already.subjectId!==subjectId) {
          throw failure('FK_I_HOST_DENIED','Receipt belongs to a different submitting Host');
        }
        if (already.digest!==digest || (already.nodeId!==undefined && already.nodeId!==nodeId)
          || (already.attempt!==undefined && already.attempt!==attempt)) {
          throw failure('FK_I_RECEIPT_CONFLICT','Different receipt with accepted requestId');
        }
        if (stepKind==='human' && already.humanProof?.subjectId!==humanProof.subjectId) {
          throw failure('FK_I_HOST_DENIED','Human receipt belongs to a different authorized subject');
        }
        const current=await drive(runId);
        return {acceptedRevision:already.acceptedRevision,...current,duplicate:true};
      }
      if (runDeadlineExpired(cp)) {
        await drive(runId);
        throw failure('FK_I_STALE_RECEIPT','Run deadline expired');
      }
      if (cp.parallel) {
        if (inlineTooLarge) throw failure('FK_I_CHECKPOINT_CAPACITY','Parallel receipt is too large');
        const expired=cp.parallel.structured ? null : await expireParallelAgents(cp);
        if (expired) continue;
        let persisted;
        try {
          persisted=cp.parallel.structured
            ? await acceptStructured(cp,program,submission,digest,operationSafety,subjectId,humanProof,receivedPayload)
            : await acceptParallel(cp,program,submission,digest,operationSafety,subjectId);
        }
        catch (error) {
          if (error.code==='FK_I_OPERATION_CHANGED' && operationSafety!=='unclaimed') continue;
          throw error;
        }
        if (!persisted.committed) continue;
        if (persisted.capacityExit) throw failure('FK_I_CHECKPOINT_CAPACITY','Parallel receipt exceeded capacity');
        return {acceptedRevision:persisted.checkpoint.revision,...await drive(runId),duplicate:false};
      }
      if (cp.status!=='waiting' || cp.phase!=='awaiting') {
        throw failure('FK_I_STALE_RECEIPT','Only currently published Agent request can be completed');
      }
      const pending=cp.pending;
      const frame=cp.controlStack.at(-1);
      const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
      if (!pending || !frame || pending.kind!==stepKind
        || pending.requestId!==requestId || pending.nodeId!==nodeId
        || pending.attempt!==attempt || frame.nodeId!==nodeId
        || frame.attempt!==attempt || block.nodeId!==nodeId) {
        throw failure('FK_I_STALE_RECEIPT','Wrong request, node, attempt, or exhausted ledger');
      }
      const accept=block.acceptTarget;
      if (!block.legalTargets.includes(accept) || accept!==nodeId+'::validate') {
        throw failure('FK_I_INVALID_TRANSITION','Awaiting receipt target is not certified');
      }
      // An authenticated Host may signal a business artifact by a small
      // reference. FlowKit never stores oversized inline results or invents
      // an external business-data provider. The durable failure is NOT an Ack.
      if (inlineTooLarge) {
        const terminal=await failRun(cp,'FK_I_CHECKPOINT_CAPACITY','capacity-terminal');
        if (!terminal.committed) continue;
        throw failure('FK_I_CHECKPOINT_CAPACITY',
          'inline result exceeds the configured execution budget; Run is errored');
      }
      if (stepKind==='agent' && cp.program.implementedStage!=='P0-A' && didSucceed) {
        const effects=await store.parallelEffects(cp.runId,[requestId]);
        if (effects.some(effect=>!effect.settlement)) {
          throw failure('FK_I_RECONCILIATION_PENDING','Agent has an unsettled external write');
        }
        operationSafety='settled';
      }
      const ledgerEntry={requestId,nodeId,attempt,digest,acceptedRevision:cp.revision+1};
      const next={
        ...cp,revision:cp.revision+1,blockId:accept,phase:'validate',
        status:'running',pending:null,prepared:null,receiptCount:cp.receiptCount+1,
        receivedSubmission:{kind:stepKind,requestId,activation:frame.activation,attempt,
          canonicalDigest:digest,acceptedRevision:cp.revision+1,payload:receivedPayload??submission,
          receivedAt:new Date().toISOString(),...(stepKind==='human'?{humanProof}:{})},
        candidate:{kind:stepKind,requestId,nodeId,attempt,
          submissionKind:kind,
          ...(didSucceed?{result:submission.result}
            :{failure:submission.failure}),validated:false},
      };
      const persisted=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
        nextCheckpoint:next,
        journalEntry:{kind:'receipt-accepted',stepKind,nodeId,attempt,requestId,digest,
          ...(subjectId?{subjectId}:{}),
          ...(operationSafety?{operationSafety}:{})}},
        {kind:'receipt-accepted',requestId,nodeId,attempt,submissionDigest:digest,
          ...(stepKind==='human'?{humanProof}:{})},
        {kind:'accept-receipt',toBlockId:accept,submissionDigest:digest},
        didSucceed?'succeeded':'failed');
      if (!persisted.committed) continue;
      if (persisted.capacityExit) {
        throw failure('FK_I_CHECKPOINT_CAPACITY',
          'receipt could not be accepted; Run is durably errored');
      }
      const current=await drive(runId);
      return {acceptedRevision:ledgerEntry.acceptedRevision,...current,duplicate:false};
    }
  }

  /** Host-only durable reservations for extra Provider calls; retrying one reservation is idempotent. */
  async function reserveDispatch({runId,requestId,operationId}={}) {
    nonempty(runId,'runId');nonempty(requestId,'requestId');nonempty(operationId,'operationId');
    for (;;) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible');
      await loadPinned(cp);
      if (!publishedInteractivePending(cp).some(task=>task.requestId===requestId&&task.preparedTask) || !cp.taskContext) {
        throw failure('FK_I_STALE_RECEIPT','Dispatch reservation requires the current Task V2 Pending');
      }
      if (cp.taskContext.deadlineMs<=Date.now()) throw failure('FK_R004','Task dispatch deadline expired');
      const key=fingerprint([requestId,operationId]);
      const reservations=cp.taskContext.reservations ?? [];
      if (reservations.includes(key)) return {deadlineMs:cp.taskContext.deadlineMs,dispatches:cp.taskContext.dispatches};
      const budget=createBudget(policySnapshot.taskPolicy ?? {},signal,cp.taskContext);budget.dispatch();
      const next={...cp,revision:cp.revision+1,taskContext:{...cp.taskContext,...budget.snapshot(),reservations:[...reservations,key]}};
      const saved=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,nextCheckpoint:next,
        journalEntry:{kind:'dispatch-reserved',requestId,reservation:key}},
        {kind:'dispatch-reserved',requestId,reservation:key},{kind:'dispatch-reserved'});
      if (!saved.committed) continue;
      if (saved.capacityExit) throw failure('FK_I_CHECKPOINT_CAPACITY','Dispatch reservation could not be persisted');
      return budget.snapshot();
    }
  }

  async function resume({runId}={}) { nonempty(runId,'runId');return drive(runId); }
  async function load({runId}={}) {
    nonempty(runId,'runId');
    checkSignal();
    const cp=versioned ? await store.load(runId) : store.load(runId);
    if (!cp) return null;
    if (cp.status!=='cancelled' || cp.namespace!==store.namespace || cp.policyHash!==policyHash) await loadPinned(cp);
    return asPublicFrame(cp);
  }

  return Object.freeze({start,complete,resume,load,reserveDispatch,policyHash});
}
