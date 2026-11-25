import {buildCoordinator} from './coordinator.mjs';
import {compileInteractive} from './compile.mjs';
import {createSqliteCheckpointStore,sqliteAdminTerminate,sqliteOperationLedger,sqliteArtifactLedger} from './sqlite-store.mjs';
import {hasStepFrame,isInteractiveStage,isHumanProof,publishedInteractivePending,parallelPendingEntries,laneRequestIds} from './protocol.mjs';
import {assertSHA256,canonicalBytes,safeJSONSnapshot,sha256Bytes} from './canonical.mjs';
import {verifyGraphSnapshot} from '../compiler/graph-snapshot.mjs';
import {loadInteractiveProgram} from './load.mjs';

import {decodeCheckpoint,encodeCheckpoint} from './checkpoint.mjs';

const authCallbacks=new WeakMap();
const operationLedgers=new WeakMap();
const artifactLedgers=new WeakMap();
const cancellableStores=new WeakMap();
const forkStores=new WeakMap();
const adminCallbacks=new WeakMap();
const hash=value=>sha256Bytes(canonicalBytes(value));
const fail=(code,message)=>Object.assign(new Error(code+': '+message),{code});
const uncertain=()=>fail('FK_I_STORE_UNCERTAIN','cannot establish a durable transition outcome');

function pendingScope({groups,pending}) {
  return groups.map(group=>({groupId:group.nodeId,
    laneId:group.lanes.find(lane=>laneRequestIds(lane).includes(pending.requestId)).nodeId}));
}

export function createInteractiveHostContext({namespace,subjectId,authorize,authorizeTask,authorizeHuman}={}) {
  if (typeof namespace!=='string'||!namespace || typeof subjectId!=='string'||!subjectId
    || typeof authorize!=='function' || typeof authorizeTask!=='function'
    || (authorizeHuman!==undefined && typeof authorizeHuman!=='function')) throw new TypeError('Trusted Host authorizers are required');
  const auth=Object.freeze({namespace,subjectId,
    readTerminalResult:(resultRef,options)=>readTerminalResult(resultRef,{...options,auth}),
    readRunView:(ref,options)=>readRunView(ref,{...options,auth}),
    listRunViewEvents:(input,options)=>listRunViewEvents(input,{...options,auth}),
    readRunArtifacts:(input,options)=>readRunArtifacts(input,{...options,auth}),
  });
  authCallbacks.set(auth,{authorize,authorizeTask,authorizeHuman});
  return auth;
}

/** Intersect an authentic Host's existing permissions with an approved workflow scope. */
export function restrictInteractiveHostContext(auth, restrictions) {
  const callbacks=authCallbacks.get(auth);
  if (!callbacks) throw fail('FK_I_HOST_DENIED','invalid Host capability');
  return createInteractiveHostContext({namespace:auth.namespace,subjectId:auth.subjectId,
    authorize:async request=>await callbacks.authorize(request)===true && await restrictions.authorize(request)===true,
    authorizeTask:async request=>await callbacks.authorizeTask(request)===true && await restrictions.authorizeTask(request)===true,
    authorizeHuman:callbacks.authorizeHuman});
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
    async createIfAbsent(startKey,initial,genesis,intent=null) {
      if (intent!==null && intent?.kind!=='node-fork') throw fail('FK_I_INVALID_TRANSITION','invalid start intent');
      const {startKey:declaredKey,startIntentHash, ...checkpoint}=decodeCheckpoint(initial);
      const expected=hash({namespace,startKey,artifactHash:checkpoint.artifactHash,
        state:checkpoint.state,policyHash:checkpoint.policyHash,intent});
      const expectedGenesis=genesisFor({...checkpoint,startIntentHash});
      if (declaredKey!==startKey || startIntentHash!==expected
        || genesis?.transitionId!==expectedGenesis.transitionId || genesis.fromRevision!==null
        || genesis.fromBlockId!==null || genesis.toRevision!==0 || genesis.toBlockId!==checkpoint.blockId
        || genesis.namespace!==namespace || genesis.runId!==initial.runId || genesis.programHash!==checkpoint.artifactHash
        || genesis.eventDigest!==expectedGenesis.eventDigest || genesis.proposalDigest!==expectedGenesis.proposalDigest) {
        throw fail('FK_I_INVALID_TRANSITION','invalid genesis for versioned Run');
      }
      if (initial.lastTransitionId!==genesis.transitionId) throw fail('FK_I_INVALID_TRANSITION','invalid checkpoint head');
      const result=backend.createRun({startKey,checkpoint,genesis,startIntent:intent});
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
        const accepted=next.receivedSubmission??next.parallel?.receipt;
        const candidate=next.candidate??next.parallel?.receipt;
        if (receipt.namespace!==namespace || receipt.runId!==runId || receipt.kind!==accepted?.kind
          || candidate?.requestId!==receipt.requestId
          || (receipt.nodeId!==undefined && candidate?.nodeId!==receipt.nodeId)
          || (receipt.attempt!==undefined && candidate?.attempt!==receipt.attempt)
          || receipt.acceptedRevision!==next.revision || receipt.transitionId!==transition.transitionId
          || !['succeeded','failed'].includes(receipt.outcome)
          || accepted?.canonicalDigest!==receipt.submissionDigest
          || (receipt.kind==='human' && (!isHumanProof(receipt.humanProof)
          || hash(receipt.humanProof)!==hash(accepted.humanProof)))) {
          throw fail('FK_I_INVALID_RECEIPT','receipt identity mismatch');
        }
        if (!publishedInteractivePending(current).some(task=>task.requestId===receipt.requestId)) {
          throw fail('FK_I_STALE_RECEIPT','receipt is not pending');
        }
        const scoped=current.parallel && parallelPendingEntries(current.parallel)
          .find(entry=>entry.pending.requestId===receipt.requestId);
        Object.assign(journalEntry,{requestId:receipt.requestId,nodeId:candidate?.nodeId,
          attempt:candidate?.attempt,activation:scoped?.activation??current.controlStack.at(-1)?.activation,
          scope:scoped?pendingScope(scoped):[],digest:receipt.submissionDigest,receiptOutcome:receipt.outcome,stepKind:receipt.kind});
        if (receipt.kind==='human') journalEntry.humanProof=receipt.humanProof;
        if (receipt.subjectId!==undefined) {
          if (typeof receipt.subjectId!=='string'||!receipt.subjectId||receipt.subjectId.length>256) {
            throw fail('FK_I_INVALID_RECEIPT','invalid receipt submitter');
          }
          journalEntry.subjectId=receipt.subjectId;
        }
        if (receipt.operationSafety!==undefined) journalEntry.operationSafety=receipt.operationSafety;
      } else if (current.status==='waiting' && (next.phase==='validate'
        || next.parallel?.receipt?.acceptedRevision===next.revision)) {
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
    async loadJournalPage(runId,page) { return backend.listJournalPage(runId,page); },
    async loadReceipt(runId,requestId) {
      const receipt=backend.getReceipt(runId,requestId);
      if (!receipt) return null;
      const saved=backend.readJournalRecord(runId,{revision:receipt.acceptedRevision});
      return {namespace,runId,requestId,kind:saved.entry.stepKind,submissionDigest:receipt.digest,
        acceptedRevision:receipt.acceptedRevision,outcome:saved.entry.receiptOutcome,
        transitionId:saved.transitionId,nodeId:receipt.nodeId,attempt:receipt.attempt,
        ...(saved.entry.humanProof?{humanProof:saved.entry.humanProof}:{}),
        ...(saved.entry.subjectId?{subjectId:saved.entry.subjectId}:{})};
    },
  });
  forkStores.set(store,backend);
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
      const frame=terminalFrame(cp.runId,cp.revision,cp.status,cp.terminal);
      if (cp.cancelledRequests?.length) frame.cancelledRequests=[...cp.cancelledRequests];
      return frame;
    },
  });
  const ledger=backend[sqliteOperationLedger];
  operationLedgers.set(store,ledger);
  const artifacts=backend[sqliteArtifactLedger];
  artifactLedgers.set(store,artifacts);
  cancellableStores.set(store,backend[sqliteAdminTerminate]);
  function operation(action, fields, readOrWrite, optional=[]) {
    return async (input,auth) => {
      const snapshot=safeJSONSnapshot(input);
      if (!snapshot || typeof snapshot.runId!=='string' || !snapshot.runId || snapshot.runId.length>256
        || !fields.every(key=>Object.hasOwn(snapshot,key))
        || Object.keys(snapshot).some(key=>!fields.includes(key)&&!optional.includes(key))) {
        throw fail('FK_I_INVALID_OPERATION','invalid operation input');
      }
      const {runId,operationKey,inputHash,requestId,evidenceHash,effect,businessKey,compensationKey,compensationPlan}=snapshot;
      const callbacks=await checkAccess({store,programRegistry,auth},action,{
        runId,...(operationKey===undefined?{}:{operationKey}),
        ...(inputHash===undefined?{}:{inputHash}),...(requestId===undefined?{}:{requestId}),
        ...(effect===undefined?{}:{effect,evidenceHash}),
        ...(businessKey===undefined?{}:{businessKey}),
        ...(compensationKey===undefined?{}:{compensationKey,evidenceHash}),
        ...(compensationPlan===undefined?{}:{compensationPlan:Object.freeze(compensationPlan)}),
      });
      if (action==='operation:claim' && auth && requestId!==undefined) {
        const cp=await store.load(runId);
        const pending=cp?.pending.find(item=>item.requestId===requestId);
        if (pending && !await allowsPending(callbacks,auth,cp,pending)) {
          throw fail('FK_I_HOST_DENIED','Host denied this operation task');
        }
      }
      return readOrWrite(snapshot);
    };
  }
  const operationController=Object.freeze({
    claim:operation('operation:claim',['runId','operationKey','requestId','inputHash'],ledger.claim,['businessKey','compensationPlan']),
    load:operation('operation:read',['runId','operationKey'],ledger.load),
    settle:operation('operation:settle',['runId','operationKey','inputHash','effect','evidenceHash','result'],ledger.settle),
    list:operation('operation:list',['runId'],ledger.list),
    claimCompensation:operation('operation:compensate',['runId','operationKey'],ledger.claimCompensation),
    recoverCompensation:operation('operation:recover-compensation',
      ['runId','operationKey','compensationKey','evidenceHash'],ledger.recoverCompensation),
    settleCompensation:operation('operation:settle-compensation',['runId','operationKey','compensationKey','evidenceHash'],
      ledger.settleCompensation),
  });
  function artifactAccess(action,write) {
    return async (input,auth)=>{
      const value=safeJSONSnapshot(input,64*1024);
      if(typeof value?.runId!=='string'||!value.runId||value.runId.length>256) throw fail('FK_I_INVALID_OPERATION','Invalid artifact Run');
      await checkAccess({store,programRegistry,auth},action,value);
      return write(value);
    };
  }
  const artifactController=Object.freeze({
    registerVersion:artifactAccess('artifact:register',artifacts.register),
    freezeBundle:artifactAccess('artifact:freeze',artifacts.freeze),
  });
  return Object.freeze({store,programRegistry,adminController,operationController,artifactController,close:()=>backend.close()});
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
    async createRun({startKey,checkpoint,startIntent=null}) {
      const startIntentHash=hash({namespace:store.namespace,startKey,artifactHash:checkpoint.artifactHash,
        state:checkpoint.state,policyHash:checkpoint.policyHash,intent:startIntent});
      const initial={...checkpoint,startKey,startIntentHash};
      const genesis=genesisFor(initial);
      const envelope=encodeCheckpoint({...initial,lastTransitionId:genesis.transitionId});
      const opened=startIntent===null ? await store.createIfAbsent(startKey,envelope,genesis) :
        await store.createIfAbsent(startKey,envelope,genesis,startIntent);
      if (opened?.checkpoint?.namespace!==store.namespace || opened.checkpoint.startKey!==startKey
        || opened.checkpoint.startIntentHash!==startIntentHash) throw uncertain();
      return {...opened,checkpoint:decodeCheckpoint(opened.checkpoint)};
    },
    async getReceipt(runId,requestId) {
      const receipt=await store.loadReceipt(runId,requestId);
      if (!receipt) return null;
      if (receipt.namespace!==store.namespace || receipt.runId!==runId || receipt.requestId!==requestId
        || !hasStepFrame(receipt.kind) || !Number.isSafeInteger(receipt.acceptedRevision) || receipt.acceptedRevision<1) {
        throw uncertain();
      }
      return {...receipt,digest:receipt.submissionDigest};
    },
    async parallelEffects(runId,requestIds) {
      const ledger=operationLedgers.get(store);
      if (!ledger) throw fail('FK_I_BINDING_MISSING','Parallel effects require durable storage');
      const requested=new Set(requestIds);
      return ledger.list({runId}).filter(operation=>requested.has(operation.requestId));
    },
    async compareAndSwap({runId,expectedRevision,nextCheckpoint,transitionId,journalEntry,fromBlockId}) {
      const transition=journalEntry?.transition ?? {
        namespace:store.namespace,runId,transitionId,fromRevision:expectedRevision,toRevision:expectedRevision+1,
        fromBlockId,
        toBlockId:nextCheckpoint.blockId,programHash:nextCheckpoint.artifactHash,
        eventDigest:hash(journalEntry ?? null),committedAt:new Date().toISOString(),
      };
      const accepted=nextCheckpoint.receivedSubmission??nextCheckpoint.parallel?.receipt;
      const receipt=journalEntry?.kind==='receipt-accepted' ? {
        namespace:store.namespace,runId,requestId:journalEntry.requestId,kind:accepted.kind,
        submissionDigest:journalEntry.digest,acceptedRevision:nextCheckpoint.revision,
        outcome:journalEntry.receiptOutcome,
        transitionId,nodeId:journalEntry.nodeId,attempt:journalEntry.attempt,
        ...(accepted.humanProof?{humanProof:accepted.humanProof}:{}),
        ...(journalEntry.subjectId?{subjectId:journalEntry.subjectId}:{}),
        ...(journalEntry.operationSafety?{operationSafety:journalEntry.operationSafety}:{}),
      } : undefined;
      const next=encodeCheckpoint(nextCheckpoint);
      let result;
      try {
        result=await store.compareAndSwap(runId,expectedRevision,{next,transition,receipt});
      } catch (error) {
        if (['FK_I_CHECKPOINT_CAPACITY','FK_I_INVALID_TRANSITION','FK_I_INVALID_RECEIPT',
          'FK_I_TERMINAL_IMMUTABLE','FK_I_REVISION_EXHAUSTED','FK_I_RUN_NOT_FOUND','FK_I_HOST_DENIED',
          'FK_I_OPERATION_CHANGED','FK_I_RUN_DEADLINE'].includes(error?.code)) throw error;
        if (error?.code==='FK_I_STALE_RECEIPT' && artifactLedgers.has(store)) throw error;
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
  const request=Object.freeze({...resource,namespace:options.auth.namespace,subjectId:options.auth.subjectId,action});
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
    state:cp.state,contextError:cp.execution.contextError,
    ...(Object.hasOwn(cp,'publicOutput')?{publicOutput:cp.publicOutput}:{}),
    ...(cp.status==='succeeded'||cp.status==='failed' ? {terminal:{nodeId:cp.terminal.nodeId,status:cp.status}} : {}),
    ...(typeof cp.causeCode==='string' ? {causeCode:cp.causeCode} : {}),
  });
}

async function viewerTarget(input,options,action,details={}) {
  const ref=safeJSONSnapshot(input,4096);
  const accessKeys=['namespace','runId','artifactHash','graphDigest'];
  const approvalKeys=['collectionId','candidateHash','approvalRef'];
  const hasApproval=approvalKeys.some(key=>ref&&Object.hasOwn(ref,key));
  const required=hasApproval?[...accessKeys,...approvalKeys]:accessKeys;
  if (!ref || Object.keys(ref).length!==required.length || required.some(key=>
    typeof ref[key]!=='string'||!ref[key]||ref[key].length>256) || ref.namespace!==options.auth.namespace
    || [ref.artifactHash,ref.graphDigest,...(hasApproval?[ref.candidateHash]:[])]
      .some(digest=>!/^sha256:[0-9a-f]{64}$/.test(digest))) throw fail('FK_I_HOST_DENIED','invalid viewer identity');
  const callbacks=await checkAccess(options,action,{...ref,...details});
  const persisted=await options.store.load(ref.runId);
  if (persisted?.namespace!==ref.namespace || persisted.runId!==ref.runId
    || persisted.policyIdentity.policyHash!==hash(options.policy)
    || persisted.program.artifactHash!==ref.artifactHash) throw fail('FK_I_HOST_DENIED','Run view is not accessible');
  let graph;
  try {
    graph=verifyGraphSnapshot(safeJSONSnapshot(options.graphSnapshot,8*1024*1024),persisted.program);
    if (graph.graphDigest!==ref.graphDigest) throw new Error('Graph digest differs');
  } catch {throw fail('FK_I_PROGRAM_MISMATCH','Run view graph does not match its pinned Program');}
  return {ref,callbacks,persisted,graph};
}

/** Read a particular approved graph's Run without consuming a transition or disclosing state. */
async function readRunView(input,options) {
  options=operationOptions(options);
  const {ref,callbacks,persisted,graph}=await viewerTarget(input,options,'viewer:read');
  const cp=decodeCheckpoint(persisted);
  const scopes=cp.parallel?new Map(parallelPendingEntries(cp.parallel).map(entry=>[entry.pending.requestId,pendingScope(entry)])):null;
  const pending=[];
  for (const task of persisted.pending) {
    if (!await allowsPending(callbacks,options.auth,persisted,task)) continue;
    pending.push({nodeId:task.nodeId,kind:task.kind,activation:task.activation,attempt:task.attempt,
      requestId:task.requestId,scope:scopes?.get(task.requestId)??[]});
  }
  let publicOutput;
  if (cp.publicOutput!==undefined) {
    try {
      await checkAccess(options,'viewer:output',{...ref,revision:cp.revision});
      if (cp.outputContractDigest===graph.contract?.digest) publicOutput=cp.publicOutput;
    } catch (error) {if (error.code!=='FK_I_HOST_DENIED') throw error;}
  }
  await checkAccess(options,'viewer:read',ref);
  return safeJSONSnapshot({schemaVersion:1,graphDigest:graph.graphDigest,artifactHash:cp.artifactHash,
    namespace:cp.namespace,runId:cp.runId,revision:cp.revision,status:cp.status,pending,
    ...(cp.pauseReason?{pauseReason:cp.pauseReason}:{}),
    ...(publicOutput===undefined?{}:{publicOutput})});
}

async function listRunViewEvents(input,options) {
  options=operationOptions(options);
  const {ref,afterRevision=-1,limit=50}=safeJSONSnapshot(input,8192);
  if (!Number.isSafeInteger(afterRevision)||afterRevision< -1 || !Number.isSafeInteger(limit)||limit<1||limit>100) {
    throw fail('FK_I_INVALID_TRANSITION','invalid viewer cursor');
  }
  const {ref:identity,persisted,graph}=await viewerTarget(ref,options,'viewer:events');
  if (typeof options.store.loadJournalPage!=='function') throw fail('FK_I_BINDING_MISSING','Viewer replay requires a journal reader');
  if (afterRevision>persisted.revision) throw fail('FK_I_INVALID_TRANSITION','cursor exceeds Run revision');
  const page=await options.store.loadJournalPage(identity.runId,{afterRevision,limit});
  const events=[];
  const nodes=new Set(graph.nodes.map(node=>node.id));
  for (const record of page?.records??[]) {
    if (record.revision>persisted.revision) break;
    const {entry}=record;
    const transition=entry.transition;
    if (transition?.namespace!==identity.namespace || transition.runId!==identity.runId
      || transition.programHash!==identity.artifactHash || transition.toRevision!==record.revision
      || transition.transitionId!==record.transitionId || record.revision!==afterRevision+events.length+1) {
      throw fail('FK_I_STORE_CORRUPT','viewer transition identity differs');
    }
    const block=transition.fromBlockId??transition.toBlockId;
    const nodeId=entry.nodeId??block?.slice(0,block.lastIndexOf('::'));
    const kind=record.revision===0?'run.started':transition.toBlockId===null?'run.finished':
      entry.kind==='receipt-accepted'?'receipt.accepted':'transition.committed';
    events.push({eventId:record.transitionId,revision:record.revision,kind,occurredAt:transition.committedAt,
      ...(nodes.has(nodeId)?{nodeId}:{}),
      ...(entry.kind==='receipt-accepted'?{requestId:entry.requestId,attempt:entry.attempt,
        activation:entry.activation,scope:entry.scope,receiptOutcome:entry.receiptOutcome}:{}),
    });
  }
  const cursor=events.at(-1)?.revision??afterRevision;
  if (cursor<persisted.revision && events.length<limit) throw fail('FK_I_STORE_CORRUPT','viewer journal page is incomplete');
  await checkAccess(options,'viewer:events',identity);
  return safeJSONSnapshot({schemaVersion:1,runId:identity.runId,namespace:identity.namespace,
    graphDigest:identity.graphDigest,artifactHash:identity.artifactHash,headRevision:persisted.revision,cursor,events});
}

async function readRunArtifacts(input,options) {
  options=operationOptions(options);
  const {ref,after=0}=safeJSONSnapshot(input,8192);
  if(!Number.isSafeInteger(after)||after<0) throw fail('FK_I_INVALID_OPERATION','Invalid artifact cursor');
  const {ref:identity}=await viewerTarget(ref,options,'viewer:artifacts');
  const ledger=artifactLedgers.get(options.store);
  if(!ledger) throw fail('FK_I_BINDING_MISSING','Artifact view requires a durable ledger');
  const page=ledger.list(identity.runId,after);
  await checkAccess(options,'viewer:artifacts',identity);
  return safeJSONSnapshot({schemaVersion:1,namespace:identity.namespace,runId:identity.runId,
    artifactHash:identity.artifactHash,graphDigest:identity.graphDigest,...page});
}

function bindingRuntime(runtime,policy) {
  const bound={};
  for (const [key,mode] of [['validateResult','pure-local'],['skillResolver','trusted-read'],
    ['prepareAgentTask','trusted-read'],['authorizeAgentTask','trusted-read'],
    ['checkStep','pure-local'],['verifyAgentResult','trusted-read']]) {
    const value=runtime[key];
    const approved=policy.bindingManifest?.[key];
    if (!value) {
      if (approved && key==='checkStep') throw fail('FK_I_BINDING_MISSING','Policy-bound checkStep is required');
      continue;
    }
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
  if (runtime.taskResourcePolicy) bound.taskResourcePolicy=runtime.taskResourcePolicy;
  return bound;
}

function operationOptions(options) {
  if (!options || typeof options!=='object') throw new TypeError('Interactive options are required');
  return {...options,policy:safeJSONSnapshot(options.policy)};
}

function bind(runtime,options) {
  const {store,programRegistry,policy,maxStagesPerCall,signal}=options;
  if (!store || !programRegistry || !policy || !isInteractiveStage(policy.capabilityStage)
    || (policy.parallelEffectMode!==undefined&&!['retain','compensate'].includes(policy.parallelEffectMode))
    || policy.canonicalizationVersion!=='jcs-rfc8785-v1' || typeof policy.id!=='string'
    || !policy.id || typeof policy.version!=='string' || !policy.version
    || (policy.requiredBundleReviews!==undefined && (!Array.isArray(policy.requiredBundleReviews)
      || policy.requiredBundleReviews.some(id=>typeof id!=='string'||!id)
      || new Set(policy.requiredBundleReviews).size!==policy.requiredBundleReviews.length))
    || typeof policy.disclosePolicyId!=='string' || !policy.disclosePolicyId
    || !policy.bindingManifest || !runtime
    || !['createIfAbsent','load','compareAndSwap','loadTransition','loadReceipt'].every(key=>typeof store[key]==='function')
    || !['putImmutable','describe','resolveByHash','retain','release'].every(key=>typeof programRegistry[key]==='function')) {
    throw new TypeError('Interactive policy, Runtime and asynchronous persistence are required');
  }
  return buildCoordinator({store:executionStore(store,programRegistry),runtime:bindingRuntime(runtime,policy),
    policy,maxStagesPerCall,signal},true);
}

async function allowsPending(callbacks,auth,checkpoint,pending) {
  try {
    return await callbacks.authorizeTask(Object.freeze({namespace:auth.namespace,subjectId:auth.subjectId,
      runId:checkpoint.runId,requestId:pending.requestId,revision:checkpoint.revision,
      nodeId:pending.nodeId,task:safeJSONSnapshot(pending.publicTask)}))===true;
  } catch { return false; }
}

async function publicFrame(frame,options,callbacks) {
  const {runId,revision,status}=frame;
  const output={protocolVersion:1,runId,revision,status,pending:[],checkpointRef:{runId,revision}};
  if (frame.cancelledRequests?.length) output.cancelledRequests=[...frame.cancelledRequests];
  if (frame.acceptedRevision!==undefined) {
    output.acknowledgement={acceptedRevision:frame.acceptedRevision,repeated:frame.duplicate};
  }
  if (status==='waiting') {
    const checkpoint=await options.store.load(runId);
    if (checkpoint?.namespace!==options.auth.namespace || checkpoint.revision!==revision
      || checkpoint.status!=='waiting' || !checkpoint.pending.length) throw uncertain();
    for (const pending of checkpoint.pending) {
      if (!await allowsPending(callbacks,options.auth,checkpoint,pending)) continue;
      const {requestId,nodeId,attempt,kind,publicTask,activation}=pending;
      output.pending.push({requestId,nodeId,attempt,activation,kind,intent:'execute',task:safeJSONSnapshot(publicTask)});
    }
    if (!output.pending.length && frame.acceptedRevision===undefined) {
      throw fail('FK_I_HOST_DENIED','Host is not authorized for any waiting task');
    }
    const current=await options.store.load(runId);
    if (current?.namespace!==options.auth.namespace || current.revision!==revision
      || current.status!=='waiting' || hash(current.pending)!==hash(checkpoint.pending)) throw uncertain();
  } else if (status==='paused' && frame.pauseReason==='reconciliation') {
    output.pauseReason='reconciliation';
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
    const compiled=await compileInteractive(reference,{output:'memory',featureStage:options.policy.capabilityStage});
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
  if (identity.implementedStage!==options.policy.capabilityStage) {
    throw fail('FK_I_POLICY_MISMATCH','Program stage and Host policy must match');
  }
  if (identity.implementedStage!=='P0-A' && !operationLedgers.has(options.store)) {
    throw fail('FK_I_BINDING_MISSING','Stage requires a durable Host operation ledger');
  }
  return publicFrame(await coordinator.start({programBytes:bytes,programIdentity:identity,startKey,state,
    authorizeExisting:runId=>checkAccess(options,'run:resume',{runId})}),options,callbacks);
}

/** List saved entries and historical executions for one node. No state is disclosed. */
export async function listInteractiveForkPoints(input,options) {
  options=operationOptions(options);
  const {ref,nodeId,beforeRevision=Number.MAX_SAFE_INTEGER}=safeJSONSnapshot(input,8192)??{};
  if (typeof nodeId!=='string' || !Number.isSafeInteger(beforeRevision) || beforeRevision<1) {
    throw fail('FK_I_INVALID_TRANSITION','invalid fork point query');
  }
  const {ref:identity,graph}=await viewerTarget(ref,options,'viewer:events');
  if (options.policy.approvedSkillHash!==identity.candidateHash) {
    throw fail('FK_I_HOST_DENIED','fork must keep the original Workflow Skill approval scope');
  }
  if (!graph.nodes.some(node=>node.id===nodeId)) throw fail('FK_I_FORK_UNAVAILABLE','node is outside the Program');
  const store=forkStores.get(options.store);
  const list=store?.listForkPoints(identity.runId,nodeId,beforeRevision)??{points:[],next:null};
  await checkAccess(options,'viewer:events',identity);
  return list;
}

/** Start from a recorded boundary of the exact Interactive Run. */
export async function forkInteractiveRun(input,runtime,options) {
  options=operationOptions(options);
  const request=safeJSONSnapshot(input,8192)??{};
  const {source,revision,entryRevision,startKey,redoWrites}=request;
  if (Object.keys(request).length!==5 || !Number.isSafeInteger(revision) || revision<0 ||
      !Number.isSafeInteger(entryRevision) || entryRevision<0 || entryRevision>revision ||
      typeof startKey!=='string' || !startKey || startKey.length>256 || typeof redoWrites!=='boolean') {
    throw fail('FK_I_INVALID_TRANSITION','invalid fork request');
  }
  const details={revision,entryRevision,startKey,redoWrites};
  const {ref,persisted}=await viewerTarget(source,options,'run:fork',details);
  if (options.policy.approvedSkillHash!==ref.candidateHash) {
    throw fail('FK_I_HOST_DENIED','fork must keep the original Workflow Skill approval scope');
  }
  const backend=forkStores.get(options.store);
  if (!backend) throw fail('FK_I_FORK_UNAVAILABLE','Store does not support saved fork points');
  const {point,checkpoint,headRevision,checkpointHash}=backend.readForkPoint(ref.runId,revision);
  if (point.entryRevision!==entryRevision || headRevision!==persisted.revision) {
    throw fail('FK_I_FORK_UNAVAILABLE','selected entry is no longer available');
  }
  if (redoWrites) await checkAccess(options,'run:fork:redo-writes',{...ref,...details});
  const coordinator=bind(runtime,options);
  const programBytes=await options.programRegistry.resolveByHash(ref.artifactHash);
  await checkAccess(options,'run:fork',{...ref,...details});
  const callbacks=await checkAccess(options,'run:create',{startKey,artifactHash:ref.artifactHash});
  const frame=await coordinator.start({programBytes,programIdentity:checkpoint.program,startKey,state:checkpoint.state,
    startIntent:{kind:'node-fork',runId:ref.runId,revision,entryRevision,headRevision,checkpointHash,redoWrites},
    forkCheckpoint:checkpoint,authorizeExisting:runId=>checkAccess(options,'run:resume',{runId})});
  return publicFrame(frame,options,callbacks);
}

export async function complete(submission,runtime,options) {
  options=operationOptions(options);
  const input=safeJSONSnapshot(submission);
  if (!hasStepFrame(input?.kind) || typeof input.runId!=='string' || typeof input.requestId!=='string'
    || !['succeeded','failed'].includes(input.outcome)
    || Object.keys(input).length!==(['action','human'].includes(input.kind)?6:5)+(input.kind==='human'&&Object.hasOwn(input,'bundleHash')?1:0)
    || (input.kind==='action')!==Object.hasOwn(input,'operationKey')
    || (input.kind==='human' && (input.outcome!=='succeeded' || !/^sha256:[0-9a-f]{64}$/.test(input.reviewDigest)
      || Object.hasOwn(input,'bundleHash')&&!/^sha256:[0-9a-f]{64}$/.test(input.bundleHash)))
    || (input.outcome==='failed' && (typeof input.error?.message!=='string' || !input.error.message
      || typeof input.error.code!=='string' || !input.error.code
      || (input.error.retryable!==undefined && typeof input.error.retryable!=='boolean')
      || Object.keys(input.error).some(key=>!['message','code','retryable','origin','sideEffectStatus'].includes(key))
      || (input.error.sideEffectStatus!==undefined && !['none','known','unknown'].includes(input.error.sideEffectStatus))
      || (input.error.origin!==undefined && !['runtime','executor','validator','store','policy'].includes(input.error.origin))))
    || (input.outcome==='succeeded' && (!input.result || typeof input.result!=='object' || Array.isArray(input.result)))) {
    throw fail('FK_I_INVALID_RECEIPT','a bounded step submission is required');
  }
  const coordinator=bind(runtime,options);
  const callbacks=await checkAccess(options,'run:complete',{runId:input.runId,requestId:input.requestId});
  const cp=await options.store.load(input.runId);
  if (!cp || cp.namespace!==options.auth.namespace || cp.runId!==input.runId) {
    throw fail('FK_I_HOST_DENIED','Run is not accessible');
  }
  if (cp.status==='cancelled') throw fail('FK_I_STALE_RECEIPT','Run has been terminated');
  const historical=await options.store.loadReceipt(input.runId,input.requestId);
  let task=historical ?? cp.pending.find(pending=>pending.requestId===input.requestId);
  if (historical && (typeof historical.nodeId!=='string'||!Number.isSafeInteger(historical.attempt))) {
    const transition=await options.store.loadTransition(input.runId,historical.transitionId);
    const suffix='::validate';
    if (transition?.namespace!==cp.namespace || transition.runId!==cp.runId
      || transition.transitionId!==historical.transitionId || transition.toRevision!==historical.acceptedRevision
      || !transition.toBlockId?.endsWith(suffix)) throw uncertain();
    task={...historical,nodeId:transition.toBlockId.slice(0,-suffix.length),attempt:1};
  }
  if (!task || task.requestId!==input.requestId || task.kind!==input.kind || (historical &&
    (historical.runId!==input.runId || historical.namespace!==options.auth.namespace))) {
    throw fail('FK_I_STALE_RECEIPT','request is not current or accepted');
  }
  if (cp.program.implementedStage!=='P0-A' && (historical
    ? task.subjectId!==undefined && task.subjectId!==options.auth.subjectId
    : !await allowsPending(callbacks,options.auth,cp,task))) {
    throw fail('FK_I_HOST_DENIED','Host is not authorized for this task receipt');
  }
  let operationSafety;
  if (input.kind==='action') {
    const operation=operationLedgers.get(options.store)?.load(input);
    const expected=input.outcome==='succeeded'?input.result:input.error;
    const settlement=operation?.settlement;
    const notDispatched=input.outcome==='failed' && input.error.code==='FK_I_ACTION_NOT_DISPATCHED'
      && input.error.sideEffectStatus==='none' && !operation
      && (historical || task.publicTask.operationKey===input.operationKey);
    if (notDispatched) {
      operationSafety='unclaimed';
    } else if (operation?.requestId!==input.requestId || !settlement
      || (input.outcome==='succeeded' && settlement.effect!==(operation.readOnly?'no-effect':'applied'))
      || (input.outcome==='failed' && input.error.sideEffectStatus!==(settlement.effect==='applied'?'known':'none'))
      || hash(settlement.result)!==hash(expected)) {
      throw fail('FK_I_INVALID_OPERATION','Action receipt requires its durable operation settlement');
    } else {
      operationSafety='settled';
    }
  }
  let humanProof;
  if (input.kind==='human' && historical) {
    if (historical.submissionDigest!==hash(input)) throw fail('FK_I_RECEIPT_CONFLICT','Human decision differs from the accepted receipt');
    humanProof=historical.humanProof;
    if (!isHumanProof(humanProof) || humanProof.subjectId!==options.auth.subjectId) {
      throw fail('FK_I_HOST_DENIED','Human receipt acknowledgment requires the original authorized subject');
    }
  } else if (input.kind==='human') {
    if (task.publicTask.reviewDigest!==input.reviewDigest) {
      throw fail('FK_I_STALE_RECEIPT','Human decision does not match the reviewed content');
    }
    const bundle=artifactLedgers.get(options.store)?.readBundle(input.runId,input.requestId);
    const requiresBundle=options.policy.requiredBundleReviews?.includes(task.nodeId);
    if ((requiresBundle||bundle||input.bundleHash) && (!bundle||bundle.bundleHash!==input.bundleHash
      || bundle.reviewDigest!==input.reviewDigest||bundle.expiresAt<=Date.now())) {
      throw fail('FK_I_STALE_RECEIPT','Human decision does not match the current artifact bundle');
    }
    const {decision,comment}=input.result;
    if(bundle) {
      const program=await loadInteractiveProgram(await options.programRegistry.resolveByHash(cp.program.artifactHash),cp.program.artifactHash);
      if(!program.programTable.nodes[task.nodeId]?.metadata.onDecline || !['approve','revise','decline'].includes(decision) ||
        Object.keys(input.result).some(key=>!['decision','comment'].includes(key)) || comment!=null&&typeof comment!=='string') {
        throw fail('FK_I_INVALID_RECEIPT','A validated three-outcome Human decision is required for a review bundle');
      }
    }
    try {
      const evidence=await callbacks.authorizeHuman?.(Object.freeze({
        namespace:options.auth.namespace,subjectId:options.auth.subjectId,runId:input.runId,
        requestId:input.requestId,reviewDigest:input.reviewDigest,result:safeJSONSnapshot(input.result),
        ...(bundle?{bundle:safeJSONSnapshot(bundle)}:{}),
      }));
      if (evidence) {
        const {proofId,evidenceHash}=safeJSONSnapshot(evidence,2048);
        humanProof={subjectId:options.auth.subjectId,proofId,evidenceHash,...(bundle?{bundleHash:bundle.bundleHash,decision}:{})};
      }
    } catch {}
    if (!isHumanProof(humanProof)) throw fail('FK_I_HOST_DENIED','independent Human decision evidence is required');
  }
  const {runId,requestId,outcome}=input;
  const result=await coordinator.complete({runId,requestId,nodeId:task.nodeId,attempt:task.attempt,
    ...(cp.program.implementedStage!=='P0-A'?{subjectId:options.auth.subjectId}:{}),
    submissionDigest:hash(input),receivedPayload:input,
    ...(operationSafety?{operationSafety}:{}),
    ...(humanProof?{humanProof}:{}),
    ...(outcome==='succeeded' ? {kind:input.kind+'-result',result:input.result}
      : {kind:input.kind+'-call-failed',failure:{message:input.error.message,
        ...(input.error.retryable!==undefined?{retryable:input.error.retryable}:{}),
        ...(input.error.sideEffectStatus!==undefined?{sideEffectStatus:input.error.sideEffectStatus}:{}),code:input.error.code}})});
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

/** Cancel a Run under its current Host policy without using management privileges. */
export async function cancelInteractiveRun(runId,reasonCode,options) {
  options=operationOptions(options);
  if (typeof runId!=='string' || !runId || typeof reasonCode!=='string'
    || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(reasonCode)) {
    throw fail('FK_I_INVALID_OPERATION','invalid cancellation request');
  }
  await checkAccess(options,'run:cancel',{runId,reasonCode});
  const cancel=cancellableStores.get(options.store);
  if (!cancel) throw fail('FK_I_BINDING_MISSING','Store does not support atomic cancellation');
  const checkpoint=cancel(runId,reasonCode,options.auth.subjectId,hash(options.policy));
  const frame=terminalFrame(runId,checkpoint.revision,checkpoint.status,checkpoint.terminal);
  if (checkpoint.cancelledRequests?.length) frame.cancelledRequests=[...checkpoint.cancelledRequests];
  return frame;
}

/** Host execution budget operation; never expose this entry to a model. */
export async function reserveInteractiveDispatch(input,runtime,options) {
  options=operationOptions(options);
  const request=safeJSONSnapshot(input);
  const callbacks=await checkAccess(options,'run:resume',{runId:request.runId,requestId:request.requestId});
  const cp=await options.store.load(request.runId);
  const pending=cp?.pending.find(item=>item.requestId===request.requestId);
  if (pending && !await allowsPending(callbacks,options.auth,cp,pending)) {
    throw fail('FK_I_HOST_DENIED','Host is not authorized to dispatch this task');
  }
  return bind(runtime,options).reserveDispatch(request);
}
