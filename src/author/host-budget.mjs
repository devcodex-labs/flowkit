import { randomUUID } from 'node:crypto';

export const authorError = (code, message) => Object.assign(new Error(message), { code });
export const jsonBytes = value => Buffer.byteLength(JSON.stringify(value) ?? 'null');
export const positive = (value, fallback, name) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Finite positive ${name} is required`);
  return value;
};

export function budgetPolicy(options = {}) {
  return Object.fromEntries(Object.entries({ durationMs: 300000, maxRequests: 24, maxToolCalls: 32,
    maxIoCalls: 96, maxBytes: 16 * 1024 * 1024, maxResponseBytes: 262144 }).map(([key, fallback]) =>
    [key, positive(options[key], fallback, key)]));
}

export function newTurnBudget(policy) {
  return { deadlineMs: Date.now() + policy.durationMs, limits: policy,
    used: { requests: 0, toolCalls: 0, ioCalls: 0, bytes: 0 }, repairs: [], reservations: {} };
}

/** Reserve before actual dispatch, not around a black-box completed turn. Unknown usage stays charged. */
export function createTurnPorts({ changeTurn, signal, requestContext, execution, track }) {
  function check(turn) {
    signal.throwIfAborted();
    if (Date.now() >= turn.budget.deadlineMs) throw authorError('author-budget', 'Turn deadline exhausted');
    if (turn.executionToken === null || turn.status !== 'running') throw authorError('author-fenced', 'Turn execution was fenced');
  }
  async function call(kind, input, operation, supplied = {}) {
    const id = randomUUID(), inputBytes = jsonBytes(input);
    let maximum;
    changeTurn(turn => {
      check(turn);
      const { limits, used } = turn.budget;
      maximum = limits.maxResponseBytes;
      const field = { request: 'requests', tool: 'toolCalls', io: 'ioCalls' }[kind];
      const limit = { request: 'maxRequests', tool: 'maxToolCalls', io: 'maxIoCalls' }[kind];
      if (used[field] >= limits[limit] || used.bytes + inputBytes + maximum > limits.maxBytes) {
        throw authorError('author-budget', `Turn ${limit}/byte budget exhausted`);
      }
      used[field]++; used.bytes += inputBytes + maximum;
      turn.budget.reservations[id] = { kind, inputBytes, outputReserved: maximum, status: 'reserved' };
    });
    // Track the real operation promise, even if the caller stops awaiting after logical cancellation.
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(input, { ...supplied, signal, requestContext });
    }).then(async value => {
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
        return { value: new Response([204, 205, 304].includes(value.status) ? null : Buffer.concat(chunks),
          { status: value.status, statusText: value.statusText, headers: value.headers }), size };
      }
      const size = value instanceof Uint8Array ? value.byteLength : jsonBytes(value);
      if (size > maximum) throw authorError('author-size', 'Port response exceeds reserved bytes');
      return { value, size };
    });
    track(pending);
    try {
      const result = await pending;
      changeTurn(turn => {
        const receipt = turn.budget.reservations[id];
        receipt.status = 'completed'; receipt.outputBytes = result.size;
        turn.budget.used.bytes -= maximum - result.size;
      }, { settlement: true });
      signal.throwIfAborted();
      return result.value;
    } catch (error) {
      changeTurn(turn => { turn.budget.reservations[id].status = 'unknown'; }, { settlement: true });
      throw error;
    }
  }
  const port = kind => (input, context) => {
    if (typeof execution[kind] !== 'function') throw authorError('author-executor', `Host ${kind} port is unavailable`);
    return call(kind, input, execution[kind], context);
  };
  return Object.freeze({ request: port('request'), tool: port('tool'), io: port('io'),
    read: (input, operation) => call('io', input, operation),
    repair(repairId) {
      changeTurn(turn => {
        check(turn);
        if (turn.budget.repairs.includes(repairId)) return;
        if (turn.budget.repairs.length >= 2) throw authorError('author-repair-limit', 'Shared two-repair budget exhausted');
        turn.budget.repairs.push(repairId);
      });
    },
    observed() { let count; changeTurn(turn => { count = turn.budget.used.requests; }, { read: true }); return count; },
    check() { changeTurn(check, { read: true }); }
  });
}
