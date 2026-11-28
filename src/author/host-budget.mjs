import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { during } from '../runtime/tasks.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';

const codes = { 'author-executor': 'FKA_HOST_BINDING_MISSING', 'author-input': 'FKA_INVALID_INPUT', 'author-size': 'FKA_SIZE_LIMIT',
  'author-conflict': 'FKA_CONFLICT', 'author-unauthorized': 'FKA_SCOPE_DENIED', 'author-budget': 'FKA_BUDGET_EXHAUSTED',
  'author-deadline': 'FKA_DEADLINE', 'author-repair-limit': 'FKA_REPAIR_EXHAUSTED', 'author-fenced': 'FKA_STALE_EXECUTION',
  'author-capacity': 'FKA_CAPACITY', 'author-closed': 'FKA_CLOSED', 'author-target': 'FKA_TARGET_INVALID',
  'author-approval': 'FKA_APPROVAL_REQUIRED', 'author-review': 'FKA_REVIEW_REQUIRED', 'author-resource': 'FKA_RESOURCE_GAP',
  'author-settlement': 'FKA_SETTLEMENT_INVALID', 'author-busy': 'FKA_INFLIGHT', 'author-reconcile': 'FKA_RECONCILIATION_REQUIRED',
  'author-expired': 'FKA_IDEMPOTENCY_EXPIRED', 'author-draft-missing': 'FKA_DRAFT_NOT_FOUND', 'author-terminal': 'FKA_TERMINAL',
  'author-turn-missing': 'FKA_TURN_NOT_FOUND', 'author-cancelled': 'FKA_CANCELLED' };
export const authorError = (reasonCode, message) => Object.assign(new Error(message), {
  code: codes[reasonCode] ?? reasonCode, reasonCode, retryable: false, sideEffectStatus: 'none' });
export const isIntentModelOutputError = error =>
  ['MODEL_OUTPUT_INVALID', 'MODEL_OUTPUT_INCOMPLETE'].includes(error?.code) &&
  (error.sideEffectStatus === undefined || error.sideEffectStatus === 'none');
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value) ?? 'null');
export const positive = (value, fallback, name) => {
  if (value === undefined) value = fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Finite positive ${name} is required`);
  return value;
};

export function budgetPolicy(options = {}, inherited = {}) {
  const defaults = { durationMs: 300000, maxRequests: 24, maxToolCalls: 32,
    maxIoCalls: 96, maxBytes: 16 * 1024 * 1024, maxResponseBytes: 262144, ...inherited };
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => !Object.hasOwn(defaults, key))) {
    throw new TypeError('Unknown Author budget field');
  }
  const policy = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
    [key, positive(options[key], fallback, key)]));
  if (policy.durationMs > 2147483647) throw new TypeError('Turn duration exceeds the supported finite timer range');
  return policy;
}

export function newTurnBudget(policy) {
  return { deadlineMs: Date.now() + policy.durationMs, limits: policy,
    used: { requests: 0, toolCalls: 0, ioCalls: 0, bytes: 0 }, repairs: [], reservations: {}, toolOperations: {} };
}

/** Reserve before actual dispatch, not around a black-box completed turn. Unknown usage stays charged. */
export function createTurnPorts({ changeTurn, signal, requestContext, execution, track, beforeDispatch }) {
  const modelObservation = new AsyncLocalStorage();
  let dispatchFailure;
  const guarded = (promise, kind) => promise.catch(error => { dispatchFailure ??= { error, kind }; throw error; });
  function check(turn) {
    signal.throwIfAborted();
    if (Date.now() >= turn.budget.deadlineMs) throw authorError('author-deadline', 'Turn deadline exhausted');
    if (turn.executionToken === null || turn.status !== 'running') throw authorError('author-fenced', 'Turn execution was fenced');
  }
  async function call(kind, input, operation, supplied = {}) {
    const operationSignal = supplied.signal && supplied.signal !== signal
      ? AbortSignal.any([signal, supplied.signal]) : signal;
    operationSignal.throwIfAborted();
    await beforeDispatch(kind, input, supplied);
    const id = randomUUID(), inputBytes = jsonBytes(input);
    const field = { request: 'requests', tool: 'toolCalls', io: 'ioCalls' }[kind];
    const operationKey = kind === 'tool' ? supplied.operationKey : undefined;
    const ledgerKey = operationKey ? artifactDigest(JSON.stringify([supplied.toolName ?? null, operationKey])) : null;
    const ownerScopeHash = artifactDigest(JSON.stringify([requestContext.principalId, requestContext.workspaceId]));
    const sideEffect = kind === 'tool' ? supplied.sideEffect : 'read';
    if (kind === 'tool' && (!['read', 'write'].includes(sideEffect) || sideEffect === 'write' &&
      (typeof operationKey !== 'string' || !operationKey || typeof supplied.toolName !== 'string' || !supplied.toolName))) throw authorError('author-executor', 'Tool binding requires trusted sideEffect, toolName and a stable write operationKey');
    const fingerprint = artifactDigest(JSON.stringify({ input, toolName: supplied.toolName ?? null }));
    let maximum, replay;
    function releaseReceiptReserve(turn, receipt) {
      if (receipt.receiptReserveBytes === undefined) return;
      turn.budget.receiptReserveBytes -= receipt.receiptReserveBytes;
      delete receipt.receiptReserveBytes;
    }
    changeTurn((turn, state) => {
      check(turn);
      const { limits, used } = turn.budget;
      maximum = limits.maxResponseBytes;
      turn.budget.toolOperations ??= {};
      const entry = ledgerKey && (turn.budget.toolOperations[ledgerKey] ?? state.findToolOperation(ledgerKey));
      if (entry) {
        if (entry.ownerScopeHash !== ownerScopeHash) throw authorError('author-reconcile', 'Tool operation belongs to another authenticated scope; Host reconciliation is required');
        if (entry.fingerprint !== fingerprint) throw authorError('author-conflict', 'Tool operationKey has different input');
        if (entry.status === 'completed') { replay = { value: entry.result }; turn.budget.toolOperations[ledgerKey] = entry; return; }
        if (entry.status !== 'no-effect' && entry.status !== 'not-sent') throw authorError('author-reconcile', 'An earlier Tool effect must be reconciled before retry');
      }
      const limit = { request: 'maxRequests', tool: 'maxToolCalls', io: 'maxIoCalls' }[kind];
      if (used[field] >= limits[limit] || used.bytes + inputBytes + maximum > limits.maxBytes) {
        throw authorError('author-budget', `Turn ${limit}/byte budget exhausted`);
      }
      used[field]++; used.bytes += inputBytes + maximum;
      turn.budget.reservations[id] = { kind, inputBytes, outputReserved: maximum, status: 'reserved',
        sideEffect, sideEffectStatus: sideEffect === 'write' ? 'unknown' : 'none', operationKey: operationKey ?? null };
      if (turn.settlementReserveBytes !== undefined) {
        // Only Tool writes retain the response body in their durable operation receipt.
        const reserve = sideEffect === 'write' ? maximum + 1024 : 768;
        turn.budget.receiptReserveBytes = (turn.budget.receiptReserveBytes ?? 0) + reserve;
        turn.budget.reservations[id].receiptReserveBytes = reserve;
      }
      if (ledgerKey) turn.budget.toolOperations[ledgerKey] = { fingerprint, ownerScopeHash, operationKey, toolName: supplied.toolName,
        dispatchId: id, status: 'running', sideEffect };
    });
    if (replay) return structuredClone(replay.value);
    let dispatched = false;
    let processingOutput = false;
    // Track the real operation promise, even if the caller stops awaiting after logical cancellation.
    const pending = Promise.resolve().then(async () => {
      operationSignal.throwIfAborted();
      await beforeDispatch(kind, input, supplied);
      operationSignal.throwIfAborted(); changeTurn(check, { read: true });
      dispatched = true;
      return operation(input, { ...supplied, signal: operationSignal, requestContext });
    }).then(async value => {
      processingOutput = true;
      if (kind === 'tool' && (value instanceof Response || JSON.stringify(value) === undefined)) throw authorError('author-executor', 'Tool result must be JSON data');
      if (value instanceof Response) {
        const reader = value.body?.getReader();
        const chunks = []; let size = 0;
        try {
          if (reader) for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > maximum) throw authorError('author-size', 'Port response exceeds reserved bytes');
            chunks.push(part.value);
          }
        } finally { await reader?.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        let usage;
        try {
          const tokens = JSON.parse(bytes.toString('utf8')).usage;
          if (tokens && ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(tokens[key]) && tokens[key] >= 0)) {
            usage = { inputTokens: tokens.input_tokens, outputTokens: tokens.output_tokens };
          }
        } catch { /* Non-JSON or unobserved usage remains explicitly unknown and charged. */ }
        return { value: new Response([204, 205, 304].includes(value.status) ? null : bytes,
          { status: value.status, statusText: value.statusText, headers: value.headers }), size, hash: artifactDigest(bytes), usage };
      }
      const size = value instanceof Uint8Array ? value.byteLength : value?.bytes instanceof Uint8Array ?
        value.bytes.byteLength + jsonBytes({ ...value, bytes: null }) - 4 : jsonBytes(value);
      if (size > maximum) throw authorError('author-size', 'Port response exceeds reserved bytes');
      return { value, size };
    });
    const settled = pending.then(result => {
      changeTurn(turn => {
        const receipt = turn.budget.reservations[id];
        receipt.status = receipt.status === 'unknown' ? 'late-completed' : 'completed'; receipt.outputBytes = result.size;
        receipt.sideEffectStatus = sideEffect === 'write' ? 'known' : 'none';
        if (sideEffect === 'write' && turn.failure?.sideEffectStatus === 'unknown' &&
            !Object.values(turn.budget.reservations).some(item => item.sideEffectStatus === 'unknown')) {
          turn.failure.sideEffectStatus = 'known';
        }
        receipt.resultHash = result.hash ?? artifactDigest(JSON.stringify(result.value) ?? 'null');
        if (kind === 'request') {
          receipt.usageStatus = result.usage ? 'observed' : 'unknown';
          if (result.usage) {
            receipt.usage = result.usage;
            turn.budget.observedTokens ??= { inputTokens: 0, outputTokens: 0 };
            for (const key of ['inputTokens', 'outputTokens']) turn.budget.observedTokens[key] += result.usage[key];
          }
        }
        turn.budget.used.bytes -= maximum - result.size;
        if (ledgerKey) Object.assign(turn.budget.toolOperations[ledgerKey], { status: 'completed', result: structuredClone(result.value) });
        releaseReceiptReserve(turn, receipt);
      }, { settlement: true });
      return result;
    }, error => {
      changeTurn(turn => {
        const receipt = turn.budget.reservations[id];
        receipt.status = dispatched ? 'unknown' : 'not-sent';
        receipt.sideEffectStatus = 'none';
        if (dispatched && sideEffect === 'write') {
          // An output error cannot confirm what happened in the Host.
          // A no-effect decision after dispatch requires explicit settlement.
          receipt.sideEffectStatus = !processingOutput && error?.sideEffectStatus === 'known' ? 'known' : 'unknown';
        }
        if (!dispatched) { turn.budget.used[field]--; turn.budget.used.bytes -= inputBytes + maximum; }
        if (!dispatched || sideEffect !== 'write') releaseReceiptReserve(turn, receipt);
        if (ledgerKey) turn.budget.toolOperations[ledgerKey].status = receipt.status;
      }, { settlement: true });
      throw error;
    });
    track(settled);
    try {
      const result = await during(operationSignal, () => settled);
      operationSignal.throwIfAborted();
      return result.value;
    } catch (error) {
      let observedEffect;
      changeTurn(turn => {
        const receipt = turn.budget.reservations[id];
        if (receipt.status === 'reserved') receipt.status = 'unknown';
        observedEffect = receipt.sideEffectStatus;
      }, { settlement: true });
      // Port failures must expose the same conservative effect status as the durable reservation.
      if (sideEffect === 'write' && (error?.sideEffectStatus !== observedEffect ||
          observedEffect !== 'none' && error?.retryable === true)) {
        throw Object.assign(new Error(error?.message ?? String(error), { cause: error }), {
          name: error?.name ?? 'Error', code: error?.code, reasonCode: error?.reasonCode,
          retryable: observedEffect === 'none' && error?.retryable === true, sideEffectStatus: observedEffect });
      }
      throw error;
    }
  }
  const port = kind => async (input, context) => {
    if (typeof execution[kind] !== 'function') throw authorError('author-executor', `Host ${kind} port is unavailable`);
    const observation = kind === 'request' && modelObservation.getStore();
    if (observation) observation.started = true;
    try {
      const value = await guarded(call(kind, input, execution[kind], context), kind);
      if (observation) observation.completed = true;
      return value;
    } catch (error) {
      if (observation) observation.failure = error;
      throw error;
    }
  };
  return Object.freeze({ request: port('request'), tool: port('tool'), io: port('io'),
    read: (input, operation) => guarded(call('io', input, operation), 'io'),
    retryIntentOutput(error) {
      if (error && !isIntentModelOutputError(error)) throw error;
      if (dispatchFailure && (!error || dispatchFailure.error !== error || dispatchFailure.kind !== 'request')) throw dispatchFailure.error;
      changeTurn(turn => {
        check(turn);
        if (Object.values(turn.budget.reservations).some(item => item.sideEffect === 'write' && item.status !== 'not-sent')) {
          throw authorError('author-reconcile', 'Intent output cannot be retried after a Tool write');
        }
      }, { read: true });
      dispatchFailure = undefined;
    },
    repair(repairId) {
      changeTurn(turn => {
        check(turn);
        if (turn.budget.repairs.includes(repairId)) return;
        if (turn.budget.repairs.length >= 2) throw authorError('author-repair-limit', 'Shared two-repair budget exhausted');
        turn.budget.repairs.push(repairId);
      });
    },
    async observeModel(operation, stage = 'model') {
      const observation = { started: false, completed: false };
      const value = await modelObservation.run(observation, operation);
      if (observation.completed) return value;
      const failed = value?.status === 'failed' || value?.status === 'cancelled';
      const aborted = ['AbortError', 'TimeoutError'].includes(observation.failure?.name);
      if (Object.hasOwn(observation, 'failure') && !(failed && aborted)) throw observation.failure;
      if (failed) {
        const reported = value.status === 'cancelled' ? 'cancelled' : value.failure?.code;
        const reason = typeof reported === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(reported) ? reported : 'unavailable';
        const phase = observation.started ? 'request not completed' : 'before guarded request';
        throw authorError('FKA_MODEL_REQUEST_NOT_COMPLETED', `Model stage ${stage}: ${phase} (adapter: ${reason}).`);
      }
      throw authorError('author-unobserved', 'Execution bypassed the guarded model request port');
    },
    check(coreFailure) {
      if (dispatchFailure) throw dispatchFailure.error;
      changeTurn(turn => {
        check(turn);
        if (coreFailure && Object.values(turn.budget.reservations).some(item => item.sideEffectStatus !== 'none')) {
          throw coreFailure;
        }
      }, { read: true });
    }
  });
}
