import path from 'node:path';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { during } from '../runtime/tasks.mjs';
import { openLocalSkillStore } from './local-skill-store.mjs';
import { startAuthorDraft } from './draft.mjs';
import { checkCandidate, reviewStandardCandidate, prepareImportedStandardSkill } from './standard-artifact.mjs';
import { authorInput, authorTarget, authorIdentity as hash } from './host-target.mjs';
import { executeAuthorCore, rejectedReview } from './host-core.mjs';
import { discoverPublication, cleanupPublicationGeneration } from './host-discovery.mjs';
import { authorError, budgetPolicy, newTurnBudget, positive, createTurnPorts, jsonBytes } from './host-budget.mjs';

const clone = value => structuredClone(value);
const select = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const publicationView = (saved, currentActive, stateVersion) => clone({ ...select(saved,
  ['publicationId', 'namespace', 'storeId', 'draftId', 'collectionId', 'candidateHash', 'previousHash', 'status', 'discovery', 'discoveryError', 'savedAt']),
  ...(saved.generation ? { generation: select(saved.generation, ['discoveryRoot', 'collectionId', 'directory', 'manifestHash', 'generationId', 'snapshotHash']) } : {}),
  currentActive, isCurrent: currentActive === saved.candidateHash, ...(stateVersion === undefined ? {} : { stateVersion }) });
const content = draft => ({ intent: draft.intent?.intentRef?.effectiveIntentHash ?? null, choices: draft.choices, target: draft.target,
  coreIdentity: draft.coreIdentity, plan: draft.plan ?? null, resources: draft.resources ?? null, candidateHash: draft.candidate?.hash ?? null });
const requiredId = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new TypeError(`${label} is required`);
  return value;
};
// Multiple connections in this process share observed physical ownership, never a TTL takeover.
const physicalExecutions = new Map();
const NO_CHANGE = Symbol('no-change');
const isTerminalDraft = draft => ['discarded', 'abandoned', 'saved', 'expired'].includes(draft.status);

function activeReviewRejection(draft) {
  if (!draft.candidate) return;
  if (draft.reviewRejection?.candidateHash === draft.candidate.hash) return draft.reviewRejection;
  if (draft.diagnostics?.some(entry => entry.code === 'FKA_REVIEW_NOT_QUALIFIED' && entry.candidateHash === draft.candidate.hash)) {
    return rejectedReview(draft.candidate);
  }
}

function assertUncommittedTurn(draft, turn, decision) {
  // An abandoned attempt may still need to release an external hold after trusted reconciliation.
  const reconcilingAbandonment = decision === 'confirm-no-effect' && draft.status === 'abandoned' && turn.status === 'abandoned';
  if (turn.result || (isTerminalDraft(draft) && !reconcilingAbandonment)) {
    throw authorError('author-settlement', 'Committed turns and terminal drafts cannot be settled or retried');
  }
}

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
  const requiredCapacity = ['maxPhysicalExecutions', 'maxDrafts', 'maxDraftBytes', 'maxRetainedDraftBytes', 'maxReceiptBytes', 'maxTurnsPerDraft'];
  if (requiredCapacity.some(key => options.capacity?.[key] === undefined)) throw Object.assign(authorError('author-executor', 'Host must configure finite execution, draft and receipt capacities'), {
    missingBindings: requiredCapacity.filter(key => options.capacity?.[key] === undefined) });
  const capacity = { maxPhysicalExecutions: positive(options.capacity?.maxPhysicalExecutions, 4, 'physical executions'),
    maxPendingCandidates: positive(options.capacity?.maxPendingCandidates, 16, 'pending candidates'),
    maxDrafts: positive(options.capacity?.maxDrafts, 256, 'drafts'),
    maxDraftBytes: positive(options.capacity?.maxDraftBytes, 8 * 1024 * 1024, 'draft bytes'),
    maxRetainedDraftBytes: positive(options.capacity.maxRetainedDraftBytes, 64 * 1024 * 1024, 'retained draft bytes'),
    maxReceiptBytes: positive(options.capacity.maxReceiptBytes, 64 * 1024 * 1024, 'receipt bytes'),
    maxTurnsPerDraft: positive(options.capacity.maxTurnsPerDraft, 256, 'turn receipts per draft') };
  if (capacity.maxDrafts > 100000 || capacity.maxTurnsPerDraft > 10000) throw authorError('author-capacity', 'Host capacity exceeds bounded inventory limits');
  options.hostProfile = authorInput(options.hostProfile, policy.maxBytes);
  const storageFile = path.resolve(requiredId(options.storageFile, 'storageFile'));
  options.workRoot = path.dirname(storageFile);
  await mkdir(options.workRoot, { recursive: true });
  if (options.discovery?.root && typeof options.discovery.readMapping === 'function' && typeof options.discovery.compareAndSetMapping === 'function') {
    await mkdir(options.discovery.root, { recursive: true });
    options.discovery = { ...options.discovery, root: await realpath(options.discovery.root) };
  }
  let publishing = null, collectionChange = null, closing = false, closed = false, publicHost;
  const store = openLocalSkillStore(storageFile,
    binding => publishing?.candidateHash === binding.candidateHash && publishing?.reviewRef === binding.reviewRef && publishing?.approvalRef === binding.approvalRef,
    binding => collectionChange?.planHash === binding.planHash && collectionChange?.approvalRef === binding.approvalRef,
    { namespace: options.namespace });
  const meta = store.authorTransaction(state => state.meta());
  const ownerId = randomUUID();
  const flights = new Map();
  const publications = new Map();
  function physicalSlotUnavailable(state, draft, activeDrafts = state.activeDrafts(capacity.maxDrafts + 1)) {
    const physical = activeDrafts.flatMap(item => state.turns(item.id)).filter(turn => turn.physicalOutstanding);
    return Boolean(draft.activeExecution || physical.some(turn => turn.draftId === draft.id) || physical.length >= capacity.maxPhysicalExecutions);
  }
  function view(draft, state) {
    const result = select(draft, ['id', 'status', 'collectionId', 'stateVersion', 'contentRevision', 'contentHash', 'goal', 'operation',
      'target', 'choices', 'questions', 'plan', 'candidate', 'previousHash', 'diff', 'diagnostics', 'reviewReceipt', 'approvalReceipt', 'coreIdentity',
      'reconciliationRequired', 'pendingTurnIds', 'bodyPurged']);
    const rejection = activeReviewRejection(draft);
    if (rejection) result.reviewRejection = rejection;
    if (result.reviewReceipt && Object.entries(receiptBinding(draft)).some(([key, value]) => result.reviewReceipt[key] !== value)) {
      result.reviewReceipt = { ...result.reviewReceipt, qualified: false, reason: 'Current content/core/Host policy differs; run review-only or rebuild' };
      result.approvalReceipt = null;
      if (['approved', 'candidate-ready'].includes(result.status)) result.status = 'needs-review';
    }
    if (draft.recoveryRef) result.recoveryRef = draft.recoveryRef;
    const turns = state ? state.turns(draft.id, capacity.maxTurnsPerDraft + 1) :
      store.authorTransaction(state => state.turns(draft.id, capacity.maxTurnsPerDraft + 1));
    result.physicalOutstanding = turns.filter(turn => turn.physicalOutstanding).map(turn => ({ turnId: turn.turnId, attemptId: turn.attemptId }));
    if (draft.status === 'running' && turns.some(turn => turn.status === 'running' && turn.ownerId !== ownerId &&
      !physicalExecutions.has(JSON.stringify([meta.store_id, draft.id, turn.turnId])))) {
      result.status = 'reconciliation-required'; result.reconciliationRequired = true;
    }
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
    const usage = state.usage();
    if (usage.draftBytes > capacity.maxRetainedDraftBytes || usage.receiptBytes + usage.tombstoneBytes > capacity.maxReceiptBytes) {
      throw authorError('author-capacity', 'Retained draft/receipt byte capacity reached; explicit Host retention decision required');
    }
  }
  function mutate(id, expected, operation) {
    return store.authorTransaction(state => {
      const draft = state.readDraft(id);
      if (!draft) throw authorError('author-draft-missing', 'Draft ID is unknown or expired');
      if (expected !== undefined && draft.stateVersion !== expected) throw authorError('author-conflict', 'Draft stateVersion changed');
      const result = operation(draft, state);
      if (result === NO_CHANGE) return view(draft, state);
      write(state, draft, draft.stateVersion);
      return result ?? view(draft, state);
    });
  }
  async function authorize(action, collectionId, context, signal, details = {}) {
    signal?.throwIfAborted();
    if (closed || closing && !['read', 'cancel', 'settle', 'advance-commit'].includes(action) && !action.startsWith('execute-') && !action.startsWith('discovery')) throw authorError('author-closed', 'Author service is closing');
    if (!context || context.namespace !== options.namespace || !context.principalId || !context.sessionId ||
      !context.workspaceId || !context.authorizationSnapshotRef || !Array.isArray(context.authorizedCollections) || !context.authorizedCollections.includes(collectionId) ||
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
  /** Only a durable, completed core result may be promoted; never resume a partial Standard Run. */
  function applyCoreResult(draft, state, turn, result) {
    if (turn.baseContentHash !== draft.contentHash || hash(result.coreIdentity) !== hash(options.coreIdentity)) {
      throw authorError('author-conflict', 'Content or core changed after this turn was accepted');
    }
    const value = result.state;
    if (value.candidate) checkCandidate(value.candidate);
    draft.intent = value.effectiveIntent; draft.plan = value.currentPlan ?? null; draft.resources = value.resourceSnapshot ?? null;
    if (result.intentBaseline !== undefined) draft.intentBaseline = result.intentBaseline;
    draft.coreIdentity = result.coreIdentity; draft.authorizedRequest = value.authorizedRequest; draft.baselineEvidence = value.baselineEvidence;
    draft.candidate = value.candidate ?? null; draft.diff = value.candidateDiff ?? null;
    const contentHash = hash(content(draft));
    if (draft.contentHash !== contentHash) { draft.contentRevision++; draft.contentHash = contentHash; draft.reviewReceipt = null; draft.approvalReceipt = null; }
    draft.status = result.outcome; draft.activeExecution = null; draft.reconciliationRequired = false; delete draft.recoveryRef;
    draft.questions = result.outcome === 'needs-clarification' ? value.questions ?? draft.questions : [];
    draft.diagnostics = [...(value.planDiagnostics ?? []), ...(value.compileDiagnostics ?? []), ...(value.reviewDiagnostics ?? [])];
    if (value.reuseReview && turn.priorReview?.contentHash === draft.contentHash &&
      Object.entries(receiptBinding(draft)).every(([key, item]) => turn.priorReview[key] === item)) {
      draft.reviewReceipt = turn.priorReview; draft.approvalReceipt = turn.priorApproval;
    } else if (value.reviewReceipt) {
      const receipt = { ...receiptBinding(draft), ...value.reviewReceipt, qualified: true };
      draft.reviewReceipt = { ...receipt, reviewRef: hash(receipt) };
    }
    if (value.reviewRejection) draft.reviewRejection = value.reviewRejection;
    if (draft.reviewRejection?.candidateHash !== draft.candidate?.hash || draft.reviewReceipt?.qualified) delete draft.reviewRejection;
    if (result.outcome === 'candidate-ready' && !draft.reviewReceipt?.qualified) throw authorError('author-review', 'Completed result has no applicable review qualification');
    if (draft.approvalReceipt && draft.reviewReceipt?.qualified) draft.status = 'approved';
    turn.status = result.outcome; turn.executionToken = null; turn.reconciliationRequired = false;
    delete turn.preparedResult;
    const response = view({ ...draft, stateVersion: draft.stateVersion + 1 }, state);
    turn.result = response; state.writeTurn(turn);
    return response;
  }
  async function discover(draftId, publicationId, context, signal) {
    const key = JSON.stringify([draftId, publicationId]);
    if (publications.has(key)) return publications.get(key).promise;
    if (publications.size >= capacity.maxPhysicalExecutions) return;
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = discoverPublication({ store, options, draftId, publicationId, context, signal: combined, read, mutate, authorize });
    publications.set(key, { controller, promise, draftId, publicationId });
    try { await promise; } finally { publications.delete(key); }
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
        const drafts = state.activeDrafts(capacity.maxDrafts + 1);
        const replay = state.findStartRequest(input.requestId);
        if (replay) {
          if (replay.bodyPurged) throw authorError('author-expired', 'Start requestId is expired; it cannot create a new operation');
          if (replay.startFingerprint !== fingerprint) throw authorError('author-conflict', 'Start requestId has different material');
          return view(replay, state);
        }
        if (drafts.filter(draft => !draft.bodyPurged).length >= capacity.maxDrafts) throw authorError('author-capacity', 'Retained draft capacity reached; Host retention decision required');
        const collection = store.readCollectionMetadata(input.collectionId, { limit: 1 })?.collection;
        const initial = startAuthorDraft(input.goal, { ...options.defaults, ...(collection ? { collectionName: collection.name } : {}), ...input.choices });
        const { previous, operation } = authorTarget(input, store);
        const importedTarget = imported && { skillId: imported.manifest.skillId, name: imported.manifest.name,
          description: input.goal, version: imported.manifest.version };
        const draft = { ...initial, namespace: options.namespace, collectionId: input.collectionId,
          startRequestId: input.requestId, startFingerprint: fingerprint, stateVersion: 1, contentRevision: 1,
          coreIdentity: options.coreIdentity,
          ownerScope: { principalId: currentRequestContext.principalId, workspaceId: currentRequestContext.workspaceId },
          target: { skillId: previous?.manifest.skillId ?? randomUUID(), name: previous?.manifest.name ?? 'workflow',
            description: input.goal, version: '1.0.0', ...input.target, ...importedTarget },
          operation, previousHash: previous?.hash ?? null,
          collectionBinding: collection ? hash(collection) : null,
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
        if (state.usage().draftBytes > capacity.maxRetainedDraftBytes) throw authorError('author-capacity', 'Retained draft byte capacity reached');
        return view(draft, state);
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
        ...(input.candidateHash === undefined ? {} : { candidateHash: input.candidateHash }),
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
          if (turn.status === 'expired') throw authorError('author-expired', 'Turn ID is expired and cannot be replayed as a new execution');
          if (turn.fingerprint !== fingerprint) throw authorError('author-conflict', 'Turn ID has different bound material');
          if (input.kind !== 'retry' || turn.consumedRetryRefs && Object.hasOwn(turn.consumedRetryRefs, input.retryRef)) { replay = turn.result ?? view(draft, state); return; }
          assertUncommittedTurn(draft, turn);
          if (!input.retryRef || turn.retryRef !== input.retryRef || turn.retryStateVersion !== draft.stateVersion ||
            input.expectedStateVersion !== draft.stateVersion || turn.physicalOutstanding || turn.status === 'running' ||
            Date.now() >= turn.budget.deadlineMs) throw authorError('author-settlement', 'Retry requires its unconsumed, current no-effect settlement and remaining budget');
          // Check before consuming the reference, in the same SQLite transaction that starts the attempt.
          if (physicalSlotUnavailable(state, draft)) throw authorError('author-busy', 'No physical Author execution slot is available');
          const attemptId = randomUUID();
          turn.attemptHistory ??= []; turn.attemptHistory.push({ attemptId: turn.attemptId, status: turn.status, failure: turn.failure ?? null });
          turn.consumedRetryRefs ??= {}; turn.consumedRetryRefs[input.retryRef] = attemptId;
          turn.attemptId = attemptId; turn.ownerId = ownerId; turn.executionToken = randomUUID(); turn.status = 'running'; turn.physicalOutstanding = true;
          turn.retryRef = null; delete turn.result; delete turn.failure;
          delete turn.preparedResult; delete turn.preparedResultHash; delete draft.recoveryRef;
          draft.activeExecution = turn.executionToken; draft.status = 'running';
          draft.reviewReceipt = null; draft.approvalReceipt = null;
          state.writeTurn(turn); write(state, draft, draft.stateVersion); return;
        }
        if (input.kind === 'retry') throw authorError('author-settlement', 'Unknown original turn cannot be retried');
        if (draft.stateVersion !== input.expectedStateVersion) throw authorError('author-conflict', 'Draft stateVersion changed');
        if (isTerminalDraft(draft)) throw authorError('author-terminal', 'Draft is terminal; start an explicit update draft for a saved version');
        if (Object.hasOwn(request, 'candidateHash') && request.candidateHash !== draft.candidate?.hash) {
          throw authorError('author-conflict', 'Review action must address the exact current candidate');
        }
        if (Object.hasOwn(request, 'candidateHash') && input.kind !== 'review-only' && !activeReviewRejection(draft)) {
          throw authorError('author-conflict', 'The rejected review is no longer current');
        }
        const ownTurns = state.turns(draft.id, capacity.maxTurnsPerDraft + 1);
        if (ownTurns.length >= capacity.maxTurnsPerDraft) throw authorError('author-capacity', 'Retained turn receipt capacity reached');
        const all = state.activeDrafts(capacity.maxDrafts + 1);
        if (physicalSlotUnavailable(state, draft, all) ||
          ownTurns.some(item => item.reconciliationRequired && !item.settlement)) {
          draft.pendingInputs ??= {};
          if (Object.keys(draft.pendingInputs).length >= 4 && !Object.hasOwn(draft.pendingInputs, input.turnId)) throw authorError('author-capacity', 'Pending input capacity reached');
          const old = Object.hasOwn(draft.pendingInputs, input.turnId) ? draft.pendingInputs[input.turnId] : null;
          if (old && old.fingerprint !== fingerprint) throw authorError('author-conflict', 'Pending turn has different material');
          Object.defineProperty(draft.pendingInputs, input.turnId, { value: { fingerprint, request, choices: input.choices ?? {}, target: input.target ?? null }, enumerable: true, writable: true, configurable: true });
          draft.pendingTurnIds = Object.keys(draft.pendingInputs);
          write(state, draft, draft.stateVersion);
          replay = { ...view(draft, state), outcome: 'blocked-by-inflight' }; return;
        }
        if (draft.pendingInputs && Object.hasOwn(draft.pendingInputs, input.turnId) && draft.pendingInputs[input.turnId].fingerprint !== fingerprint) throw authorError('author-conflict', 'Pending input changed');
        if (draft.pendingInputs) { delete draft.pendingInputs[input.turnId]; draft.pendingTurnIds = Object.keys(draft.pendingInputs); }
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
        // Follow the last admitted authoring turn, including a turn that never
        // produced a core result. Client-provided turn IDs have no ordering.
        const lastTurn = draft.lastAuthoringTurnId && state.readTurn(draft.id, draft.lastAuthoringTurnId);
        const previous = draft.authorizedRequest;
        const previousInput = lastTurn?.request.input ?? previous?.input;
        const awaitingAnswer = draft.status === 'needs-clarification' &&
          (request.input !== previousInput || draft.questions.some(({ id }) => id !== 'execution-mode' && id !== 'target-version'));
        const afterFailure = draft.status === 'failed' || draft.status === 'needs-revision';
        const rejection = input.kind === 'review-only' ? undefined : activeReviewRejection(draft);
        const reviewRevision = rejection ? select(rejection, ['candidateHash', 'findings']) :
          input.kind !== 'review-only' && !draft.candidate && (awaitingAnswer || afterFailure) ? lastTurn?.reviewRevision : undefined;
        const clarifyingDraft = input.kind !== 'review-only' && draft.operation === 'create' && !draft.candidate &&
          (awaitingAnswer || afterFailure) && typeof previousInput === 'string' && !request.confirmedPlanHash &&
          !Object.hasOwn(request, 'baseline') && !request.confirmedConstraintIds?.length &&
          !ownTurns.some(item => item.result?.candidate || Object.hasOwn(item.request ?? {}, 'baseline') ||
            item.request?.confirmedPlanHash || item.request?.confirmedConstraintIds?.length);
        let draftInputs, draftContextSnapshot, answeredQuestionIds;
        if (clarifyingDraft || reviewRevision) {
          draftInputs = [...(lastTurn?.draftInputs ?? previous?.draftInputs ?? [draft.goal])];
          if (typeof previousInput === 'string' && draftInputs.at(-1) !== previousInput) draftInputs.push(previousInput);
          if (draftInputs.at(-1) !== request.input) draftInputs.push(request.input);
          draftContextSnapshot = request.contextSnapshot ?? lastTurn?.draftContextSnapshot ??
            lastTurn?.request.contextSnapshot ?? previous?.contextSnapshot ?? null;
          const answer = request.input.trim();
          const matchingQuestions = draft.questions.filter(item =>
            item.options?.some(({ value, label }) => !['keep-draft', 'provide-details', 'clarify', 'revise'].includes(value) &&
              (value === answer || label === answer)));
          const resolved = new Set(lastTurn?.answeredQuestionIds);
          if (matchingQuestions.length === 1) resolved.add(matchingQuestions[0].id);
          answeredQuestionIds = [...resolved];
        }
        turn = { draftId: draft.id, turnId: input.turnId, kind: input.kind ?? 'authoring', attemptId: randomUUID(), executionToken: randomUUID(),
          ownerId, baseContentHash: draft.contentHash, clarifyingDraft,
          ...(draftInputs ? { draftInputs, draftContextSnapshot, answeredQuestionIds } : {}),
          ...(reviewRevision ? { reviewRevision, reviewAuthorization: select({
            ...previous, ...lastTurn?.reviewAuthorization, ...lastTurn?.request
          }, ['baseline', 'baselineId', 'confirmedConstraintIds']) } : {}),
          priorReview: draft.reviewReceipt ?? null, priorApproval: draft.approvalReceipt ?? null,
          request, fingerprint, status: 'running', physicalOutstanding: true, budget: newTurnBudget(policy) };
        if (turn.kind === 'authoring') draft.lastAuthoringTurnId = turn.turnId;
        draft.activeExecution = turn.executionToken; draft.status = 'running';
        draft.reviewReceipt = null; draft.approvalReceipt = null;
        state.writeTurn(turn);
        write(state, draft, draft.stateVersion);
      });
      if (replay) return replay;
      const controller = new AbortController();
      // Keep an awaited SDK turn alive even when a Host returns only a pending Promise.
      const deadlineController = new AbortController();
      const deadlineTimer = setTimeout(() => deadlineController.abort(authorError('author-deadline', 'Turn deadline exhausted')),
        Math.max(1, turn.budget.deadlineMs - Date.now()));
      const combined = signal ? AbortSignal.any([signal, controller.signal, deadlineController.signal]) :
        AbortSignal.any([controller.signal, deadlineController.signal]);
      const flight = { controller, pending: new Set(), done: false, draftId: input.draftId, turnId: input.turnId,
        attemptId: turn.attemptId, token: turn.executionToken };
      const key = JSON.stringify([input.draftId, input.turnId]); flights.set(key, flight);
      const globalKey = JSON.stringify([meta.store_id, input.draftId, input.turnId]); physicalExecutions.set(globalKey, flight);
      function releaseFlight() {
        flight.settled = true;
        if (flights.get(key) === flight) flights.delete(key);
        if (physicalExecutions.get(globalKey) === flight) physicalExecutions.delete(globalKey);
      }
      function changeTurn(operation, flags = {}) {
        return store.authorTransaction(state => {
          const current = state.readTurn(input.draftId, input.turnId);
          if (!flags.settlement && current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Execution token changed');
          const changed = operation(current, state);
          if (!flags.read && changed !== false) {
            state.writeTurn(current);
            const draft = state.readDraft(input.draftId); write(state, draft, draft.stateVersion);
          }
        });
      }
      function finishPhysical() {
        if (flight.settled || !flight.done || flight.pending.size) return;
        changeTurn(current => {
          if (current.attemptId !== flight.attemptId || !current.physicalOutstanding) return false;
          current.physicalOutstanding = false;
        }, { settlement: true });
        releaseFlight();
      }
      function track(promise) {
        flight.pending.add(promise);
        const done = () => {
          flight.pending.delete(promise);
          try { finishPhysical(); } catch (error) { flight.cleanupError = { code: error.code, message: error.message }; }
        };
        promise.then(done, done);
      }
      const ports = createTurnPorts({ changeTurn, signal: combined, requestContext: currentRequestContext,
        execution: options.execution, beforeDispatch: (kind, portInput, toolBinding) => authorize(`execute-${kind}`, initial.collectionId,
          currentRequestContext, combined, { draftId: initial.id, portInput, toolBinding }), track });
      try {
        const core = executeAuthorCore({ draft: read(input.draftId), turn, options, ports,
          signal: combined, requestContext: currentRequestContext, observeReview: options.authorization.observeReview ?? (() => null), track });
        track(core);
        const result = await during(combined, () => core);
        combined.throwIfAborted();
        ports.check();
        mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution !== turn.executionToken || current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Core result was fenced before staging');
          current.preparedResult = authorInput(result, capacity.maxDraftBytes); current.preparedResultHash = hash(current.preparedResult);
          if (!flight.pending.size) current.physicalOutstanding = false;
          draft.recoveryRef = { turnId: current.turnId, attemptId: current.attemptId, resultHash: current.preparedResultHash };
          state.writeTurn(current);
        });
        await authorize('advance-commit', initial.collectionId, currentRequestContext, combined, { draftId: initial.id });
        const response = mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (draft.activeExecution !== turn.executionToken || current.executionToken !== turn.executionToken) throw authorError('author-fenced', 'Late result cannot change current content');
          if (!flight.pending.size) current.physicalOutstanding = false;
          return applyCoreResult(draft, state, current, current.preparedResult);
        });
        if (!flight.pending.size) releaseFlight();
        return response;
      } catch (error) {
        mutate(input.draftId, undefined, (draft, state) => {
          const current = state.readTurn(draft.id, turn.turnId);
          if (current.attemptId !== flight.attemptId || current.result) return NO_CHANGE;
          const unknownWrite = Object.values(current.budget.reservations).some(item => item.sideEffectStatus === 'unknown');
          current.reconciliationRequired = unknownWrite || !!current.preparedResult || error.code === 'FKA_RECONCILIATION_REQUIRED';
          if (current.reconciliationRequired) draft.reconciliationRequired = true;
          if (draft.activeExecution === turn.executionToken) {
            const deadline = Date.now() >= turn.budget.deadlineMs && !controller.signal.aborted && !signal?.aborted;
            draft.activeExecution = null; draft.status = current.reconciliationRequired ? 'reconciliation-required' : deadline ? 'needs-revision' : combined.aborted ? 'cancelled' : (error.outcome ??
              (['FKA_BUDGET_EXHAUSTED', 'FKA_REPAIR_EXHAUSTED', 'FKA_DEADLINE'].includes(error.code) ||
                ['FKA_BUDGET_EXHAUSTED', 'FKA_DEADLINE'].includes(error.kind) ? 'needs-revision' : 'failed'));
            draft.reconciliationRequired = current.reconciliationRequired;
            draft.diagnostics = [{ code: error.code ?? 'author-execution', message: error.message }];
            draft.questions = error.questions ?? [];
            draft.reviewReceipt = null; draft.approvalReceipt = null;
          }
          current.status = current.reconciliationRequired ? 'reconciliation-required' : draft.status; current.executionToken = null;
          current.failure = { code: error.code ?? 'author-execution', message: error.message, sideEffectStatus: unknownWrite ? 'unknown' : 'none' };
          state.writeTurn(current);
        });
        flight.done = true; finishPhysical();
        await authorize('read', initial.collectionId, currentRequestContext, signal, { draftId: initial.id });
        return view(read(input.draftId));
      } finally { clearTimeout(deadlineTimer); flight.done = true; finishPhysical(); }
    },
    async reviewCandidate(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('review', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      if (!draft.candidate || input.candidateHash !== draft.candidate.hash || input.previousHash !== draft.previousHash) throw authorError('author-conflict', 'Exact candidate and previous identity are required');
      const receipt = clone(draft.reviewReceipt ?? null);
      if (receipt && Object.entries(receiptBinding(draft)).some(([key, value]) => receipt[key] !== value)) {
        receipt.qualified = false; receipt.reason = 'Current content/core/Host policy differs; run review-only or rebuild';
      }
      const rejection = activeReviewRejection(draft);
      return { diff: reviewStandardCandidate(draft.candidate, draft.previousCandidate), receipt, ...(rejection ? { rejection: clone(rejection) } : {}) };
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
        current.status = 'approved';
      });
    },
    async publish(input, currentRequestContext, signal) {
      const draft = read(input.draftId);
      await authorize('publish', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef, publicationId: input.publicationId });
      requiredId(input.publicationId, 'publicationId');
      const fingerprint = hash({ candidateHash: input.candidateHash, previousHash: input.previousHash,
        reviewRef: input.reviewRef, approvalRef: input.approvalRef });
      const replay = Object.hasOwn(draft.publications, input.publicationId) ? draft.publications[input.publicationId] : null;
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw authorError('author-conflict', 'Publication ID has different material');
        await discover(draft.id, input.publicationId, currentRequestContext, signal);
        const current = read(draft.id);
        return publicationView(current.publications[input.publicationId], store.readActive(draft.collectionId, draft.target.skillId)?.hash ?? null, current.stateVersion);
      }
      if (draft.activeExecution || !draft.reviewReceipt?.qualified || input.candidateHash !== draft.candidate?.hash ||
        input.reviewRef !== draft.reviewReceipt.reviewRef || input.previousHash !== draft.previousHash) {
        throw authorError('author-approval', 'Current exact review and user approval are required');
      }
      const observation = await options.authorization.verifyApproval?.({ ...receiptBinding(draft), reviewRef: input.reviewRef,
        approvalRef: input.approvalRef, requestContext: clone(currentRequestContext), signal });
      if (observation?.approved !== true || !observation.subjectId || !observation.approvalId) throw authorError('author-approval', 'Current exact review and user approval are required');
      await authorize('publish', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, approvalRef: input.approvalRef, publicationId: input.publicationId });
      try { mutate(draft.id, input.expectedStateVersion, (current, state) => {
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
        const collection = store.readCollectionMetadata(current.collectionId, { limit: 10001 });
        if (!collection || collection.skills.length > 10000) throw authorError('author-capacity', 'An approved bounded collection is required before saving');
        if (current.collectionBinding && current.collectionBinding !== hash(collection.collection)) throw authorError('author-conflict', 'Collection directory changed after review; rebase the target');
        if ((store.readActive(current.collectionId, current.target.skillId)?.hash ?? null) !== input.previousHash) throw authorError('author-conflict', 'Active workflow changed after review; no original publication receipt exists');
        publishing = { candidateHash: input.candidateHash, reviewRef: input.reviewRef, approvalRef: input.approvalRef };
        try { store.publishAtomically({ candidate: current.candidate, ...input }); } finally { publishing = null; }
        const saved = { publicationId: input.publicationId, fingerprint, ...binding, status: 'saved', discovery: 'pending',
          sequence: state.nextPublicationSequence(current.collectionId), operationId: hash([meta.store_id, current.id, input.publicationId]),
          collectionSnapshot: store.readCollectionMetadata(current.collectionId, { limit: 10001 }), savedAt: new Date().toISOString() };
        saved.snapshotHash = hash(saved.collectionSnapshot);
        Object.defineProperty(current.publications, input.publicationId, { value: saved, enumerable: true, writable: true, configurable: true });
        current.savedReceipt = saved; current.status = 'saved';
        // write() after this callback commits alongside the formal version and active pointer.
        return publicationView(saved, input.candidateHash, current.stateVersion + 1);
      }); } catch (error) {
        const operations = read(draft.id).publications;
        const committed = Object.hasOwn(operations, input.publicationId) ? operations[input.publicationId] : null;
        if (!committed || committed.fingerprint !== fingerprint) throw error;
      }
      await discover(draft.id, input.publicationId, currentRequestContext, signal);
      const current = read(draft.id);
      return publicationView(current.publications[input.publicationId], store.readActive(draft.collectionId, draft.target.skillId)?.hash ?? null, current.stateVersion);
    },
    async cancelTurn(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('cancel', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      const result = mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const turn = state.readTurn(draft.id, input.turnId);
        if (!turn) throw authorError('author-turn-missing', 'Turn is unknown');
        if (turn.result || turn.status === 'cancelled' && turn.executionToken === null) return NO_CHANGE;
        const token = turn.executionToken; turn.executionToken = null; turn.status = 'cancelled'; state.writeTurn(turn);
        if (current.activeExecution === token) { current.activeExecution = null; current.status = 'cancelled'; }
      });
      physicalExecutions.get(JSON.stringify([meta.store_id, draft.id, input.turnId]))?.controller.abort(authorError('author-cancelled', 'Host cancelled turn'));
      return result;
    },
    async settleTurn(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('settle', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      const observedTurn = store.authorTransaction(state => state.readTurn(draft.id, input.turnId));
      if (!observedTurn) throw authorError('author-turn-missing', 'Turn is unknown');
      assertUncommittedTurn(draft, observedTurn, input.decision);
      requiredId(input.evidenceRef, 'Trusted settlement evidenceRef');
      const observation = await options.authorization.verifySettlement?.({ ...input, namespace: options.namespace, storeId: meta.store_id,
        attemptId: observedTurn.attemptId, resultHash: observedTurn.preparedResultHash ?? null,
        reservations: clone(observedTurn.budget.reservations), requestContext: clone(currentRequestContext), signal });
      if (observation?.verified !== true || observation.attemptId !== observedTurn.attemptId || observation.evidenceRef !== input.evidenceRef ||
        observation.draftId !== draft.id || observation.turnId !== input.turnId) throw authorError('author-settlement', 'Trusted Host settlement evidence is required for the exact attempt');
      await authorize('settle', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        const turn = state.readTurn(draft.id, input.turnId);
        if (!turn || turn.attemptId !== observedTurn.attemptId) throw authorError('author-conflict', 'Settlement attempt changed');
        assertUncommittedTurn(current, turn, input.decision);
        if (current.activeExecution && current.activeExecution !== turn.executionToken) throw authorError('author-conflict', 'Another turn owns the draft execution');
        const physical = physicalExecutions.get(JSON.stringify([meta.store_id, draft.id, input.turnId]));
        if (input.decision !== 'abandon' && (physical?.pending.size || observation.physicalDone !== true)) throw authorError('author-busy', 'Actual execution is still outstanding or physical proof is missing');
        if (current.activeExecution === turn.executionToken) current.activeExecution = null;
        turn.executionToken = null;
        if (!physical?.pending.size && observation.physicalDone === true) turn.physicalOutstanding = false;
        turn.settlement = { decision: input.decision, observation: authorInput(observation, capacity.maxDraftBytes) };
        if (input.decision === 'abandon') {
          current.status = 'abandoned'; current.reviewReceipt = null; current.approvalReceipt = null;
          turn.status = 'abandoned'; turn.retryRef = null;
          turn.unresolvedExternalRefs = Object.entries(turn.budget.reservations).filter(([, receipt]) => receipt.sideEffectStatus === 'unknown').map(([id]) => id);
        }
        else if (input.decision === 'confirm-no-effect' && observation.noEffect === true) {
          const budget = turn.budget;
          const abandoned = current.status === 'abandoned';
          const remaining = Date.now() < budget.deadlineMs && budget.used.requests < budget.limits.maxRequests &&
            budget.used.toolCalls < budget.limits.maxToolCalls && budget.used.ioCalls < budget.limits.maxIoCalls && budget.used.bytes < budget.limits.maxBytes;
          turn.retryRef = remaining && !abandoned ? turn.retryRef ?? randomUUID() : null; turn.retryStateVersion = current.stateVersion + 1;
          turn.status = abandoned ? 'abandoned' : 'failed'; turn.reconciliationRequired = false; current.reconciliationRequired = false;
          for (const receipt of Object.values(budget.reservations)) if (receipt.sideEffectStatus === 'unknown') { receipt.sideEffectStatus = 'none'; receipt.settlementRef = input.evidenceRef; }
          for (const operation of Object.values(budget.toolOperations ?? {})) if (operation.status === 'unknown' || operation.status === 'running') operation.status = 'no-effect';
        } else if (input.decision === 'confirm-result') {
          if (!turn.preparedResult || observation.resultHash !== turn.preparedResultHash || hash(turn.preparedResult) !== turn.preparedResultHash) {
            throw authorError('author-settlement', 'Only a durable completed core result with an exact trusted resultHash can be committed');
          }
          const result = applyCoreResult(current, state, turn, turn.preparedResult);
          return { retryRef: null, stateVersion: current.stateVersion + 1, budget: clone(turn.budget), result };
        } else throw authorError('author-settlement', 'Settlement decision/evidence mismatch');
        state.writeTurn(turn);
        return { retryRef: turn.retryRef ?? null, stateVersion: current.stateVersion + 1, budget: clone(turn.budget) };
      });
    },
    async discard(input, currentRequestContext, signal) {
      const draft = read(input.draftId); await authorize('discard', draft.collectionId, currentRequestContext, signal, { draftId: draft.id });
      if (input.generationId) {
        if (draft.stateVersion !== input.expectedStateVersion) throw authorError('author-conflict', 'Draft stateVersion changed');
        const key = JSON.stringify([draft.id, 'cleanup', input.generationId]);
        if (publications.has(key)) return publications.get(key).promise;
        if (publications.size >= capacity.maxPhysicalExecutions) throw authorError('author-capacity', 'Discovery operation capacity reached');
        const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const promise = (async () => {
          await cleanupPublicationGeneration({ store, options, draft, generationId: input.generationId, context: currentRequestContext, signal: combined, authorize });
          return mutate(draft.id, undefined, current => {
            const op = Object.values(current.publications).find(value => value.generation?.generationId === input.generationId);
            op.generationRemoved = true; op.discovery = 'removed';
            if (current.savedReceipt?.publicationId === op.publicationId) current.savedReceipt = op;
          });
        })();
        publications.set(key, { controller, promise, draftId: draft.id, publicationId: 'cleanup:' + input.generationId });
        try { return await promise; } finally { publications.delete(key); }
      }
      if (input.purgeBody) {
        if (!options.retention || input.retentionPolicyRef !== options.retention.policyRef || !Number.isSafeInteger(options.retention.idempotencyRetentionMs) ||
          options.retention.idempotencyRetentionMs < 1) throw authorError('author-executor', 'Body cleanup requires an explicit Host retention policy');
        await authorize('cleanup', draft.collectionId, currentRequestContext, signal, { draftId: draft.id, retentionPolicyRef: input.retentionPolicyRef });
      }
      return mutate(draft.id, input.expectedStateVersion, (current, state) => {
        if (current.bodyPurged) return NO_CHANGE;
        const turns = state.turns(current.id, capacity.maxTurnsPerDraft + 1);
        if (turns.some(turn => turn.physicalOutstanding || turn.reconciliationRequired && !turn.settlement)) throw authorError('author-busy', 'Cancel and settle outstanding execution first');
        if (input.candidateHash !== (current.candidate?.hash ?? null)) throw authorError('author-conflict', 'Candidate changed');
        current.status = 'discarded'; current.reviewReceipt = null; current.approvalReceipt = null;
        if (input.purgeBody) {
          if (Object.keys(current.publications).length || turns.some(turn => turn.preparedResult && turn.status !== 'abandoned' ||
            Object.values(turn.budget.reservations).some(receipt => receipt.sideEffectStatus === 'unknown'))) {
            throw authorError('author-reconcile', 'Referenced publications, completed results or unknown effects must be retained');
          }
          const tombstone = { ...select(current, ['id', 'namespace', 'collectionId', 'stateVersion', 'contentRevision', 'contentHash', 'startRequestId', 'startFingerprint', 'ownerScope']),
            status: 'expired', bodyPurged: true, goal: '[expired]', choices: {}, questions: [],
            target: select(current.target, ['skillId', 'name', 'version']), publications: {},
            retention: { policyRef: input.retentionPolicyRef, purgedAt: Date.now(), retainUntil: Date.now() + options.retention.idempotencyRetentionMs } };
          for (const key of Object.keys(current)) delete current[key]; Object.assign(current, tombstone);
          for (const turn of turns) {
            delete turn.request; delete turn.result; delete turn.preparedResult; delete turn.priorReview; delete turn.priorApproval;
            delete turn.draftInputs; delete turn.draftContextSnapshot; delete turn.answeredQuestionIds;
            delete turn.reviewRevision; delete turn.reviewAuthorization;
            turn.status = 'expired'; turn.retryRef = null; turn.executionToken = null; state.writeTurn(turn);
          }
        }
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
      if (!['drain', 'cancel'].includes(mode)) throw new TypeError('Choose drain or cancel');
      closing = true;
      if (mode === 'cancel') for (const flight of flights.values()) {
        mutate(flight.draftId, undefined, (draft, state) => {
          const turn = state.readTurn(flight.draftId, flight.turnId);
          if (turn.attemptId !== flight.attemptId || turn.result || turn.executionToken === null) return NO_CHANGE;
          const token = turn.executionToken; turn.executionToken = null; turn.status = 'cancelled'; state.writeTurn(turn);
          if (draft.activeExecution === token) { draft.activeExecution = null; draft.status = 'cancelled'; }
        });
        flight.controller.abort(authorError('author-cancelled', 'Author Host closing'));
      }
      if (mode === 'cancel') for (const job of publications.values()) job.controller.abort(authorError('author-cancelled', 'Author discovery closing'));
      const deadline = Date.now() + positive(timeoutMs, 5000, 'close timeout');
      while ((flights.size || publications.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (flights.size || publications.size) return { closed: false, outstanding: flights.size + publications.size,
        executions: [...flights.values()].map(({ draftId, turnId, attemptId, cleanupError }) => ({ draftId, turnId, attemptId, cleanupError })),
        publications: [...publications.values()].map(({ draftId, publicationId }) => ({ draftId, publicationId })) };
      store.close(); closed = true;
      return { closed: true, outstanding: 0 };
    }
  };
  publicHost = Object.freeze(Object.fromEntries(Object.entries(host).map(([name, method]) => [name,
    ['createMcpOptions', 'close'].includes(name) ? method : async (input, context, signal) =>
      method(authorInput(input, policy.maxBytes), authorInput(context, policy.maxBytes), signal)])));
  return publicHost;
}
