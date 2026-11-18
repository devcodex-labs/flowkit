import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { openLocalSkillStore } from './local-skill-store.mjs';
import { startAuthorDraft } from './draft.mjs';
import { checkCandidate, reviewStandardCandidate } from './standard-artifact.mjs';
import { executeAuthorCore } from './host-core.mjs';
import { authorError, budgetPolicy, newTurnBudget, positive, createTurnPorts, jsonBytes } from './host-budget.mjs';

const clone = value => structuredClone(value);
const hash = value => artifactDigest(JSON.stringify(value, (_key, item) => item && typeof item === 'object' &&
  !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item));
const content = draft => ({ intent: draft.intent ?? null, choices: draft.choices, target: draft.target,
  plan: draft.plan ?? null, resources: draft.resources ?? null, candidateHash: draft.candidate?.hash ?? null });
const requiredId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new TypeError(`${label} is required`);
  return value;
};

/** Create one namespace-owned Author service. Host clients, credentials and permissions stay Host-owned. */
export async function createWorkflowAuthorHost(supplied) {
  const options = { ...supplied };
  requiredId(options.namespace, 'namespace');
  if (!Array.isArray(options.collectionIds) || !options.collectionIds.length || options.collectionIds.some(id => !id)) throw new TypeError('Authorized collection IDs are required');
  if (typeof options.authorization?.authorize !== 'function') throw new TypeError('Current-request Host authorization is required');
  const policy = budgetPolicy(options.budgetPolicy);
  const capacity = { maxPhysicalExecutions: positive(options.capacity?.maxPhysicalExecutions, 4, 'physical executions'),
    maxPendingCandidates: positive(options.capacity?.maxPendingCandidates, 16, 'pending candidates'),
    maxDrafts: positive(options.capacity?.maxDrafts, 256, 'drafts'),
    maxDraftBytes: positive(options.capacity?.maxDraftBytes, 8 * 1024 * 1024, 'draft bytes') };
  const storageFile = path.resolve(requiredId(options.storageFile, 'storageFile'));
  options.workRoot = path.dirname(storageFile);
  await mkdir(options.workRoot, { recursive: true });
  let publishing = null, collectionChange = null, closing = false, closed = false;
  const store = openLocalSkillStore(storageFile,
    binding => publishing?.candidateHash === binding.candidateHash && publishing?.reviewRef === binding.reviewRef && publishing?.approvalRef === binding.approvalRef,
    binding => collectionChange?.planHash === binding.planHash && collectionChange?.approvalRef === binding.approvalRef,
    { namespace: options.namespace });
  const meta = store.authorTransaction(state => state.meta());
  const flights = new Map();
  function view(draft) { return clone({ ...draft, storeId: meta.store_id, namespace: options.namespace }); }
  function read(id) {
    if (closed) throw authorError('author-closed', 'Author service is closed');
    const draft = store.authorTransaction(state => state.readDraft(id));
    if (!draft) throw authorError('author-draft-missing', 'Draft ID is unknown or expired');
    return draft;
  }
  function write(state, draft, previous) {
    draft.stateVersion = previous + 1;
    if (jsonBytes(draft) > capacity.maxDraftBytes) throw authorError('author-capacity', 'Draft byte capacity exceeded');
    state.writeDraft(draft, previous);
  }
  function mutate(id, expected, operation) {
    return store.authorTransaction(state => {
      const draft = state.readDraft(id);
      if (!draft) throw authorError('author-draft-missing', 'Draft ID is unknown or expired');
      if (expected !== undefined && draft.stateVersion !== expected) throw authorError('author-conflict', 'Draft stateVersion changed');
      const result = operation(draft, state);
      write(state, draft, draft.stateVersion);
      return result ?? view(draft);
    });
  }
  async function authorize(action, collectionId, context, signal, details = {}) {
    signal?.throwIfAborted();
    if (closed || closing && !['read', 'cancel', 'settle'].includes(action)) throw authorError('author-closed', 'Author service is closing');
    if (!context || context.namespace !== options.namespace || !context.principalId || !context.sessionId ||
      !context.workspaceRef || !Array.isArray(context.collectionIds) || !context.collectionIds.includes(collectionId) ||
      !options.collectionIds.includes(collectionId)) throw authorError('author-unauthorized', 'Current Host request does not authorize this namespace/collection');
    if (await options.authorization.authorize({ action, collectionId, requestContext: clone(context), signal, ...details }) !== true) {
      throw authorError('author-unauthorized', 'Host denied the current action');
    }
    signal?.throwIfAborted();
  }
  function receiptBinding(draft) {
    return { namespace: options.namespace, storeId: meta.store_id, draftId: draft.id, collectionId: draft.collectionId,
      contentRevision: draft.contentRevision, contentHash: draft.contentHash, candidateHash: draft.candidate?.hash,
      previousHash: draft.previousHash };
  }
  const host = {
    async start(input, currentRequestContext, signal) {
      await authorize('start', input.collectionId, currentRequestContext, signal);
      requiredId(input.requestId, 'requestId');
      const fingerprint = hash({ ...input, currentRequestContext });
      return store.authorTransaction(state => {
        const drafts = state.drafts();
        const replay = drafts.find(draft => draft.startRequestId === input.requestId);
        if (replay) {
          if (replay.startFingerprint !== fingerprint) throw authorError('author-conflict', 'Start requestId has different material');
          return view(replay);
        }
        if (drafts.length >= capacity.maxDrafts) throw authorError('author-capacity', 'Retained draft capacity reached; Host retention decision required');
        const initial = startAuthorDraft(input.goal, { ...options.defaults, ...input.choices });
        const previous = input.target?.skillId ? store.readActive(input.collectionId, input.target.skillId) : null;
        const draft = { ...initial, namespace: options.namespace, collectionId: input.collectionId,
          startRequestId: input.requestId, startFingerprint: fingerprint, stateVersion: 1, contentRevision: 1,
          target: { skillId: randomUUID(), name: 'workflow', description: input.goal, version: '1.0.0', ...input.target },
          operation: input.operation ?? 'create', previousHash: previous?.hash ?? null,
          previousCandidate: previous, activeExecution: null, publications: {} };
        draft.contentHash = hash(content(draft));
        if (jsonBytes(draft) > capacity.maxDraftBytes) throw authorError('author-capacity', 'Draft byte capacity exceeded');
        state.writeDraft(draft, null);
        return view(draft);
      });
    },
    async readDraft(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('read', draft.collectionId, currentRequestContext, signal);
      return view(draft);
    },
    async advanceTurn(input, currentRequestContext, signal) {
      const initial = read(input.draftId);
      await authorize('advance', initial.collectionId, currentRequestContext, signal);
      requiredId(input.turnId, 'turnId');
      const request = clone({ input: input.input, contextSnapshot: input.contextSnapshot ?? null,
        ...(input.baseline === undefined ? {} : { baseline: input.baseline, baselineId: input.baselineId }),
        ...(input.confirmedConstraintIds ? { confirmedConstraintIds: input.confirmedConstraintIds } : {}),
        safetyPolicies: input.safetyPolicies ?? [] });
      const fingerprint = hash({ request, choices: input.choices ?? {}, kind: input.kind ?? 'authoring', currentRequestContext });
      let turn, replay;
      store.authorTransaction(state => {
        const draft = state.readDraft(input.draftId);
        turn = state.readTurn(draft.id, input.turnId);
        if (turn) {
          if (turn.fingerprint !== fingerprint) throw authorError('author-conflict', 'Turn ID has different bound material');
          replay = turn.result ?? view(draft); return;
        }
        if (draft.stateVersion !== input.expectedStateVersion) throw authorError('author-conflict', 'Draft stateVersion changed');
        if (['discarded', 'abandoned'].includes(draft.status)) throw authorError('author-terminal', 'Draft is terminal');
        const all = state.drafts();
        const physical = all.flatMap(item => state.turns(item.id)).filter(item => item.physicalOutstanding);
        if (physical.some(item => item.draftId === draft.id) || physical.length >= capacity.maxPhysicalExecutions) {
          throw authorError('author-busy', 'Physical execution is still outstanding; settle or wait before dispatch');
        }
        if (all.filter(item => item.candidate && !item.savedReceipt && item.status !== 'discarded').length >= capacity.maxPendingCandidates && !draft.candidate) {
          throw authorError('author-capacity', 'Pending candidate capacity reached');
        }
        if (typeof input.input !== 'string' || !input.input.trim()) throw new TypeError('Current input is required');
        draft.choices = { ...draft.choices, ...input.choices };
        startAuthorDraft(draft.goal, draft.choices);
        turn = { draftId: draft.id, turnId: input.turnId, attemptId: randomUUID(), executionToken: randomUUID(),
          request, fingerprint, status: 'running', physicalOutstanding: true, budget: newTurnBudget(policy) };
        draft.activeExecution = turn.executionToken; draft.status = 'running';
        draft.reviewReceipt = null; draft.approvalReceipt = null;
        state.writeTurn(turn);
        write(state, draft, draft.stateVersion);
      });
      if (replay) return replay;
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal, AbortSignal.timeout(Math.max(1, turn.budget.deadlineMs - Date.now()))]) :
        AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, turn.budget.deadlineMs - Date.now()))]);
      const flight = { controller, pending: new Set(), done: false };
      const key = JSON.stringify([input.draftId, input.turnId]); flights.set(key, flight);
      function changeTurn(operation, flags = {}) {
        return store.authorTransaction(state => {
          const current = state.readTurn(input.draftId, input.turnId);
          if (!flags.settlement && current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Execution token changed');
          operation(current);
          if (!flags.read) {
            state.writeTurn(current);
            const draft = state.readDraft(input.draftId); write(state, draft, draft.stateVersion);
          }
        });
      }
      function finishPhysical() {
        if (!flight.done || flight.pending.size) return;
        changeTurn(current => { current.physicalOutstanding = false; }, { settlement: true });
        flights.delete(key);
      }
      const execution = Object.fromEntries(['request', 'tool', 'io'].filter(kind => typeof options.execution?.[kind] === 'function')
        .map(kind => [kind, async (value, portContext) => {
          await authorize(`execute-${kind}`, initial.collectionId, currentRequestContext, combined);
          return options.execution[kind](value, portContext);
        }]));
      const ports = createTurnPorts({ changeTurn, signal: combined, requestContext: currentRequestContext,
        execution, track(promise) {
          flight.pending.add(promise);
          promise.then(() => { flight.pending.delete(promise); finishPhysical(); }, () => { flight.pending.delete(promise); finishPhysical(); });
        } });
      try {
        const result = await executeAuthorCore({ draft: read(input.draftId), turn, options, ports,
          signal: combined, requestContext: currentRequestContext, observeReview: options.authorization.observeReview ?? (() => null) });
        combined.throwIfAborted();
        return mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution !== turn.executionToken || current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Late result cannot change current content');
          const value = result.state;
          draft.intent = value.effectiveIntent; draft.plan = value.currentPlan ?? null; draft.resources = value.resourceSnapshot ?? null;
          draft.candidate = value.candidate ?? null; draft.diff = value.candidateDiff ?? null;
          const contentHash = hash(content(draft));
          if (draft.contentHash !== contentHash) {
            draft.contentRevision++; draft.contentHash = contentHash; draft.reviewReceipt = null; draft.approvalReceipt = null;
          }
          draft.status = result.outcome; draft.activeExecution = null;
          draft.diagnostics = [...(value.planDiagnostics ?? []), ...(value.compileDiagnostics ?? [])];
          if (value.reviewReceipt) {
            const receipt = { ...receiptBinding(draft), ...value.reviewReceipt, qualified: true };
            draft.reviewReceipt = { ...receipt, reviewRef: hash(receipt) };
          }
          current.status = result.outcome; current.executionToken = null;
          // Save the exact committed response, including the impending state-version increment.
          const response = view({ ...draft, stateVersion: draft.stateVersion + 1 });
          current.result = response; state.writeTurn(current);
          return response;
        });
      } catch (error) {
        mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution === turn.executionToken) {
            draft.activeExecution = null; draft.status = combined.aborted ? 'cancelled' :
              error.code === 'author-budget' || error.code === 'author-repair-limit' ? 'needs-revision' : 'failed';
            draft.diagnostics = [{ code: error.code ?? 'author-execution', message: error.message }];
            draft.reviewReceipt = null; draft.approvalReceipt = null;
          }
          current.status = draft.status; current.executionToken = null; current.failure = { code: error.code ?? 'author-execution', message: error.message };
          state.writeTurn(current);
        });
        return view(read(input.draftId));
      } finally { flight.done = true; finishPhysical(); }
    },
    async reviewCandidate(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('review', draft.collectionId, currentRequestContext, signal);
      if (!draft.candidate || input.candidateHash !== draft.candidate.hash || input.previousHash !== draft.previousHash) throw authorError('author-conflict', 'Exact candidate and previous identity are required');
      return { diff: reviewStandardCandidate(draft.candidate, draft.previousCandidate), receipt: clone(draft.reviewReceipt ?? null) };
    },
    async recordApproval(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('approve', draft.collectionId, currentRequestContext, signal);
      if (draft.activeExecution || !draft.reviewReceipt?.qualified || input.candidateHash !== draft.candidate?.hash || input.reviewRef !== draft.reviewReceipt.reviewRef ||
        input.previousHash !== draft.previousHash) throw authorError('author-approval', 'Approval must bind the qualified exact candidate and previous version');
      const observation = await options.authorization.verifyApproval?.({ ...receiptBinding(draft), reviewRef: input.reviewRef,
        approvalRef: input.approvalRef, requestContext: clone(currentRequestContext), signal });
      if (observation?.approved !== true || !observation.subjectId || !observation.approvalId) throw authorError('author-approval', 'Host did not observe explicit user approval');
      return mutate(draft.id, input.expectedStateVersion, current => {
        if (current.contentHash !== draft.contentHash) throw authorError('author-conflict', 'Content changed during approval');
        current.approvalReceipt = { ...receiptBinding(current), reviewRef: input.reviewRef, approvalRef: input.approvalRef, observation };
      });
    },
    async publish(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('publish', draft.collectionId, currentRequestContext, signal);
      requiredId(input.publicationId, 'publicationId');
      const fingerprint = hash({ candidateHash: input.candidateHash, previousHash: input.previousHash,
        reviewRef: input.reviewRef, approvalRef: input.approvalRef });
      const replay = draft.publications[input.publicationId];
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw authorError('author-conflict', 'Publication ID has different material');
        return { ...clone(replay), currentActive: store.readActive(draft.collectionId, draft.target.skillId)?.hash ?? null };
      }
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const binding = receiptBinding(current);
        if (current.activeExecution || !current.reviewReceipt?.qualified || !current.approvalReceipt || input.candidateHash !== current.candidate?.hash ||
          input.previousHash !== current.previousHash || input.reviewRef !== current.reviewReceipt.reviewRef ||
          input.approvalRef !== current.approvalReceipt.approvalRef ||
          Object.entries(binding).some(([key, value]) => current.approvalReceipt[key] !== value || current.reviewReceipt[key] !== value)) {
          throw authorError('author-approval', 'Current exact review and user approval are required');
        }
        checkCandidate(current.candidate);
        publishing = { candidateHash: input.candidateHash, reviewRef: input.reviewRef, approvalRef: input.approvalRef };
        try { store.publishAtomically({ candidate: current.candidate, ...input }); } finally { publishing = null; }
        const saved = { publicationId: input.publicationId, fingerprint, ...binding, status: 'saved', discovery: 'pending',
          collectionSnapshot: store.readCollection(current.collectionId), savedAt: new Date().toISOString() };
        current.publications[input.publicationId] = saved; current.savedReceipt = saved; current.status = 'saved';
        // write() after this callback commits alongside the formal version and active pointer.
        return { ...clone(saved), currentActive: input.candidateHash, stateVersion: current.stateVersion + 1 };
      });
    },
    async cancelTurn(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('cancel', draft.collectionId, currentRequestContext, signal);
      const result = mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const turn = state.readTurn(draft.id, input.turnId);
        if (!turn) throw authorError('author-turn-missing', 'Turn is unknown');
        const token = turn.executionToken; turn.executionToken = null; turn.status = 'cancelled'; state.writeTurn(turn);
        if (current.activeExecution === token) { current.activeExecution = null; current.status = 'cancelled'; }
      });
      flights.get(JSON.stringify([draft.id, input.turnId]))?.controller.abort(authorError('author-cancelled', 'Host cancelled turn'));
      return result;
    },
    async settleTurn(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('settle', draft.collectionId, currentRequestContext, signal);
      const observation = await options.authorization.verifySettlement?.({ ...input, requestContext: clone(currentRequestContext), signal });
      if (observation?.verified !== true) throw authorError('author-settlement', 'Trusted Host settlement evidence is required');
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const turn = state.readTurn(draft.id, input.turnId);
        if (!turn || turn.status === 'running') throw authorError('author-settlement', 'Fence a running turn before settlement');
        if (flights.get(JSON.stringify([draft.id, input.turnId]))?.pending.size) throw authorError('author-busy', 'Actual execution is still outstanding');
        if (observation.physicalDone !== true) throw authorError('author-settlement', 'Physical completion evidence is required');
        turn.physicalOutstanding = false; turn.settlement = { decision: input.decision, observation };
        if (input.decision === 'abandon') current.status = 'abandoned';
        else if (input.decision === 'confirm-no-effect' && observation.noEffect === true && Date.now() < turn.budget.deadlineMs) {
          turn.retryRef = randomUUID();
        } else if (input.decision !== 'confirm-result') throw authorError('author-settlement', 'Settlement decision/evidence mismatch');
        state.writeTurn(turn);
        return { retryRef: turn.retryRef ?? null, stateVersion: current.stateVersion + 1, budget: clone(turn.budget) };
      });
    },
    async discard(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('discard', draft.collectionId, currentRequestContext, signal);
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        if (state.turns(current.id).some(turn => turn.physicalOutstanding)) throw authorError('author-busy', 'Cancel and settle outstanding execution first');
        if (input.candidateHash !== (current.candidate?.hash ?? null)) throw authorError('author-conflict', 'Candidate changed');
        current.status = 'discarded'; current.candidate = null; current.reviewReceipt = null; current.approvalReceipt = null;
      });
    },
    createMcpOptions() {
      return { namespace: options.namespace, collectionIds: [...options.collectionIds], authorHost: host,
        store, resolveAuthoringInput: options.resolveAuthoringInput,
        authorize: async (request, context) => {
          await authorize(request.action, request.collectionId, context, request.signal); return true;
        },
        async applyCollectionPlan(plan, approvalRef, context, signal) {
          await authorize('collection-plan', plan.destination.id, context, signal);
          const { verifiedCollectionPlan } = await import('./collections.mjs');
          const verified = verifiedCollectionPlan(plan);
          collectionChange = { planHash: verified.planHash, approvalRef };
          try { return store.applyCollectionPlan(plan, approvalRef); } finally { collectionChange = null; }
        } };
    },
    async close({ mode = 'drain', timeoutMs = 5000 } = {}) {
      if (closed) return { closed: true, outstanding: 0 };
      closing = true;
      if (mode === 'cancel') for (const flight of flights.values()) flight.controller.abort(authorError('author-cancelled', 'Author Host closing'));
      const deadline = Date.now() + positive(timeoutMs, 5000, 'close timeout');
      while (flights.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (flights.size) return { closed: false, outstanding: flights.size };
      store.close(); closed = true;
      return { closed: true, outstanding: 0 };
    }
  };
  return Object.freeze(host);
}
