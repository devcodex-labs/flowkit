import {randomUUID} from 'node:crypto';
import {MAX_INLINE_AGENT_RESULT_BYTES, canonicalBytes, safeJSONSnapshot, sha256Bytes, assertSHA256} from './canonical.mjs';
import {loadInteractiveProgram} from './load.mjs';

const FINISHED = new Set(['succeeded','failed','errored']);
// P0-A has at most 500 static nodes and 11 attempts per Agent.
// Do not cap legitimate 500-node workflows below their worst-case 5,500 receipts.
const MAX_RECEIPTS = 8192;
const MAX_INLINE_RECEIPT_CACHE = 16;
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
  if (runtime.checkStep !== undefined
    && program.programTable.requiredBindings.length > 0) {
    throw failure('FK_I_UNSUPPORTED_GRAPH','P0-A cannot silently skip Agent checkStep');
  }
  for (const binding of program.programTable.requiredBindings) {
    if (binding.id === 'runtime.validateResult' && typeof runtime.validateResult !== 'function'
      || binding.id === 'runtime.skillResolver' && typeof runtime.skillResolver !== 'function') {
      throw failure('FK_I_BINDING_MISSING','Required P0-A binding ' + binding.id);
    }
  }
}
function initialCheckpoint(namespace, runId, program, policyHash, state) {
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
    artifactHash:program.artifactHash,policyHash,status:'running',
    blockId:program.programTable.entryBlockId,
    phase:'enter',state:snapshot,
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
export function createInteractiveCoordinator(options) {
  return buildCoordinator(options, false);
}

export function buildCoordinator({store, runtime, policy = {}, maxStagesPerCall = 128, signal} = {}, versioned) {
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
  // Only verified immutable Program objects are cached, never Store records.
  // Even on a cache hit every stage re-reads the Host's Store, checks exact
  // Program bytes and identity, then verifies the current Run phase/policy.
  // Small fixed LRU avoids a broad, implicit process-global cache.
  const verifiedPrograms = new Map();
  const MAX_VERIFIED_PROGRAMS = 4;
  function checkSignal() { signal?.throwIfAborted(); }

  async function loadPinned(cp) {
    if (!versioned && cp.transitionIdVersion!==undefined) {
      throw failure('FK_I_POLICY_MISMATCH','versioned Run requires the asynchronous SDK');
    }
    if (cp.namespace !== store.namespace || cp.policyHash !== policyHash) {
      throw failure('FK_I_POLICY_MISMATCH','Run policy and namespace must match');
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
    confirmCurrentBlock(cp,program);
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
    if (cp.transitionIdVersion===undefined) return store.compareAndSwap(versioned ? {...args,fromBlockId:cp.blockId} : args);
    if (cp.transitionIdVersion!==1) throw failure('FK_I_INVALID_CHECKPOINT','unknown transition ID version');
    const eventDigest=event.eventDigest ?? fingerprint(event);
    const proposalDigest=fingerprint(proposal);
    const transitionId=fingerprint([cp.namespace,cp.runId,cp.revision,cp.blockId,
      eventDigest,cp.artifactHash,proposalDigest]);
    const transition={
      namespace:cp.namespace,runId:cp.runId,transitionId,
      fromRevision:cp.revision,toRevision:args.nextCheckpoint.revision,
      fromBlockId:cp.blockId,toBlockId:proposal.kind==='terminal'||proposal.kind==='raise-error'
        || proposal.kind==='capacity-terminal' ? null : args.nextCheckpoint.blockId,
      programHash:cp.artifactHash,eventDigest,proposalDigest,committedAt:new Date().toISOString(),
    };
    return store.compareAndSwap({...args,transitionId,journalEntry:{
      ...args.journalEntry,transition,...(receiptOutcome ? {receiptOutcome} : {}),
    }});
  }
  async function failCapacity(cp) {
    if (FINISHED.has(cp.status)) return {committed:false,checkpoint:cp};
    const nodeId=cp.blockId.slice(0,cp.blockId.lastIndexOf('::'));
    const next={
      ...cp,revision:cp.revision+1,status:'errored',
      terminal:{status:'errored',nodeId,causeCode:'FK_I_CHECKPOINT_CAPACITY'},
      pending:null,prepared:null,candidate:null,
      pauseReason:null,
    };
    // This terminal transition may use the Store's reserved 256 KiB; it
    // never drops State or accepted receipt identities.
    return writeTransition(cp,{
      runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,
      transitionId:stableTransitionId(cp,'capacity-terminal'),
      journalEntry:{kind:'capacity-terminal',causeCode:'FK_I_CHECKPOINT_CAPACITY',
        from:cp.blockId},
    },{kind:'capacity-terminal'},{kind:'capacity-terminal',causeCode:'FK_I_CHECKPOINT_CAPACITY'});
  }
  async function casOrCapacityExit(cp, args, event, proposal, receiptOutcome) {
    try { return await writeTransition(cp,args,event,proposal,receiptOutcome); }
    catch(error) {
      if (error?.code!=='FK_I_CHECKPOINT_CAPACITY') throw error;
      const terminal=await failCapacity(cp);
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

  function stepCAS(cp, proposal, event, legacyEventKind, extras={}) {
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
    const transitionId=stableTransitionId(cp,legacyEventKind + '/' + proposal.kind);
    const write=casOrCapacityExit(cp,{
      runId:cp.runId,expectedRevision:cp.revision,nextCheckpoint:next,transitionId,
      journalEntry:{
        kind:proposal.kind,event:legacyEventKind,from:cp.blockId,
        to:proposal.toBlockId ?? null,causeCode:proposal.causeCode ?? null,
      },
    },Object.keys(extras).length ? {
      eventDigest:fingerprint([event.eventDigest,extras]),
    } : event,proposal);
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
      kind:'agent',runId:cp.runId,nodeId:block.nodeId,id:block.nodeId,
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
    } catch {
      return {kind:'deterministic-failure',causeCode:'FK_I_VALIDATOR_CONTRACT'};
    }
    return reasons.length
      ? {kind:'validation-rejected',reasons}
      : {kind:'validation-passed',reasons:[]};
  }

  async function drive(runId) {
    for (let count=0; count < stageBudget; ) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible in this namespace');
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status) || cp.status==='waiting') return asPublicFrame(cp);
      if (cp.status === 'paused') {
        if (!['stage-budget','skill-temporary'].includes(cp.pauseReason)) return asPublicFrame(cp);
        const unpause={...cp,status:'running',revision:cp.revision+1,pauseReason:null};
        const committed=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
          nextCheckpoint:unpause,transitionId:stableTransitionId(cp,'resume-budget'),
          journalEntry:{kind:'resume-budget'}},{kind:'resume-budget'},{kind:'resume-budget'});
        if (!committed.committed) continue;
        // Budget unpause is a control action, not a Program stage.
        continue;
      }
      const {block}=confirmCurrentBlock(cp,program);
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
              nextCheckpoint:paused,transitionId:stableTransitionId(cp,'pause-skill'),
              journalEntry:{kind:'pause',reason:'skill-temporary'}},
              {kind:'skill-temporary'},{kind:'pause',reason:'skill-temporary'});
            if (!result.committed) continue;
            return asPublicFrame(result.checkpoint);
          }
          const causeCode=error?.code==='FK_R010' || error?.code==='FK_R011'
            ? error.code : 'FK_I_SKILL_CONTRACT';
          event=internalEvent(cp,'deterministic-failure',{error:{code:causeCode}});
        }
        if (prepared) {
          event=internalEvent(cp,'internal-step');
          extras.prepared=prepared;
        }
      } else if (cp.phase === 'validate') {
        const evaluation=await validateCandidate(cp,program);
        event=evaluation.kind === 'deterministic-failure'
          ? internalEvent(cp,'deterministic-failure',{error:{code:evaluation.causeCode}})
          : internalEvent(cp,evaluation.kind);
        if (evaluation.reasons?.length) extras.retryReasons=evaluation.reasons;
      } else {
        const kind=cp.phase==='dispatch-ready' ? 'pending-prepared' : 'internal-step';
        const extra=cp.phase==='enter' && block.nodeId in program.programTable.nodes
          && program.programTable.nodes[block.nodeId].kind==='agent'
          ? {activation:cp.activationSeq+1} : {};
        event=internalEvent(cp,kind,extra);
      }
      const certified=advanceSafely(cp,program,event);
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
      const program=await loadPinned(cp);
      if (FINISHED.has(cp.status) || cp.status==='waiting' || cp.status==='paused') {
        return asPublicFrame(cp);
      }
      const paused={...cp,revision:cp.revision+1,status:'paused',
        pauseReason:'stage-budget'};
      const result=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
        nextCheckpoint:paused,transitionId:stableTransitionId(cp,'pause-budget'),
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
    if (!canonicalBytes({...program.interactiveProgram.identity,artifactHash:declared.artifactHash})
      .equals(canonicalBytes(declared))) {
      throw failure('FK_I_PROGRAM_MISMATCH','identity and verified Program differ');
    }
    assertRuntime(program,execution); // before any mutation, reject unavailable Stage bindings
    const initial=initialCheckpoint(store.namespace,runId,program,policyHash,stateSnapshot);
    checkSignal();
    const registered=store.putArtifact({programIdentity:declared,bytes:byteSnapshot});
    if (versioned) {
      await registered;
      initial.transitionIdVersion=1;
    }
    checkSignal();
    const opening=store.createRun({startKey,startIntent:intentSnapshot,checkpoint:initial});
    const opened=versioned ? await opening : opening;
    if (versioned && !opened.created) await authorizeExisting(opened.checkpoint.runId);
    return drive(opened.checkpoint.runId);
  }

  /** Only a trusted Host may call complete; M5 will bind provenance/transport. */
  async function complete({runId,requestId,nodeId,attempt,kind='agent-result',result,failure:callFailure,
    submissionDigest}={}) {
    nonempty(runId,'runId');nonempty(requestId,'requestId');nonempty(nodeId,'nodeId');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('Invalid Agent attempt');
    if (!['agent-result','agent-call-failed'].includes(kind)) {
      throw failure('FK_I_INVALID_RECEIPT','Unsupported P0-A receipt type');
    }
    let safeFailure;
    if (kind === 'agent-call-failed') {
      safeFailure=copy(callFailure);
      if (!safeFailure || typeof safeFailure !== 'object' || Array.isArray(safeFailure)
        || typeof safeFailure.message !== 'string' || !safeFailure.message.length
        || safeFailure.message.length > 4096 || Object.keys(safeFailure).length !== 1) {
        throw failure('FK_I_INVALID_RECEIPT','Agent failure requires bounded {message:string}');
      }
    }
    // Size-only rejection must not require serializing an enormous receipt
    // into the 2 MiB Checkpoint budget before we can mark a matched Run errored.
    const rawSubmission=kind==='agent-result'
      ? {runId,requestId,nodeId,attempt,kind,result}
      : {runId,requestId,nodeId,attempt,kind,failure:safeFailure};
    // Both the value AND its actual receipt envelope must be serializable
    // under the protocol's 2 MiB bound. Otherwise snapshotting first would
    // throw a raw RangeError while leaving an authenticated Pending waiting.
    const inlineTooLarge=kind==='agent-result'
      && (oversizedInline(result) || oversizedInline(rawSubmission));
    const submission=inlineTooLarge ? null : copy(rawSubmission);
    if (versioned) assertSHA256(submissionDigest);
    const legacyDigest=inlineTooLarge ? null : fingerprint(submission);
    for (;;) {
      checkSignal();
      const cp=versioned ? await store.load(runId) : store.load(runId);
      if (!cp) throw failure('FK_I_RUN_NOT_FOUND','run is not accessible');
      const program=await loadPinned(cp);
      const digest=inlineTooLarge ? null : (cp.transitionIdVersion===1 ? submissionDigest : legacyDigest);
      const indexed=typeof store.getReceipt==='function';
      const receiptLookup=indexed ? store.getReceipt(runId,requestId) : null;
      const already=(versioned ? await receiptLookup : receiptLookup)
        ?? cp.receipts.find(r=>r.requestId===requestId);
      if (already) {
        if (already.digest!==digest || (cp.transitionIdVersion===undefined
          && (already.nodeId!==nodeId || already.attempt!==attempt))) {
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
        || (!indexed && cp.receipts.length >= MAX_RECEIPTS)) {
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
        const terminal=await failCapacity(cp);
        if (!terminal.committed) continue;
        throw failure('FK_I_CHECKPOINT_CAPACITY',
          'inline result exceeds the configured execution budget; Run is errored');
      }
      const ledgerEntry={requestId,nodeId,attempt,digest,acceptedRevision:cp.revision+1};
      const next={
        ...cp,revision:cp.revision+1,blockId:accept,phase:'validate',
        status:'running',pending:null,prepared:null,
        candidate:{kind:'agent',requestId,nodeId,attempt,
          submissionKind:kind,
          ...(kind==='agent-result'?{result:submission.result}
            :{failure:submission.failure}),validated:false},
        receipts:indexed
          ? [...cp.receipts.slice(-(MAX_INLINE_RECEIPT_CACHE-1)),ledgerEntry]
          : [...cp.receipts,ledgerEntry],
      };
      const persisted=await casOrCapacityExit(cp,{runId,expectedRevision:cp.revision,
        nextCheckpoint:next,transitionId:stableTransitionId(cp,'receipt:'+requestId),
        journalEntry:{kind:'receipt-accepted',nodeId,attempt,requestId,digest}},
        {kind:'receipt-accepted',requestId,nodeId,attempt,submissionDigest:digest},
        {kind:'accept-receipt',toBlockId:accept,submissionDigest:digest},
        kind==='agent-result'?'succeeded':'failed');
      if (!persisted.committed) continue;
      if (persisted.capacityExit) {
        throw failure('FK_I_CHECKPOINT_CAPACITY',
          'receipt could not be accepted; Run is durably errored');
      }
      const current=await drive(runId);
      return {acceptedRevision:ledgerEntry.acceptedRevision,...current,duplicate:false};
    }
  }

  async function resume({runId}={}) { nonempty(runId,'runId');return drive(runId); }
  async function load({runId}={}) {
    nonempty(runId,'runId');
    checkSignal();
    const cp=versioned ? await store.load(runId) : store.load(runId);
    if (!cp) return null;
    await loadPinned(cp);
    return asPublicFrame(cp);
  }

  return Object.freeze({start,complete,resume,load,policyHash});
}
