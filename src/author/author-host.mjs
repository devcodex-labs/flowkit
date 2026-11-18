import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { openLocalSkillStore } from './local-skill-store.mjs';
import { startAuthorDraft } from './draft.mjs';
import { checkCandidate, reviewStandardCandidate, prepareImportedStandardSkill } from './standard-artifact.mjs';
import { authorInput, authorTarget, authorIdentity as hash } from './host-target.mjs';
import { executeAuthorCore } from './host-core.mjs';
import { authorError, budgetPolicy, newTurnBudget, positive, createTurnPorts, jsonBytes } from './host-budget.mjs';

const clone = value => structuredClone(value);
const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const publicationView = (saved, currentActive, stateVersion) => clone({ ...select(saved,
  ['publicationId', 'namespace', 'storeId', 'draftId', 'collectionId', 'candidateHash', 'previousHash', 'status', 'discovery', 'generation', 'savedAt']),
  currentActive, isCurrent: currentActive === saved.candidateHash, ...(stateVersion === undefined ? {} : { stateVersion }) });
const content = draft => ({ intent: draft.intent?.intentRef?.effectiveIntentHash ?? null, choices: draft.choices, target: draft.target,
  coreIdentity: draft.coreIdentity, plan: draft.plan ?? null, resources: draft.resources ?? null, candidateHash: draft.candidate?.hash ?? null });
const requiredId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new TypeError(`${label} is required`);
  return value;
};

/** Create one namespace-owned Author service. Host clients, credentials and permissions stay Host-owned. */
export async function createWorkflowAuthorHost(supplied) {
  const options = { ...supplied };
  options.coreIdentity = JSON.parse(await readFile(new URL('./core/identity.json', import.meta.url), 'utf8'));
  requiredId(options.namespace, 'namespace');
  if (!Array.isArray(options.collectionIds) || !options.collectionIds.length || options.collectionIds.some(id => !id)) throw new TypeError('Authorized collection IDs are required');
  if (typeof options.authorization?.authorize !== 'function') throw new TypeError('Current-request Host authorization is required');
  if (typeof options.execution?.request !== 'function' || typeof options.execution?.createSession !== 'function') {
    throw authorError('author-executor', 'FKA_HOST_BINDING_MISSING: independently responsive execution and guarded request ports are required');
  }
  const policy = budgetPolicy(options.budgetPolicy);
  const capacity = { maxPhysicalExecutions: positive(options.capacity?.maxPhysicalExecutions, 4, 'physical executions'),
    maxPendingCandidates: positive(options.capacity?.maxPendingCandidates, 16, 'pending candidates'),
    maxDrafts: positive(options.capacity?.maxDrafts, 256, 'drafts'),
    maxDraftBytes: positive(options.capacity?.maxDraftBytes, 8 * 1024 * 1024, 'draft bytes') };
  const storageFile = path.resolve(requiredId(options.storageFile, 'storageFile'));
  options.workRoot = path.dirname(storageFile);
  await mkdir(options.workRoot, { recursive: true });
  let publishing = null, collectionChange = null, closing = false, closed = false, publicHost;
  const store = openLocalSkillStore(storageFile,
    binding => publishing?.candidateHash === binding.candidateHash && publishing?.reviewRef === binding.reviewRef && publishing?.approvalRef === binding.approvalRef,
    binding => collectionChange?.planHash === binding.planHash && collectionChange?.approvalRef === binding.approvalRef,
    { namespace: options.namespace });
  const meta = store.authorTransaction(state => state.meta());
  const flights = new Map();
  function view(draft) {
    const result = select(draft, ['id', 'status', 'collectionId', 'stateVersion', 'contentRevision', 'contentHash', 'goal', 'operation',
      'target', 'choices', 'questions', 'plan', 'candidate', 'previousHash', 'diff', 'diagnostics', 'reviewReceipt', 'approvalReceipt', 'coreIdentity']);
    if (draft.resources) result.resources = { ...select(draft.resources, ['ready', 'gap', 'options', 'hostProfile', 'safetyPolicies', 'catalogIdentity']),
      documents: draft.resources.documents?.map(item => item.evidence ?? item) ?? [],
      professionalSkills: draft.resources.professionalSkills?.map(item => select(item, ['nodeId', 'id', 'version', 'digest', 'approved'])) ?? [] };
    if (draft.savedReceipt) result.savedReceipt = publicationView(draft.savedReceipt, store.readActive(draft.collectionId, draft.target.skillId)?.hash ?? null);
    return clone({ ...result, storeId: meta.store_id, namespace: options.namespace });
  }
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
    const authorizedDraft = details.draftId ? read(details.draftId) : null;
    const binding = authorizedDraft ? { ownerScope: authorizedDraft.ownerScope, target: authorizedDraft.target, contentIdentity: receiptBinding(authorizedDraft) } : {};
    if (await options.authorization.authorize({ ...binding, ...details, action, collectionId, requestContext: clone(context), signal }) !== true) {
      throw authorError('author-unauthorized', 'Host denied the current action');
    }
    signal?.throwIfAborted();
  }
  function receiptBinding(draft) {
    return { namespace: options.namespace, storeId: meta.store_id, draftId: draft.id, collectionId: draft.collectionId,
      contentRevision: draft.contentRevision, contentHash: draft.contentHash, candidateHash: draft.candidate?.hash,
      planHash: hash(draft.plan ?? null), resourceHash: hash(draft.resources ?? null), coreHash: hash(options.coreIdentity),
      hostProfileHash: hash(options.hostProfile),
      reviewPolicy: options.authorization.reviewPolicy ?? 'separate-pass',
      previousHash: draft.previousHash };
  }
  const host = {
    async start(input, currentRequestContext, signal) {
      await authorize('start', input.collectionId, currentRequestContext, signal, { operation: input.operation ?? 'create', targetRef: input.targetRef, target: input.target });
      requiredId(input.requestId, 'requestId');
      let fingerprint = hash({ ...input, currentRequestContext });
      let imported;
      if (input.operation === 'import') {
        const source = await options.resolveImportSource?.(input.importSource, { requestContext: currentRequestContext, signal });
        if (!source?.candidate || !source.sourceRef) throw authorError('author-target', 'A trusted approved import source is required');
        imported = await prepareImportedStandardSkill(source.candidate, { mode: input.importSource.mode, collectionId: input.collectionId,
          skillId: input.importSource.mode === 'migration' ? source.candidate.manifest.skillId : input.target?.skillId ?? randomUUID(), sourceRef: source.sourceRef },
        { verifyImport: binding => options.authorization.verifyImport?.({ ...binding, requestContext: currentRequestContext, signal }) });
        fingerprint = hash({ ...input, currentRequestContext, sourceHash: source.candidate.hash });
      }
      return store.authorTransaction(state => {
        const drafts = state.drafts();
        const replay = drafts.find(draft => draft.startRequestId === input.requestId);
        if (replay) {
          if (replay.startFingerprint !== fingerprint) throw authorError('author-conflict', 'Start requestId has different material');
          return view(replay);
        }
        if (drafts.length >= capacity.maxDrafts) throw authorError('author-capacity', 'Retained draft capacity reached; Host retention decision required');
        const initial = startAuthorDraft(input.goal, { ...options.defaults, ...input.choices });
        const { previous, operation } = authorTarget(input, store);
        const importedTarget = imported && { skillId: imported.manifest.skillId, name: imported.manifest.name,
          description: input.goal, version: imported.manifest.version };
        const draft = { ...initial, namespace: options.namespace, collectionId: input.collectionId,
          startRequestId: input.requestId, startFingerprint: fingerprint, stateVersion: 1, contentRevision: 1,
          coreIdentity: options.coreIdentity,
          ownerScope: { principalId: currentRequestContext.principalId, workspaceRef: currentRequestContext.workspaceRef },
          target: { skillId: previous?.manifest.skillId ?? randomUUID(), name: previous?.manifest.name ?? 'workflow',
            description: input.goal, version: '1.0.0', ...input.target, ...importedTarget },
          operation, previousHash: previous?.hash ?? null,
          previousCandidate: previous, activeExecution: null, publications: {} };
        if (operation === 'update') {
          if (input.target?.version === previous.manifest.version) throw authorError('author-target', 'Choose a new unused target version');
          if (!input.target?.version) {
            draft.target.version = previous.manifest.version; draft.status = 'needs-clarification';
            const next = previous.manifest.version.replace(/(\d+)$/, number => String(Number(number) + 1));
            draft.questions.push({ id: 'target-version', question: 'Choose an unused version for this update',
              options: [{ value: next, label: next, reason: 'A separate version preserves existing approved Runs.' }, { value: 'custom', label: 'Choose another version' }],
              recommended: next, customAllowed: true });
          }
        }
        if (imported) {
          draft.candidate = imported; draft.status = 'needs-review';
          draft.plan = { importedDefinition: imported.manifest.workflowDefinition, importSource: input.importSource };
          draft.resources = { ready: true, hostProfile: imported.manifest.hostProfile,
            documents: imported.manifest.documents ?? [], professionalSkills: imported.manifest.professionalSkills };
        }
        draft.contentHash = hash(content(draft));
        if (jsonBytes(draft) > capacity.maxDraftBytes) throw authorError('author-capacity', 'Draft byte capacity exceeded');
        state.writeDraft(draft, null);
        return view(draft);
      });
    },
    async readDraft(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('read', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      return view(draft);
    },
    async advanceTurn(input, currentRequestContext, signal) {
      const initial = read(input.draftId);
      await authorize('advance', initial.collectionId, currentRequestContext, signal, { draftId: initial.id });
      requiredId(input.turnId, 'turnId');
      if ((input.baseline === undefined) !== (input.baselineId === undefined)) throw new TypeError('Intent baseline and ID must be supplied together');
      if (!['authoring', 'review-only', 'retry'].includes(input.kind ?? 'authoring')) throw new TypeError('Unknown Author turn kind');
      const request = clone({ input: input.input, contextSnapshot: input.contextSnapshot ?? null,
        ...(input.confirmedPlanHash ? { confirmedPlanHash: input.confirmedPlanHash } : {}),
        ...(input.baseline === undefined ? {} : { baseline: input.baseline, baselineId: input.baselineId }),
        ...(input.confirmedConstraintIds ? { confirmedConstraintIds: input.confirmedConstraintIds } : {}),
        safetyPolicies: input.safetyPolicies ?? [] });
      const priorTurn = input.kind === 'retry' ? store.authorTransaction(state => state.readTurn(input.draftId, input.turnId)) : null;
      const fingerprint = hash({ request, choices: input.choices ?? {}, kind: priorTurn?.kind ?? input.kind ?? 'authoring', currentRequestContext,
        operation: initial.operation, target: { ...initial.target, ...input.target }, previousHash: initial.previousHash, hostProfile: options.hostProfile, coreIdentity: options.coreIdentity });
      let turn, replay;
      store.authorTransaction(state => {
        const draft = state.readDraft(input.draftId);
        turn = state.readTurn(draft.id, input.turnId);
        if (turn) {
          if (turn.fingerprint !== fingerprint) throw authorError('author-conflict', 'Turn ID has different bound material');
          if (input.kind !== 'retry' || turn.consumedRetryRefs?.[input.retryRef]) { replay = turn.result ?? view(draft); return; }
          if (!input.retryRef || turn.retryRef !== input.retryRef || turn.retryStateVersion !== draft.stateVersion ||
            input.expectedStateVersion !== draft.stateVersion || turn.physicalOutstanding || turn.status === 'running' ||
            Date.now() >= turn.budget.deadlineMs) throw authorError('author-settlement', 'Retry requires its unconsumed, current no-effect settlement and remaining budget');
          const attemptId = randomUUID();
          turn.attemptHistory ??= []; turn.attemptHistory.push({ attemptId: turn.attemptId, status: turn.status, failure: turn.failure ?? null });
          turn.consumedRetryRefs ??= {}; turn.consumedRetryRefs[input.retryRef] = attemptId;
          turn.attemptId = attemptId; turn.executionToken = randomUUID(); turn.status = 'running'; turn.physicalOutstanding = true;
          turn.retryRef = null; delete turn.result; delete turn.failure;
          draft.activeExecution = turn.executionToken; draft.status = 'running';
          draft.reviewReceipt = null; draft.approvalReceipt = null;
          state.writeTurn(turn); write(state, draft, draft.stateVersion); return;
        }
        if (input.kind === 'retry') throw authorError('author-settlement', 'Unknown original turn cannot be retried');
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
        if (input.target) {
          if (input.target.skillId && input.target.skillId !== draft.target.skillId) throw authorError('author-target', 'Target Skill ID is fixed for this draft');
          draft.target = { ...draft.target, ...input.target };
          if (draft.operation === 'update' && draft.target.version === draft.previousCandidate.manifest.version) throw authorError('author-target', 'Choose a new unused target version');
        }
        startAuthorDraft(draft.goal, draft.choices);
        turn = { draftId: draft.id, turnId: input.turnId, kind: input.kind ?? 'authoring', attemptId: randomUUID(), executionToken: randomUUID(),
          priorReview: draft.reviewReceipt ?? null, priorApproval: draft.approvalReceipt ?? null,
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
        if (flight.settled || !flight.done || flight.pending.size) return;
        changeTurn(current => { current.physicalOutstanding = false; }, { settlement: true });
        flight.settled = true;
        flights.delete(key);
      }
      const ports = createTurnPorts({ changeTurn, signal: combined, requestContext: currentRequestContext,
        execution: options.execution, beforeDispatch: kind => authorize(`execute-${kind}`, initial.collectionId, currentRequestContext, combined, { draftId: initial.id }), track(promise) {
          flight.pending.add(promise);
          promise.then(() => { flight.pending.delete(promise); finishPhysical(); }, () => { flight.pending.delete(promise); finishPhysical(); });
        } });
      try {
        const result = await executeAuthorCore({ draft: read(input.draftId), turn, options, ports,
          signal: combined, requestContext: currentRequestContext, observeReview: options.authorization.observeReview ?? (() => null) });
        combined.throwIfAborted();
        await authorize('advance-commit', initial.collectionId, currentRequestContext, combined, { draftId: initial.id });
        const response = mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution !== turn.executionToken || current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Late result cannot change current content');
          const value = result.state;
          draft.intent = value.effectiveIntent; draft.plan = value.currentPlan ?? null; draft.resources = value.resourceSnapshot ?? null;
          if (result.intentBaseline !== undefined) draft.intentBaseline = result.intentBaseline;
          draft.coreIdentity = result.coreIdentity;
          draft.authorizedRequest = value.authorizedRequest; draft.baselineEvidence = value.baselineEvidence;
          draft.candidate = value.candidate ?? null; draft.diff = value.candidateDiff ?? null;
          const contentHash = hash(content(draft));
          if (draft.contentHash !== contentHash) {
            draft.contentRevision++; draft.contentHash = contentHash; draft.reviewReceipt = null; draft.approvalReceipt = null;
          }
          draft.status = result.outcome; draft.activeExecution = null;
          draft.questions = result.outcome === 'needs-clarification' ? (value.questions ?? draft.questions) : [];
          draft.diagnostics = [...(value.planDiagnostics ?? []), ...(value.compileDiagnostics ?? [])];
          if (value.reuseReview && current.priorReview?.contentHash === draft.contentHash) {
            draft.reviewReceipt = current.priorReview; draft.approvalReceipt = current.priorApproval;
          } else if (value.reviewReceipt) {
            const receipt = { ...receiptBinding(draft), ...value.reviewReceipt, qualified: true };
            draft.reviewReceipt = { ...receipt, reviewRef: hash(receipt) };
          }
          current.status = result.outcome; current.executionToken = null;
          if (!flight.pending.size) current.physicalOutstanding = false;
          // Save the exact committed response, including the impending state-version increment.
          const response = view({ ...draft, stateVersion: draft.stateVersion + 1 });
          current.result = response; state.writeTurn(current);
          return response;
        });
        if (!flight.pending.size) { flight.settled = true; flights.delete(key); }
        return response;
      } catch (error) {
        mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution === turn.executionToken) {
            draft.activeExecution = null; draft.status = combined.aborted ? 'cancelled' : (error.outcome ??
              (error.code === 'author-budget' || error.code === 'author-repair-limit' ? 'needs-revision' : 'failed'));
            draft.diagnostics = [{ code: error.code ?? 'author-execution', message: error.message }];
            draft.questions = error.questions ?? [];
            draft.reviewReceipt = null; draft.approvalReceipt = null;
          }
          current.status = draft.status; current.executionToken = null; current.failure = { code: error.code ?? 'author-execution', message: error.message };
          state.writeTurn(current);
        });
        flight.done = true; finishPhysical();
        await authorize('read', initial.collectionId, currentRequestContext, signal, { draftId: initial.id });
        return view(read(input.draftId));
      } finally { flight.done = true; finishPhysical(); }
    },
    async reviewCandidate(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('review', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      if (!draft.candidate || input.candidateHash !== draft.candidate.hash || input.previousHash !== draft.previousHash) throw authorError('author-conflict', 'Exact candidate and previous identity are required');
      const receipt = clone(draft.reviewReceipt ?? null);
      if (receipt && Object.entries(receiptBinding(draft)).some(([key, value]) => receipt[key] !== value)) {
        receipt.qualified = false; receipt.reason = 'Current content/core/Host policy differs; run review-only or rebuild';
      }
      return { diff: reviewStandardCandidate(draft.candidate, draft.previousCandidate), receipt };
    },
    async recordApproval(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('approve', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef });
      if (draft.activeExecution || !draft.reviewReceipt?.qualified || input.candidateHash !== draft.candidate?.hash || input.reviewRef !== draft.reviewReceipt.reviewRef ||
        input.previousHash !== draft.previousHash || Object.entries(receiptBinding(draft)).some(([key, value]) => draft.reviewReceipt[key] !== value)) throw authorError('author-approval', 'Approval must bind the qualified exact candidate and previous version');
      const observation = await options.authorization.verifyApproval?.({ ...receiptBinding(draft), reviewRef: input.reviewRef,
        approvalRef: input.approvalRef, requestContext: clone(currentRequestContext), signal });
      if (observation?.approved !== true || !observation.subjectId || !observation.approvalId) throw authorError('author-approval', 'Host did not observe explicit user approval');
      await authorize('approve', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef });
      return mutate(draft.id, input.expectedStateVersion, current => {
        if (current.contentHash !== draft.contentHash) throw authorError('author-conflict', 'Content changed during approval');
        current.approvalReceipt = { ...receiptBinding(current), reviewRef: input.reviewRef, approvalRef: input.approvalRef, observation };
      });
    },
    async publish(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('publish', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef, publicationId: input.publicationId });
      requiredId(input.publicationId, 'publicationId');
      const fingerprint = hash({ candidateHash: input.candidateHash, previousHash: input.previousHash,
        reviewRef: input.reviewRef, approvalRef: input.approvalRef });
      const replay = draft.publications[input.publicationId];
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw authorError('author-conflict', 'Publication ID has different material');
        return publicationView(replay, store.readActive(draft.collectionId, draft.target.skillId)?.hash ?? null, draft.stateVersion);
      }
      if (draft.activeExecution || !draft.reviewReceipt?.qualified || input.candidateHash !== draft.candidate?.hash ||
        input.reviewRef !== draft.reviewReceipt.reviewRef || input.previousHash !== draft.previousHash) {
        throw authorError('author-approval', 'Current exact review and user approval are required');
      }
      const observation = await options.authorization.verifyApproval?.({ ...receiptBinding(draft), reviewRef: input.reviewRef,
        approvalRef: input.approvalRef, requestContext: clone(currentRequestContext), signal });
      if (observation?.approved !== true || !observation.subjectId || !observation.approvalId) throw authorError('author-approval', 'Current exact review and user approval are required');
      await authorize('publish', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef, publicationId: input.publicationId });
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const binding = receiptBinding(current);
        if (current.contentHash !== draft.contentHash || current.reviewReceipt?.reviewRef !== draft.reviewReceipt.reviewRef) throw authorError('author-conflict', 'Content changed during publication approval verification');
        current.approvalReceipt = { ...binding, reviewRef: input.reviewRef, approvalRef: input.approvalRef, observation };
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
        return publicationView(saved, input.candidateHash, current.stateVersion + 1);
      });
    },
    async cancelTurn(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('cancel', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
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
      const draft = read(input.draftId); await authorize('settle', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      const observation = await options.authorization.verifySettlement?.({ ...input, requestContext: clone(currentRequestContext), signal });
      if (observation?.verified !== true) throw authorError('author-settlement', 'Trusted Host settlement evidence is required');
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const turn = state.readTurn(draft.id, input.turnId);
        if (!turn || turn.status === 'running') throw authorError('author-settlement', 'Fence a running turn before settlement');
        if (flights.get(JSON.stringify([draft.id, input.turnId]))?.pending.size) throw authorError('author-busy', 'Actual execution is still outstanding');
        if (observation.physicalDone !== true) throw authorError('author-settlement', 'Physical completion evidence is required');
        turn.physicalOutstanding = false; turn.settlement = { decision: input.decision, observation };
        if (input.decision === 'abandon') current.status = 'abandoned';
        else if (input.decision === 'confirm-no-effect' && observation.noEffect === true) {
          const budget = turn.budget;
          const remaining = Date.now() < budget.deadlineMs && budget.used.requests < budget.limits.maxRequests &&
            budget.used.toolCalls < budget.limits.maxToolCalls && budget.used.ioCalls < budget.limits.maxIoCalls && budget.used.bytes < budget.limits.maxBytes;
          turn.retryRef = remaining ? turn.retryRef ?? randomUUID() : null; turn.retryStateVersion = current.stateVersion + 1;
        } else if (input.decision !== 'confirm-result') throw authorError('author-settlement', 'Settlement decision/evidence mismatch');
        state.writeTurn(turn);
        return { retryRef: turn.retryRef ?? null, stateVersion: current.stateVersion + 1, budget: clone(turn.budget) };
      });
    },
    async discard(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('discard', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        if (state.turns(current.id).some(turn => turn.physicalOutstanding)) throw authorError('author-busy', 'Cancel and settle outstanding execution first');
        if (input.candidateHash !== (current.candidate?.hash ?? null)) throw authorError('author-conflict', 'Candidate changed');
        current.status = 'discarded'; current.candidate = null; current.reviewReceipt = null; current.approvalReceipt = null;
      });
    },
    createMcpOptions(currentRequestContext, bindings = {}) {
      const requestContext = currentRequestContext && authorInput(currentRequestContext, policy.maxBytes);
      return { namespace: options.namespace, collectionIds: [...options.collectionIds], authorHost: publicHost,
        requestContext, store, resolveAuthoringInput: bindings.resolveAuthoringInput ?? options.resolveAuthoringInput,
        resolveCollectionPlan: bindings.resolveCollectionPlan, runWorkflow: bindings.runWorkflow, limits: bindings.limits,
        authorize: async (request, context = requestContext) => {
          await authorize(request.action ?? request.operation, request.collectionId, context, request.signal); return true;
        },
        async applyCollectionPlan(plan, approvalRef, context, signal) {
          const { verifiedCollectionPlan } = await import('./collections.mjs');
          const verified = verifiedCollectionPlan(plan);
          await authorize('collection-plan', plan.destination.id, context ?? requestContext, signal, { plan: verified.plan, planHash: verified.planHash, approvalRef });
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
  publicHost = Object.freeze(Object.fromEntries(Object.entries(host).map(([name, method]) => [name,
    ['createMcpOptions', 'close'].includes(name) ? method : async (input, context, signal) =>
      method(authorInput(input, policy.maxBytes), authorInput(context, policy.maxBytes), signal)])));
  return publicHost;
}
