import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, context, intent, proposal, source } from './author-host-fixture.mjs';
import { createApiAgentAdapter, createWorkflowAuthorHost } from '../../dist/host.mjs';
import { createTurnPorts, newTurnBudget, budgetPolicy, jsonBytes } from '../../src/author/host-budget.mjs';
import { authorInput } from '../../src/author/host-target.mjs';

async function setup(t, overrides) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-author-ports-')), f = await fixture(path.join(dir, 'author.sqlite'), overrides);
  t.after(async () => { await f.host.close({ mode: 'cancel' }); await rm(dir, { recursive: true, force: true }); }); return f;
}
async function turn(f, id = 'one') {
  const draft = await f.start({ requestId: id });
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect' }, context);
}

test('I4 S45/S93/S94/S97: actual API adapter 429 retries charge each real guarded dispatch once inside the durable shared budget', async t => {
  const f = await setup(t, { budgetPolicy: { maxRequests: 5 } }); let requests = 0; const observed = new Set();
  f.options.execution.request = async body => {
    if (body.stage === 'intent') return structuredClone(intent);
    requests++;
    if (requests === 1) return new Response('{}', { status: 429 });
    const task = JSON.parse(body.input[0].content.split('\n').slice(1).join('\n')).task;
    const result = task.node.id === 'proposal' ? { rawText: JSON.stringify(proposal) } :
      task.node.id === 'semantic-review' ? { passed: true, findings: [] } : { rawText: source };
    return Response.json({ id: 'controlled-' + requests, status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  };
  f.options.execution.createSession = async ports => {
    const adapter = createApiAgentAdapter({ scope: 'test', model: 'controlled-protocol-fixture', request: ports.request, retryDelaysMs: [0] });
    return { intentRuntime: { parse: input => ports.request({ stage: 'intent', input }) }, runtime: { validateResult: () => [],
      async runAgentTask(prepared, hostContext) { const result = await adapter.runAgentTask(prepared, hostContext);
        if (result.status === 'succeeded') observed.add(prepared.task.execution.requestId); return result; } } };
  };
  f.options.authorization.observeReview = async ({ task }) => observed.has(task.execution.requestId) ?
    { passed: true, executionId: task.execution.requestId, subjectId: 'controlled-review' } : null;
  const ready = await turn(f); assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics)); assert.equal(requests, 4);
  const record = f.host.createMcpOptions().store.authorTransaction(state => state.readTurn(ready.id, 'turn'));
  assert.equal(record.budget.used.requests, 5); assert.equal(Object.values(record.budget.reservations).filter(item => item.kind === 'request').length, 5);
  assert.deepEqual(record.budget.observedTokens, { inputTokens: 30, outputTokens: 15 });
  assert.equal(Object.values(record.budget.reservations).filter(item => item.usageStatus === 'unknown').length, 2);
});

test('I4 S96/S103: unknown writes survive abandon and block the same business operation in a new draft', async t => {
  const f = await setup(t); let writes = 0;
  f.options.execution.tool = async () => { writes++; throw new Error('controlled connection lost after dispatch'); };
  f.options.execution.createSession = async ports => ({ intentRuntime: { parse: async () => {
    await ports.tool({ value: 1 }, { sideEffect: 'write', toolName: 'update-record', operationKey: 'business-one' });
    return ports.request({ stage: 'intent' });
  } }, runtime: { validateResult: () => [], runAgentTask: () => assert.fail('no Agent dispatch expected') } });
  const first = await turn(f); assert.equal(first.status, 'reconciliation-required'); assert.equal(writes, 1);
  await f.host.settleTurn({ draftId: first.id, expectedStateVersion: first.stateVersion, turnId: 'turn', decision: 'abandon', evidenceRef: 'controlled-abandon-with-unknown-write' }, context);
  const second = await turn(f, 'two'); assert.notEqual(second.status, 'candidate-ready'); assert.equal(writes, 1);
  assert.match(JSON.stringify(second.diagnostics), /reconciled/);
  const abandoned = await f.host.readDraft({ draftId: first.id }, context);
  const reconciled = await f.host.settleTurn({ draftId: first.id, expectedStateVersion: abandoned.stateVersion,
    turnId: 'turn', decision: 'confirm-no-effect', evidenceRef: 'controlled-proof-no-external-write' }, context);
  assert.equal(reconciled.retryRef, null);
  assert.equal((await f.host.readDraft({ draftId: first.id }, context)).status, 'abandoned');
  assert.equal(writes, 1);
});

test('I4 S93/S99: exact reservation boundary dispatches once; one byte less and an already cancelled signal dispatch nothing', async () => {
  const input = { q: 'bounded' }, maximum = 128, total = jsonBytes(input) + maximum;
  for (const [maxBytes, cancelled, expected] of [[total, false, 1], [total - 1, false, 0], [total, true, 0]]) {
    const turn = { status: 'running', executionToken: 'token', budget: newTurnBudget(budgetPolicy({ maxBytes, maxResponseBytes: maximum, maxRequests: 1 })) };
    const controller = new AbortController(); if (cancelled) controller.abort(); let calls = 0;
    const ports = createTurnPorts({ changeTurn: operation => operation(turn, { findToolOperation: () => null }), signal: controller.signal,
      requestContext: context, track: () => {}, beforeDispatch: async () => {}, execution: { request: async () => { calls++; return {}; } } });
    if (expected) { await ports.request(input); await assert.rejects(ports.request(input), /budget/); }
    else await assert.rejects(ports.request(input));
    assert.equal(calls, expected); assert.ok(turn.budget.used.requests <= 1);
  }
});

test('a constrained SQLite receipt budget admits a write only when its outcome can survive reopening', async t => {
  for (const [maxResponseBytes, admitted] of [[16_384, false], [4_096, true]]) {
    const f = await setup(t, { capacity: { maxReceiptBytes: 12_288 }, budgetPolicy: { maxResponseBytes } });
    let writes = 0;
    f.options.execution.tool = async () => { writes++; return { receipt: 'record-written' }; };
    f.options.execution.createSession = async ports => ({ intentRuntime: { parse: async () => {
      await ports.tool({ value: 1 }, { sideEffect: 'write', toolName: 'update-record', operationKey: 'bounded-write' });
      throw new Error('controlled failure after the completed tool');
    } }, runtime: { validateResult: () => [], runAgentTask: () => assert.fail('no Agent dispatch expected') } });
    const result = await turn(f);
    assert.equal(writes, Number(admitted), JSON.stringify(result.diagnostics));
    assert.equal(result.status === 'reconciliation-required', admitted,
      JSON.stringify({ status: result.status, diagnostics: result.diagnostics }));
    await f.host.close({ mode: 'drain' });
    const reopened = await createWorkflowAuthorHost(f.options);
    try {
      const persisted = reopened.createMcpOptions().store.authorTransaction(state => state.readTurn(result.id, 'turn'));
      const [entry] = Object.values(persisted.budget.toolOperations ?? {});
      if (admitted) {
        assert.equal(entry.status, 'completed');
        assert.deepEqual(entry.result, { receipt: 'record-written' });
        assert.equal(persisted.failure.sideEffectStatus, 'known');
      } else {
        assert.equal(entry, undefined);
      }
    } finally {
      await reopened.close({ mode: 'drain' });
    }
  }
});

test('I4 S53: symbols, hidden accessors, sparse arrays and cycles are rejected without executing getters; prototype keys remain data', () => {
  const getter = Object.defineProperty({}, 'hidden', { get: () => assert.fail('getter executed') });
  const cycle = {}; cycle.self = cycle;
  const disguisedSparse = new Array(1); disguisedSparse.extra = 'not-index-zero';
  for (const value of [getter, { [Symbol('hidden')]: 1 }, new Array(1), disguisedSparse, cycle]) assert.throws(() => authorInput(value, 1000), /JSON/);
  const data = authorInput(JSON.parse('{"__proto__":{"value":1},"constructor":2}'), 1000);
  assert.equal(Object.getPrototypeOf(data), Object.prototype); assert.equal(Object.hasOwn(data, '__proto__'), true);
  assert.equal(data.__proto__.value, 1); assert.equal({}.value, undefined);
});
