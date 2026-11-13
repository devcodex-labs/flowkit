import {buildCoordinator} from './coordinator.mjs';
import {compileInteractive} from './compile.mjs';
import {createSqliteCheckpointStore,sqliteAdminTerminate} from './sqlite-store.mjs';
import {assertSHA256,canonicalBytes,safeJSONSnapshot,sha256Bytes} from './canonical.mjs';

import {decodeCheckpoint,encodeCheckpoint} from './checkpoint.mjs';

const authCallbacks=new WeakMap();
const adminCallbacks=new WeakMap();
const hash=value=>sha256Bytes(canonicalBytes(value));
const fail=(code,message)=>Object.assign(new Error(code+': '+message),{code});
const uncertain=()=>fail('FK_I_STORE_UNCERTAIN','cannot establish a durable transition outcome');

export function createInteractiveHostContext({namespace,subjectId,authorize,authorizeTask}={}) {
  if (typeof namespace!=='string'||!namespace || typeof subjectId!=='string'||!subjectId
    || typeof authorize!=='function' || typeof authorizeTask!=='function') throw new TypeError('Trusted Host authorizers are required');
  const auth=Object.freeze({namespace,subjectId,
    readTerminalResult:(resultRef,options)=>readTerminalResult(resultRef,{...options,auth}),
  });
  authCallbacks.set(auth,{authorize,authorizeTask});
  return auth;
}

function genesisFor(checkpoint) {
  const {namespace,runId,artifactHash:programHash,blockId:toBlockId,startIntentHash}=checkpoint;
  const eventDigest=hash(['genesis',startIntentHash]);
  const proposalDigest=hash(['create',toBlockId]);
  return {namespace,runId,programHash,fromRevision:null,toRevision:0,fromBlockId:null,toBlockId,
    eventDigest,proposalDigest,transitionId:hash([namespace,runId,null,null,eventDigest,programHash,proposalDigest]),
    committedAt:new Date().toISOString()};
}

function refFor(namespace,identity) {
  return {namespace,artifactHash:identity.artifactHash,programId:identity.workflowId};
}

/** Two asynchronous interfaces over the same SQLite connection and transaction backend. */
export function createInteractiveAdminContext({namespace,subjectId,authorize}={}) {
  const identifier=value=>typeof value==='string' && /^[a-zA-Z0-9_.:@-]{1,128}$/.test(value);
  if (!identifier(subjectId) || typeof namespace!=='string' || !namespace || typeof authorize!=='function') {
    throw new TypeError('A trusted admin identity and authorizer are required');
  }
  const auth=Object.freeze({namespace,subjectId});
  adminCallbacks.set(auth,authorize);
  return auth;
}

export function createSqliteInteractivePersistence(file,{namespace}={}) {
  const backend=createSqliteCheckpointStore(file,{namespace});
  const store=Object.freeze({
    namespace,
    async createIfAbsent(startKey,initial,genesis) {
      const {startKey:declaredKey,startIntentHash, ...checkpoint}=decodeCheckpoint(initial);
      const expected=hash({namespace,startKey,artifactHash:checkpoint.artifactHash,
        state:checkpoint.state,policyHash:checkpoint.policyHash,intent:null});
      const expectedGenesis=genesisFor({...checkpoint,startIntentHash});
      if (declaredKey!==startKey || startIntentHash!==expected
        || genesis?.transitionId!==expectedGenesis.transitionId || genesis.fromRevision!==null
        || genesis.fromBlockId!==null || genesis.toRevision!==0 || genesis.toBlockId!==checkpoint.blockId
        || genesis.namespace!==namespace || genesis.runId!==initial.runId || genesis.programHash!==checkpoint.artifactHash
        || genesis.eventDigest!==expectedGenesis.eventDigest || genesis.proposalDigest!==expectedGenesis.proposalDigest) {
        throw fail('FK_I_INVALID_TRANSITION','invalid genesis for versioned Run');
      }
      if (initial.lastTransitionId!==genesis.transitionId) throw fail('FK_I_INVALID_TRANSITION','invalid checkpoint head');
      const result=backend.createRun({startKey,checkpoint,genesis});
      return {...result,checkpoint:encodeCheckpoint(result.checkpoint)};
    },
    async load(runId) {
      const cp=backend.load(runId);
      return cp ? encodeCheckpoint(cp) : null;
    },
    async compareAndSwap(runId,expectedRevision,{next:nextEnvelope,transition,receipt}) {
      const next=decodeCheckpoint(nextEnvelope);
      const current=backend.load(runId);
      if (!current) throw fail('FK_I_RUN_NOT_FOUND','run is not accessible');
      if (current.revision!==expectedRevision) return {committed:false,currentRevision:current.revision};
      if (transition.namespace!==namespace || transition.runId!==runId
        || transition.fromRevision!==expectedRevision || transition.toRevision!==expectedRevision+1
        || transition.fromBlockId!==current.blockId || transition.programHash!==current.artifactHash) {
        throw fail('FK_I_INVALID_TRANSITION','transition identity mismatch');
      }
      assertSHA256(transition.eventDigest);
      assertSHA256(transition.proposalDigest);
      const id=hash([namespace,runId,expectedRevision,current.blockId,transition.eventDigest,
        current.artifactHash,transition.proposalDigest]);
      const to=['succeeded','failed','errored','cancelled'].includes(next.status) ? null : next.blockId;
      if (id!==transition.transitionId || id!==next.lastTransitionId || to!==transition.toBlockId) {
        throw fail('FK_I_INVALID_TRANSITION','transition digest mismatch');
      }
      const journalEntry={kind:receipt?'receipt-accepted':'versioned-transition',transition};
      if (receipt) {
        if (receipt.namespace!==namespace || receipt.runId!==runId || receipt.kind!=='agent'
          || next.candidate?.requestId!==receipt.requestId
          || (receipt.nodeId!==undefined && next.candidate?.nodeId!==receipt.nodeId)
          || (receipt.attempt!==undefined && next.candidate?.attempt!==receipt.attempt)
          || receipt.acceptedRevision!==next.revision || receipt.transitionId!==transition.transitionId
          || !['succeeded','failed'].includes(receipt.outcome)
          || next.receivedSubmission?.canonicalDigest!==receipt.submissionDigest) {
          throw fail('FK_I_INVALID_RECEIPT','receipt identity mismatch');
        }
        Object.assign(journalEntry,{requestId:receipt.requestId,nodeId:next.candidate?.nodeId,
          attempt:next.candidate?.attempt,digest:receipt.submissionDigest,receiptOutcome:receipt.outcome});
      } else if (current.status==='waiting' && next.phase==='validate') {
        throw fail('FK_I_INVALID_RECEIPT','accepting a Pending requires its atomic receipt');
      }
      const result=backend.compareAndSwap({runId,expectedRevision,nextCheckpoint:next,
        transitionId:transition.transitionId,journalEntry});
      return result.committed ? {committed:true,checkpoint:encodeCheckpoint(result.checkpoint)}
        : {committed:false,currentRevision:result.checkpoint.revision};
    },
    async loadTransition(runId,transitionId) {
      const entry=backend.readJournalRecord(runId,{transitionId});
      return entry?.entry?.transition ?? null;
    },
    async loadReceipt(runId,requestId) {
      const receipt=backend.getReceipt(runId,requestId);
      if (!receipt) return null;
      const saved=backend.readJournalRecord(runId,{revision:receipt.acceptedRevision});
      return {namespace,runId,requestId,kind:'agent',submissionDigest:receipt.digest,
        acceptedRevision:receipt.acceptedRevision,outcome:saved.entry.receiptOutcome,
        transitionId:saved.transitionId,nodeId:receipt.nodeId,attempt:receipt.attempt};
    },
  });
  const programRegistry=Object.freeze({
    namespace,
    async putImmutable(bytes,manifest) {
      backend.putArtifact({bytes,programIdentity:manifest});
      return refFor(namespace,manifest);
    },
    async resolveByHash(artifactHash) {
      const value=backend.getArtifact(artifactHash);
      if (!value) throw fail('FK_I_PROGRAM_MISMATCH','Program bytes unavailable');
      return value.bytes;
    },
    async describe(artifactHash) {return backend.getArtifact(artifactHash)?.programIdentity ?? null;},
    async retain(runId,artifactHash) {
      if (backend.load(runId)?.artifactHash!==artifactHash) {
        throw fail('FK_I_PROGRAM_MISMATCH','retain must come from the atomic create transaction');
      }
    },
    async release(runId,artifactHash) {
      if (backend.load(runId)?.artifactHash===artifactHash) {
        throw fail('FK_I_ARTIFACT_IN_USE','durable Run still retains the Program');
      }
    },
  });
  const adminController=Object.freeze({
    async adminTerminate(runId,reason,auth) {
      const authorize=adminCallbacks.get(auth);
      if (!authorize || auth.namespace!==namespace || typeof runId!=='string' || !runId
        || typeof reason!=='string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(reason)) {
        throw fail('FK_I_HOST_DENIED','invalid management request');
      }
      let allowed;
      try {allowed=await authorize(Object.freeze({action:'run:admin-terminate',namespace,runId,reasonCode:reason,
        subjectId:auth.subjectId}));} catch {}
      if (allowed!==true) throw fail('FK_I_HOST_DENIED','management authorization denied');
      const cp=backend[sqliteAdminTerminate](runId,reason,auth.subjectId);
      return terminalFrame(cp.runId,cp.revision,cp.status,cp.terminal);
    },
  });
  return Object.freeze({store,programRegistry,adminController,close:()=>backend.close()});
}

function terminalFrame(runId,revision,status,terminal) {
  return {protocolVersion:1,runId,revision,status,pending:[],checkpointRef:{runId,revision},
    resultRef:{runId,revision,projectionVersion:1},
    ...(status==='succeeded'||status==='failed' ? {terminal:{nodeId:terminal.nodeId,status}} : {})};
}

function sameTransition(saved,expected) {
  if (!saved) return false;
  const {committedAt:_actual,...actual}=saved;
  const {committedAt:_expected,...rest}=expected;
  return canonicalBytes(actual).equals(canonicalBytes(rest));
}

function executionStore(store,registry) {
  async function read(runId) {
    const cp=await store.load(runId);
    if (cp && (cp.runId!==runId || cp.namespace!==store.namespace || !Number.isSafeInteger(cp.revision)
      || cp.revision<0)) throw uncertain();
    return cp ? decodeCheckpoint(cp) : null;
  }
  return {
    namespace:store.namespace,
    load:read,
    async getArtifact(artifactHash) {
      const programIdentity=await registry.describe(artifactHash);
      if (!programIdentity) return null;
      const bytes=await registry.resolveByHash(artifactHash);
      return {programIdentity,bytes};
    },
    async putArtifact({programIdentity,bytes}) {
      const ref=await registry.putImmutable(bytes,programIdentity);
      const persisted=await registry.describe(programIdentity.artifactHash);
      const storedBytes=await registry.resolveByHash(programIdentity.artifactHash);
      if (ref?.namespace!==store.namespace || ref.artifactHash!==programIdentity.artifactHash
        || !persisted || hash(persisted)!==hash(programIdentity)
        || !(storedBytes instanceof Uint8Array) || sha256Bytes(storedBytes)!==programIdentity.artifactHash) {
        throw fail('FK_I_PROGRAM_MISMATCH','registered Program identity did not survive readback');
      }
    },
    async createRun({startKey,checkpoint}) {
      const startIntentHash=hash({namespace:store.namespace,startKey,artifactHash:checkpoint.artifactHash,
        state:checkpoint.state,policyHash:checkpoint.policyHash,intent:null});
      const initial={...checkpoint,startKey,startIntentHash};
      const genesis=genesisFor(initial);
      const opened=await store.createIfAbsent(startKey,encodeCheckpoint({...initial,lastTransitionId:genesis.transitionId}),genesis);
      if (opened?.checkpoint?.namespace!==store.namespace || opened.checkpoint.startKey!==startKey
        || opened.checkpoint.startIntentHash!==startIntentHash) throw uncertain();
      return {...opened,checkpoint:decodeCheckpoint(opened.checkpoint)};
    },
    async getReceipt(runId,requestId) {
      const receipt=await store.loadReceipt(runId,requestId);
      if (!receipt) return null;
      if (receipt.namespace!==store.namespace || receipt.runId!==runId || receipt.requestId!==requestId
        || receipt.kind!=='agent' || !Number.isSafeInteger(receipt.acceptedRevision) || receipt.acceptedRevision<1) {
        throw uncertain();
      }
      return {...receipt,digest:receipt.submissionDigest};
    },
    async compareAndSwap({runId,expectedRevision,nextCheckpoint,transitionId,journalEntry,fromBlockId}) {
      const transition=journalEntry?.transition ?? {
        namespace:store.namespace,runId,transitionId,fromRevision:expectedRevision,toRevision:expectedRevision+1,
        fromBlockId,
        toBlockId:nextCheckpoint.blockId,programHash:nextCheckpoint.artifactHash,
        eventDigest:hash(journalEntry ?? null),committedAt:new Date().toISOString(),
      };
      const receipt=journalEntry?.kind==='receipt-accepted' ? {
        namespace:store.namespace,runId,requestId:journalEntry.requestId,kind:'agent',
        submissionDigest:journalEntry.digest,acceptedRevision:nextCheckpoint.revision,
        outcome:journalEntry.receiptOutcome ?? (nextCheckpoint.candidate.submissionKind==='agent-result'?'succeeded':'failed'),
        transitionId,nodeId:journalEntry.nodeId,attempt:journalEntry.attempt,
      } : undefined;
      const next=encodeCheckpoint(nextCheckpoint);
      let result;
      try {
        result=await store.compareAndSwap(runId,expectedRevision,{next,transition,receipt});
      } catch (error) {
        if (['FK_I_CHECKPOINT_CAPACITY','FK_I_INVALID_TRANSITION','FK_I_INVALID_RECEIPT',
          'FK_I_TERMINAL_IMMUTABLE','FK_I_REVISION_EXHAUSTED','FK_I_RUN_NOT_FOUND','FK_I_HOST_DENIED'].includes(error?.code)) throw error;
        let saved,latest;
        try {
          saved=await store.loadTransition(runId,transitionId);
          if (saved && receipt) {
            const persisted=await store.loadReceipt(runId,receipt.requestId);
            if (persisted?.transitionId!==transitionId || persisted.submissionDigest!==receipt.submissionDigest
              || persisted.acceptedRevision!==receipt.acceptedRevision) throw uncertain();
          }
          latest=await read(runId);
        } catch {throw uncertain();}
        if (sameTransition(saved,transition) && latest?.revision>=transition.toRevision) {
          return {committed:true,checkpoint:latest};
        }
        if (!saved && latest?.revision>expectedRevision) return {committed:false,checkpoint:latest};
        throw uncertain();
      }
      if (result?.committed===true && result.checkpoint?.runId===runId
        && result.checkpoint.namespace===store.namespace && result.checkpoint.revision===transition.toRevision
        && hash(result.checkpoint)===hash(next)) return {committed:true,checkpoint:decodeCheckpoint(result.checkpoint)};
      if (result?.committed===false && Number.isSafeInteger(result.currentRevision)
        && result.currentRevision>expectedRevision) {
        const latest=await read(runId);
        if (latest?.revision>=result.currentRevision) return {committed:false,checkpoint:latest};
      }
      throw uncertain();
    },
  };
}

async function checkAccess(options,action,resource) {
  options.signal?.throwIfAborted();
  const callbacks=authCallbacks.get(options.auth);
  if (!callbacks || options.auth.namespace!==options.store.namespace
    || options.programRegistry.namespace!==options.store.namespace) throw fail('FK_I_HOST_DENIED','invalid Host capability');
  const request=Object.freeze({namespace:options.auth.namespace,subjectId:options.auth.subjectId,action,...resource});
  let approved;
  try {approved=await callbacks.authorize(request);} catch {}
  if (approved!==true) throw fail('FK_I_HOST_DENIED','Host authorization denied');
  return callbacks;
}

async function readTerminalResult(resultRef,options) {
  options=operationOptions(options);
  const ref=safeJSONSnapshot(resultRef,2048);
  if (!ref || Object.keys(ref).length!==3 || typeof ref.runId!=='string'
    || !Number.isSafeInteger(ref.revision) || ref.revision<0 || ref.projectionVersion!==1) {
    throw fail('FK_I_HOST_DENIED','invalid result reference');
  }
  await checkAccess(options,'result:read',{runId:ref.runId,revision:ref.revision});
  const cp=await options.store.load(ref.runId);
  if (cp?.namespace!==options.auth.namespace || cp.runId!==ref.runId || cp.revision!==ref.revision
    || cp.policyIdentity.policyHash!==hash(options.policy) || !['succeeded','failed','errored','cancelled'].includes(cp.status)) {
    throw fail('FK_I_HOST_DENIED','result is not accessible');
  }
  return safeJSONSnapshot({
    projectionVersion:1,namespace:cp.namespace,runId:cp.runId,status:cp.status,
    state:cp.state,contextError:null,
    ...(cp.status==='succeeded'||cp.status==='failed' ? {terminal:{nodeId:cp.terminal.nodeId,status:cp.status}} : {}),
    ...(typeof cp.causeCode==='string' ? {causeCode:cp.terminal.causeCode} : {}),
  });
}

function bindingRuntime(runtime,policy) {
  const bound={};
  for (const [key,mode] of [['validateResult','pure-local'],['skillResolver','trusted-read']]) {
    const value=runtime[key];
    if (!value) continue;
    const approved=policy.bindingManifest?.[key];
    if (!approved || typeof value.id!=='string' || typeof value.version!=='string'
      || value.mode!==mode || approved.id!==value.id || approved.version!==value.version
      || approved.mode!==value.mode || typeof value.implementation!=='function') {
      throw fail('FK_I_POLICY_MISMATCH','unapproved Runtime binding: '+key);
    }
    const implementation=value.implementation;
    bound[key]=key==='skillResolver' ? descriptor=>{
      const reference=descriptor.skill ?? descriptor.agent;
      return implementation(reference,descriptor);
    } : implementation;
  }
  if (runtime.checkStep) bound.checkStep=runtime.checkStep;
  return bound;
}

function operationOptions(options) {
  if (!options || typeof options!=='object') throw new TypeError('Interactive options are required');
  return {...options,policy:safeJSONSnapshot(options.policy)};
}

function bind(runtime,options) {
  const {store,programRegistry,policy,maxStagesPerCall,signal}=options;
  if (!store || !programRegistry || !policy || policy.capabilityStage!=='P0-A'
    || policy.canonicalizationVersion!=='jcs-rfc8785-v1' || typeof policy.id!=='string'
    || !policy.id || typeof policy.version!=='string' || !policy.version
    || typeof policy.disclosePolicyId!=='string' || !policy.disclosePolicyId
    || !policy.bindingManifest || !runtime
    || !['createIfAbsent','load','compareAndSwap','loadTransition','loadReceipt'].every(key=>typeof store[key]==='function')
    || !['putImmutable','describe','resolveByHash','retain','release'].every(key=>typeof programRegistry[key]==='function')) {
    throw new TypeError('P0-A policy, Runtime and asynchronous persistence are required');
  }
  return buildCoordinator({store:executionStore(store,programRegistry),runtime:bindingRuntime(runtime,policy),
    policy,maxStagesPerCall,signal},true);
}

async function publicFrame(frame,options,callbacks) {
  const {runId,revision,status}=frame;
  const output={protocolVersion:1,runId,revision,status,pending:[],checkpointRef:{runId,revision}};
  if (frame.acceptedRevision!==undefined) {
    output.acknowledgement={acceptedRevision:frame.acceptedRevision,repeated:frame.duplicate};
  }
  if (status==='waiting') {
    const checkpoint=await options.store.load(runId);
    if (checkpoint?.namespace!==options.auth.namespace || checkpoint.revision!==revision
      || checkpoint.status!=='waiting' || checkpoint.pending[0]?.requestId!==frame.pending?.requestId) throw uncertain();
    const {requestId,nodeId,attempt,name,instruction,input,missing,resultSchema,reasons,overview}=frame.pending;
    const task=safeJSONSnapshot({name,instruction,input,missing,resultSchema,reasons,...(overview?{overview}:{})});
    let approved;
    try {
      approved=await callbacks.authorizeTask(Object.freeze({namespace:options.auth.namespace,
        subjectId:options.auth.subjectId,runId,requestId,revision,task:safeJSONSnapshot(task)}));
    } catch {}
    if (approved!==true) throw fail('FK_I_HOST_DENIED','Host task disclosure denied');
    const current=await options.store.load(runId);
    if (current?.namespace!==options.auth.namespace || current.revision!==revision
      || current.status!=='waiting' || current.pending[0]?.requestId!==requestId) throw uncertain();
    output.pending.push({requestId,nodeId,attempt,activation:checkpoint.pending[0].activation,
      kind:'agent',intent:'execute',task});
  } else if (['succeeded','failed','errored','cancelled'].includes(status)) {
    Object.assign(output,terminalFrame(runId,revision,status,frame.terminal));
  } else if (status!=='paused') throw uncertain();
  return output;
}

export async function start(source,runtime,initialState,options) {
  options=operationOptions(options);
  const state=safeJSONSnapshot(initialState);
  const reference=typeof source==='string' ? source : safeJSONSnapshot(source);
  const {startKey}=options;
  const coordinator=bind(runtime,options);
  if (typeof startKey!=='string' || !startKey) throw new TypeError('A start key is required');
  const callbacks=await checkAccess(options,'run:create',{startKey,
    ...(typeof reference==='string'?{source:reference}:{artifactHash:reference?.artifactHash})});
  let bytes,identity;
  if (typeof reference==='string') {
    const compiled=await compileInteractive(reference,{output:'memory',featureStage:'P0-A'});
    if (!compiled.programIdentity) throw Object.assign(fail('FK_I_PROGRAM_MISMATCH','source compilation failed'),
      {diagnostics:compiled.diagnostics});
    bytes=Buffer.from(compiled.code);
    identity=compiled.programIdentity;
  } else {
    if (reference?.namespace!==options.auth.namespace) throw fail('FK_I_HOST_DENIED','invalid Program reference');
    identity=await options.programRegistry.describe(reference.artifactHash);
    if (!identity || identity.artifactHash!==reference.artifactHash || identity.workflowId!==reference.programId) {
      throw fail('FK_I_PROGRAM_MISMATCH','invalid Program reference identity');
    }
    bytes=await options.programRegistry.resolveByHash(reference.artifactHash);
  }
  return publicFrame(await coordinator.start({programBytes:bytes,programIdentity:identity,startKey,state,
    authorizeExisting:runId=>checkAccess(options,'run:resume',{runId})}),options,callbacks);
}

export async function complete(submission,runtime,options) {
  options=operationOptions(options);
  const input=safeJSONSnapshot(submission);
  if (input?.kind!=='agent' || typeof input.runId!=='string' || typeof input.requestId!=='string'
    || !['succeeded','failed'].includes(input.outcome)
    || Object.keys(input).length!==5
    || (input.outcome==='failed' && (typeof input.error?.message!=='string' || !input.error.message
      || typeof input.error.code!=='string' || !input.error.code
      || (input.error.retryable!==undefined && typeof input.error.retryable!=='boolean')
      || Object.keys(input.error).some(key=>!['message','code','retryable','origin'].includes(key))
      || (input.error.origin!==undefined && !['runtime','executor','validator','store','policy'].includes(input.error.origin))))
    || (input.outcome==='succeeded' && (!input.result || typeof input.result!=='object' || Array.isArray(input.result)))) {
    throw fail('FK_I_INVALID_RECEIPT','a bounded Agent submission is required');
  }
  const coordinator=bind(runtime,options);
  const callbacks=await checkAccess(options,'run:complete',{runId:input.runId,requestId:input.requestId});
  const cp=await options.store.load(input.runId);
  if (!cp || cp.namespace!==options.auth.namespace || cp.runId!==input.runId) {
    throw fail('FK_I_HOST_DENIED','Run is not accessible');
  }
  if (cp.status==='cancelled') throw fail('FK_I_STALE_RECEIPT','Run has been terminated');
  const historical=await options.store.loadReceipt(input.runId,input.requestId);
  let task=historical ?? cp.pending[0];
  if (historical && (typeof historical.nodeId!=='string'||!Number.isSafeInteger(historical.attempt))) {
    const transition=await options.store.loadTransition(input.runId,historical.transitionId);
    const suffix='::validate';
    if (transition?.namespace!==cp.namespace || transition.runId!==cp.runId
      || transition.transitionId!==historical.transitionId || transition.toRevision!==historical.acceptedRevision
      || !transition.toBlockId?.endsWith(suffix)) throw uncertain();
    task={...historical,nodeId:transition.toBlockId.slice(0,-suffix.length),attempt:1};
  }
  if (!task || task.requestId!==input.requestId || (historical &&
    (historical.runId!==input.runId || historical.namespace!==options.auth.namespace))) {
    throw fail('FK_I_STALE_RECEIPT','request is not current or accepted');
  }
  const {runId,requestId,outcome}=input;
  const result=await coordinator.complete({runId,requestId,nodeId:task.nodeId,attempt:task.attempt,
    submissionDigest:hash(input),receivedPayload:input,
    ...(outcome==='succeeded' ? {result:input.result}
      : {kind:'agent-call-failed',failure:{message:input.error.message}})});
  const frame=await publicFrame(result,options,callbacks);
  frame.acknowledgement.requestId=requestId;
  return frame;
}

export async function resume(runId,runtime,options) {
  options=operationOptions(options);
  const coordinator=bind(runtime,options);
  const callbacks=await checkAccess(options,'run:resume',{runId});
  return publicFrame(await coordinator.resume({runId}),options,callbacks);
}
