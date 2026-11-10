import {randomUUID} from 'node:crypto';
import {canonicalBytes, safeJSONSnapshot, sha256Bytes, assertSHA256} from './canonical.mjs';
import {loadInteractiveProgram} from './load.mjs';

const FINISHED = new Set(['succeeded','failed','errored']);
const MAX_RECEIPTS = 128;
const MAX_REASONS = 32;
const MAX_REASON_LENGTH = 512;

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
function stableTransitionId(cp, kind) {
  return 't:' + fingerprint([cp.namespace,cp.runId,cp.revision,cp.blockId,kind]).slice(7);
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
  const frames = cp.controlStack;
  if (!Array.isArray(frames) || frames.length > 1 || frames.some(x=>x.kind!=='agent')) {
    throw failure('FK_I_INVALID_CHECKPOINT','illegal P0-A control stack');
  }
  if (record.kind === 'agent' && cp.phase !== 'enter') {
    const frame = frames.at(-1);
    if (!frame || frame.nodeId !== block.nodeId || !Number.isSafeInteger(frame.activation)
      || frame.activation < 1 || !Number.isSafeInteger(frame.attempt)
      || frame.attempt < 1 || frame.attempt > record.metadata.retries + 1
      || !Array.isArray(frame.reasons)) {
      throw failure('FK_I_INVALID_CHECKPOINT','invalid current Agent frame');
    }
  }
  if (cp.status === 'waiting') {
    if (cp.phase !== 'awaiting' || cp.pending?.requestId == null || cp.candidate != null) {
      throw failure('FK_I_INVALID_CHECKPOINT','waiting without certified pending request');
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
  if (!Array.isArray(cp.receipts) || cp.receipts.length > MAX_RECEIPTS
    || !Number.isSafeInteger(cp.activationSeq) || cp.activationSeq < 0) {
    throw failure('FK_I_INVALID_CHECKPOINT','invalid receipt ledger or activation counter');
  }
  return {block,record};
}
function certifiedProposal(cp, program, event, proposal) {
  const {block} = confirmCurrentBlock(cp,program);
  if (!block.eventKinds.includes(event.kind)
    || !proposal || proposal.fromBlockId !== cp.blockId
    || proposal.nodeId !== block.nodeId
    || !block.proposalKinds.includes(proposal.kind)) {
    throw failure('FK_I_INVALID_TRANSITION','Program returned uncertified proposal');
  }
  if (proposal.kind === 'terminal' || proposal.kind === 'raise-error') {
    if (proposal.toBlockId != null) {
      throw failure('FK_I_INVALID_TRANSITION','terminal and error must have no successor');
    }
  } else if (!block.legalTargets.includes(proposal.toBlockId)) {
    throw failure('FK_I_INVALID_TRANSITION','Program target not in legalTargets');
  }
  if (proposal.stackEffect?.kind !== 'none'
    && !['push','pop','update'].includes(proposal.stackEffect?.kind)) {
    throw failure('FK_I_INVALID_TRANSITION','invalid control stack effect');
  }
  if (proposal.mergeIntent?.kind !== 'none'
    && proposal.mergeIntent?.kind !== 'commit-candidate') {
    throw failure('FK_I_INVALID_TRANSITION','invalid merge intent');
  }
  return proposal;
}
function applyStack(cp, effect) {
  const frames = copy(cp.controlStack);
  if (effect.kind === 'none') return frames;
  if (effect.kind === 'push') {
    if (frames.length || effect.frame?.kind !== 'agent'
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
  return copy({
    namespace:cp.namespace,runId:cp.runId,status:cp.status,revision:cp.revision,
    ...(FINISHED.has(cp.status) ? {state:cp.state} : {}),
    ...(cp.status === 'waiting' ? {pending:cp.pending} : {}),
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
  if (runtime.checkStep !== undefined) {
    throw failure('FK_I_UNSUPPORTED_GRAPH','P0-A cannot silently skip checkStep');
  }
  for (const binding of program.programTable.requiredBindings) {
    if (binding.id === 'runtime.validateResult' && typeof runtime.validateResult !== 'function'
      || binding.id === 'runtime.skillResolver' && typeof runtime.skillResolver !== 'function') {
      throw failure('FK_I_BINDING_MISSING','Required P0-A binding ' + binding.id);
    }
  }
}
function initialCheckpoint(namespace, runId, program, policyHash, state) {
  return {
    schemaVersion:1,namespace,runId,revision:0,
    artifactHash:program.artifactHash,policyHash,status:'running',
    blockId:program.programTable.entryBlockId,
    phase:'enter',state:copy(state),
    controlStack:[],activationSeq:0,receipts:[],
    pending:null,prepared:null,candidate:null,terminal:null,
    contextError:null,
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
export function createInteractiveCoordinator({store, runtime, policy = {}, maxStagesPerCall = 128} = {}) {
  if (!store || typeof store.load !== 'function'
    || typeof store.createRun !== 'function'
    || typeof store.compareAndSwap !== 'function'
    || typeof store.putArtifact !== 'function'
    || typeof store.getArtifact !== 'function') {
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
  });
  const policySnapshot = copy(policy);
  const policyHash = fingerprint(policySnapshot);
  const stageBudget = validStageCount(maxStagesPerCall);

  async function loadPinned(cp) {
    if (cp.namespace !== store.namespace || cp.policyHash !== policyHash) {
      throw failure('FK_I_POLICY_MISMATCH','Run policy and namespace must match');
    }
    assertSHA256(cp.artifactHash);
    const saved = store.getArtifact(cp.artifactHash);
    if (!saved || saved.programIdentity.artifactHash !== cp.artifactHash) {
      throw failure('FK_I_PROGRAM_MISMATCH','Missing compiled Program bytes');
    }
    const program = await loadInteractiveProgram(saved.bytes,cp.artifactHash);
    const declared = {...program.interactiveProgram.identity,artifactHash:cp.artifactHash};
    if (canonicalBytes(declared).toString('hex')
      !== canonicalBytes(saved.programIdentity).toString('hex')) {
      throw failure('FK_I_PROGRAM_MISMATCH','Stored Program manifest mismatch');
    }
    assertRuntime(program,execution);
    confirmCurrentBlock(cp,program);
    return program;
  }

  function advanceSafely(cp, program, event) {
    try {
      const proposal = program.advance(programView(cp),event);
      return certifiedProposal(cp,program,event,proposal);
    } catch(error) {
      if (error?.code === 'FK_R002') {
        return certifiedProposal(cp,program,internalEvent(cp,'deterministic-failure',{error:{code:'FK_R002'}}),
          program.advance(programView(cp),internalEvent(cp,'deterministic-failure',{error:{code:'FK_R002'}})));
      }
      throw error;
    }
  }
  function stepCAS(cp, proposal, eventKind, extras={}) {
    const next = {...cp,revision:cp.revision+1};
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
      next.pending=cp.prepared;next.prepared=null;
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
    if (proposal.kind === 'prepare-pending') {
      if (!extras.prepared) throw failure('FK_I_INVALID_CHECKPOINT','prepared data missing');
      next.prepared=copy(extras.prepared);
    }
    if (proposal.kind === 'move' && cp.phase === 'enter' && cp.blockId !== next.blockId
      && proposal.stackEffect.kind === 'push') {
      next.activationSeq=cp.activationSeq+1;
    }
    const transitionId=stableTransitionId(cp,eventKind + '/' + proposal.kind);
    const write=store.compareAndSwap({
      runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,transitionId,
      journalEntry:{
        kind:proposal.kind,event:eventKind,from:cp.blockId,
        to:proposal.toBlockId ?? null,causeCode:proposal.causeCode ?? null,
      },
    });
    return write;
  }

  async function makePrepared(cp,program) {
    const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
    const node=program.programTable.nodes[block.nodeId];
    const frame=cp.controlStack.at(-1);
    if (node.kind!=='agent' || cp.phase!=='prepare' || !frame) {
      throw failure('FK_I_INVALID_CHECKPOINT','not at Agent prepare phase');
    }
    const instruction = await execution.skillResolver(Object.freeze(copy({
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
      kind:'agent',runId:cp.runId,nodeId:block.nodeId,
      name:node.metadata.name,requestId,attempt:frame.attempt,
      instruction,input,missing,resultSchema:node.metadata.output,
      reasons:frame.reasons,
      ...(node.metadata.overview ? {overview:{step:frame.overviewStep}} : {}),
    });
  }

  async function validateCandidate(cp,program) {
    if (cp.phase!=='validate' || cp.candidate?.kind!=='agent'
      || cp.candidate.requestId == null || cp.candidate.validated === true) {
      throw failure('FK_I_INVALID_CHECKPOINT','unvalidated candidate required');
    }
    const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
    const schema=copy(program.programTable.nodes[block.nodeId].metadata.output);
    if (cp.candidate.submissionKind === 'agent-call-failed') {
      return {kind:'agent-call-failed',reasons: ['runAgent threw: ' +
        (cp.candidate.failure?.message ?? 'Agent call failed').slice(0,MAX_REASON_LENGTH-16)]};
    }
    let reasons;
    try {
      reasons=execution.validateResult(schema,copy(cp.candidate.result));
      if (reasons && typeof reasons.then === 'function') {
        throw failure('FK_I_VALIDATOR_CONTRACT','validateResult must be synchronous and pure');
      }
      reasons=reasonsFromValidation(reasons);
    } catch {
      return {kind:'deterministic-failure',causeCode:'FK_I_VALIDATOR_CONTRACT'};
    }
    return reasons.length
      ? {kind:'validation-rejected',reasons}
      : {kind:'validation-passed',reasons:[]};
  }

  async function drive(runId) {
    for (let count=0; count < stageBudget; ) {
      const cp=store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible in this namespace');
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status) || cp.status==='waiting') return asPublicFrame(cp);
      if (cp.status === 'paused') {
        if (!['stage-budget','skill-temporary'].includes(cp.pauseReason)) return asPublicFrame(cp);
        const unpause={...cp,status:'running',revision:cp.revision+1,pauseReason:null};
        const committed=store.compareAndSwap({runId,expectedRevision:cp.revision,
          nextCheckpoint:unpause,transitionId:stableTransitionId(cp,'resume-budget'),
          journalEntry:{kind:'resume-budget'}});
        if (!committed.committed) continue;
        // Budget unpause is a control action, not a Program stage.
        continue;
      }
      const {block}=confirmCurrentBlock(cp,program);
      if (cp.phase === 'awaiting') {
        throw failure('FK_I_INVALID_CHECKPOINT','awaiting without waiting Pending');
      }
      let event,proposal,extras={};
      if (cp.phase === 'prepare') {
        let prepared;
        try { prepared=await makePrepared(cp,program); }
        catch (error) {
          if (['FK_R014','FK_I_TEMPORARY_SKILL'].includes(error?.code)) {
            const paused={...cp,revision:cp.revision+1,status:'paused',
              pauseReason:'skill-temporary'};
            const result=store.compareAndSwap({runId,expectedRevision:cp.revision,
              nextCheckpoint:paused,transitionId:stableTransitionId(cp,'pause-skill'),
              journalEntry:{kind:'pause',reason:'skill-temporary'}});
            if (!result.committed) continue;
            return asPublicFrame(result.checkpoint);
          }
          const causeCode=error?.code==='FK_R010' || error?.code==='FK_R011'
            ? error.code : 'FK_I_SKILL_CONTRACT';
          event=internalEvent(cp,'deterministic-failure',{error:{code:causeCode}});
          proposal=advanceSafely(cp,program,event);
        }
        if (prepared) {
          event=internalEvent(cp,'internal-step');
          proposal=advanceSafely(cp,program,event);
          extras.prepared=prepared;
        }
      } else if (cp.phase === 'validate') {
        const evaluation=await validateCandidate(cp,program);
        event=evaluation.kind === 'deterministic-failure'
          ? internalEvent(cp,'deterministic-failure',{error:{code:evaluation.causeCode}})
          : internalEvent(cp,evaluation.kind);
        proposal=advanceSafely(cp,program,event);
        if (evaluation.reasons?.length) extras.retryReasons=evaluation.reasons;
      } else {
        const kind=cp.phase==='dispatch-ready' ? 'pending-prepared' : 'internal-step';
        const extra=cp.phase==='enter' && block.nodeId in program.programTable.nodes
          && program.programTable.nodes[block.nodeId].kind==='agent'
          ? {activation:cp.activationSeq+1} : {};
        event=internalEvent(cp,kind,extra);
        proposal=advanceSafely(cp,program,event);
      }
      const advanced=stepCAS(cp,proposal,event.kind,extras);
      if (!advanced.committed) continue;
      count++;
      if (FINISHED.has(advanced.checkpoint.status) || advanced.checkpoint.status==='waiting') {
        return asPublicFrame(advanced.checkpoint);
      }
    }
    // A stage budget is observable and resumable. Never misreport it as waiting.
    for (;;) {
      const cp=store.load(runId);
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status) || cp.status==='waiting' || cp.status==='paused') {
        return asPublicFrame(cp);
      }
      const paused={...cp,revision:cp.revision+1,status:'paused',
        pauseReason:'stage-budget'};
      const result=store.compareAndSwap({runId,expectedRevision:cp.revision,
        nextCheckpoint:paused,transitionId:stableTransitionId(cp,'pause-budget'),
        journalEntry:{kind:'pause',reason:'stage-budget'}});
      if (result.committed) return asPublicFrame(result.checkpoint);
    }
  }

  /** Register compiler-verified bytes before the idempotent start transaction. */
  async function start({programBytes,programIdentity,startKey,runId=randomUUID(),state={},startIntent=null}={}) {
    nonempty(startKey,'startKey');nonempty(runId,'runId');
    if (!(programBytes instanceof Uint8Array) || !programIdentity) {
      throw new TypeError('Compiler Program bytes and identity are required');
    }
    const byteSnapshot=Buffer.from(programBytes);
    const declared=copy(programIdentity);
    assertSHA256(declared.artifactHash);
    const program=await loadInteractiveProgram(byteSnapshot,declared.artifactHash);
    if (!canonicalBytes({...program.interactiveProgram.identity,artifactHash:declared.artifactHash})
      .equals(canonicalBytes(declared))) {
      throw failure('FK_I_PROGRAM_MISMATCH','identity and verified Program differ');
    }
    assertRuntime(program,execution); // before any mutation, reject unavailable Stage bindings
    const initial=initialCheckpoint(store.namespace,runId,program,policyHash,state);
    const intent=copy(startIntent);
    store.putArtifact({programIdentity:declared,bytes:byteSnapshot});
    const opened=store.createRun({startKey,startIntent:intent,checkpoint:initial});
    return drive(opened.checkpoint.runId);
  }

  /** Only a trusted Host may call complete; M5 will bind provenance/transport. */
  async function complete({runId,requestId,nodeId,attempt,kind='agent-result',result,failure:callFailure}={}) {
    nonempty(runId,'runId');nonempty(requestId,'requestId');nonempty(nodeId,'nodeId');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('Invalid Agent attempt');
    if (!['agent-result','agent-call-failed'].includes(kind)) {
      throw failure('FK_I_INVALID_RECEIPT','Unsupported P0-A receipt type');
    }
    const submission=copy(kind==='agent-result'
      ? {runId,requestId,nodeId,attempt,kind,result}
      : {runId,requestId,nodeId,attempt,kind,failure:callFailure});
    const digest=fingerprint(submission);
    for (;;) {
      const cp=store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible');
      const program=await loadPinned(cp);
      const already=cp.receipts.find(r=>r.requestId===requestId);
      if (already) {
        if (already.digest!==digest || already.nodeId!==nodeId || already.attempt!==attempt) {
          throw failure('FK_I_RECEIPT_CONFLICT','Different receipt with accepted requestId');
        }
        const current=await drive(runId);
        return {acceptedRevision:already.acceptedRevision,...current,duplicate:true};
      }
      if (cp.status!=='waiting' || cp.phase!=='awaiting') {
        throw failure('FK_I_STALE_RECEIPT','Only currently published Agent request can be completed');
      }
      const pending=cp.pending;
      const frame=cp.controlStack.at(-1);
      const block=program.programTable.blocks.find(b=>b.id===cp.blockId);
      if (!pending || !frame || pending.kind!=='agent'
        || pending.requestId!==requestId || pending.nodeId!==nodeId
        || pending.attempt!==attempt || frame.nodeId!==nodeId
        || frame.attempt!==attempt || block.nodeId!==nodeId
        || cp.receipts.length >= MAX_RECEIPTS) {
        throw failure('FK_I_STALE_RECEIPT','Wrong request, node, attempt, or exhausted ledger');
      }
      const accept=block.acceptTarget;
      if (!block.legalTargets.includes(accept) || accept!==nodeId+'::validate') {
        throw failure('FK_I_INVALID_TRANSITION','Awaiting receipt target is not certified');
      }
      const ledgerEntry={requestId,nodeId,attempt,digest,acceptedRevision:cp.revision+1};
      const next={
        ...cp,revision:cp.revision+1,blockId:accept,phase:'validate',
        status:'running',pending:null,prepared:null,
        candidate:{kind:'agent',requestId,nodeId,attempt,
          submissionKind:kind,
          ...(kind==='agent-result'?{result:submission.result}
            :{failure:submission.failure}),validated:false},
        receipts:[...cp.receipts,ledgerEntry],
      };
      const persisted=store.compareAndSwap({runId,expectedRevision:cp.revision,
        nextCheckpoint:next,transitionId:stableTransitionId(cp,'receipt:'+requestId),
        journalEntry:{kind:'receipt-accepted',nodeId,attempt,requestId,digest}});
      if (!persisted.committed) continue;
      const current=await drive(runId);
      return {acceptedRevision:ledgerEntry.acceptedRevision,...current,duplicate:false};
    }
  }

  async function resume({runId}={}) { nonempty(runId,'runId');return drive(runId); }
  async function load({runId}={}) {
    nonempty(runId,'runId');
    const cp=store.load(runId);
    if (!cp) return null;
    await loadPinned(cp);
    return asPublicFrame(cp);
  }

  return Object.freeze({start,complete,resume,load,policyHash});
}
