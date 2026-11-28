import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiAgentAdapter } from '../../src/host.mjs';

const prepared = { protocolVersion: 2, task: { protocolVersion: 2, workflow: { artifactHash: 'fixture' }, run: { runId: 'run-a' },
  node: { id: 'write' }, execution: { requestId: 'request-a' }, task: { description: 'Inspect the result' }, outputSchema: { type: 'object' } },
descriptionResources: [], skills: [] };
const call = (id = 'call-a', value = 1) => ({ type: 'function_call', call_id: id, name: 'inspect', arguments: JSON.stringify({ value }) });
const answer = (output, id = 'response-a') => ({ id, status: 'completed', output,
  usage: { input_tokens: 10, output_tokens: 5 } });
const terminal = () => answer([{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }]);

test('API distinguishes HTTP failure from invalid model JSON and rejects misspelled limits', async () => {
  const options = { scope: 'classified', model: 'controlled-fixture', retryDelaysMs: [] };
  assert.throws(() => createApiAgentAdapter({ ...options, request: async () => Response.json(terminal()),
    limits: { maxRequets: 1 } }), /Unknown API budget field/);
  for (const response of [new Response('provider failure', { status: 400 }), new Response(null, { status: 400 }),
    Response.json({ error: 'test' }, { status: 400 })]) {
    const result = await createApiAgentAdapter({ ...options, request: async () => response }).runAgentTask(prepared);
    assert.equal(result.failure.code, 'provider-error');
    assert.equal(result.usage.providerRequests, 1);
  }
  const result = await createApiAgentAdapter({ ...options, request: async () =>
    Response.json(answer([{ type: 'message', content: [{ type: 'output_text', text: '{invalid' }] }]))
  }).runAgentTask(prepared);
  assert.equal(result.failure.code, 'invalid-result');
  assert.equal(result.failure.sideEffectStatus, 'none');
});

test('reference API sends required Professional Skill contents and rejects identity-only preparation', async () => {
  const candidate = structuredClone(prepared);
  candidate.task.task = { ...candidate.task.task, requiredSkills: [{ id: 'review', version: '1.0.0' }] };
  candidate.skills = [{ logicalId: 'review', resolvedVersion: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) }];
  let sent;
  const adapter = createApiAgentAdapter({ scope: 'skill-wire', model: 'controlled-fixture', request: async body => {
    sent = JSON.parse(body.input[0].content.split('\n').at(-1));
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] });
  } });
  const invalid = await adapter.runAgentTask(candidate);
  assert.equal(invalid.failure.code, 'required-skill-missing');
  assert.equal(sent, undefined);
  candidate.skills[0].files = { 'SKILL.md': 'Use this authorized fixture reference.' };
  assert.equal((await adapter.runAgentTask(candidate)).status, 'succeeded');
  assert.deepEqual(sent.skills, candidate.skills);
});

test('ordinary API uses a real HTTP tool loop with authorized resource reads and bounded usage', async t => {
  let requests = 0;
  let toolReads = 0;
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const input = JSON.parse(Buffer.concat(parts));
    response.setHeader('Content-Type', 'application/json');
    requests++;
    if (requests === 1) {
      assert.equal(input.tools[0].name, 'inspect');
      response.end(JSON.stringify(answer([call()])));
    } else {
      assert.equal(input.previous_response_id, 'response-a');
      assert.deepEqual(input.input, [{ type: 'function_call_output', call_id: 'call-a', output: '{"content":"resource bytes"}' }]);
      response.end(JSON.stringify(terminal()));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const adapter = createApiAgentAdapter({ scope: 'project-a', model: 'local-protocol-fixture',
    request: (body, { signal }) => fetch(`http://127.0.0.1:${port}/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }),
    tools: [{ name: 'inspect', description: 'Read the selected resource', parameters: { type: 'object' }, sideEffect: 'read',
      validate: args => args.value === 1 ? [] : ['value mismatch'],
      async execute() { toolReads++; return { content: 'resource bytes' }; } }], authorizeTool: () => true });
  const result = await adapter.runAgentTask(prepared);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.result, { ok: true });
  assert.equal(toolReads, 1);
  assert.equal(requests, 2);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(result.usage.inputTokens, 20);
});

test('tool identities deduplicate a replay while different arguments are rejected', async () => {
  let requests = 0;
  let executions = 0;
  const tools = [{ name: 'inspect', description: 'Synthetic write', parameters: { type: 'object' }, sideEffect: 'write',
    validate: () => [], operationKey: () => 'stable-business-operation', async execute() { executions++; return { ok: true }; } }];
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', authorizeTool: () => true, tools,
    request: async () => Response.json(++requests < 3 ? answer([call()]) : terminal()) });
  const result = await adapter.runAgentTask(prepared);
  assert.equal(result.status, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(result.usage.toolCalls, 2);
  let conflictRequests = 0;
  const conflict = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', authorizeTool: () => true, tools,
    request: async () => Response.json(answer([call('call-a', ++conflictRequests)])) });
  const rejected = await conflict.runAgentTask(prepared);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.failure.code, 'tool-call-conflict');
  assert.equal(rejected.failure.sideEffectStatus, 'known');
  assert.equal(executions, 2);
});

test('unknown writes require reconciliation and never repeat their external operation', async () => {
  let writes = 0;
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', authorizeTool: () => true,
    request: async () => Response.json(answer([call()])), tools: [{ name: 'inspect', description: 'Write', parameters: { type: 'object' },
      sideEffect: 'write', validate: () => [], operationKey: () => 'operation-a', async execute() { writes++; throw new Error('Connection lost'); } }] });
  const first = await adapter.runAgentTask(prepared);
  assert.equal(first.failure.sideEffectStatus, 'unknown');
  const repeated = await adapter.runAgentTask(prepared);
  assert.equal(repeated.failure.code, 'tool-outcome-unknown');
  assert.equal(writes, 1);
});

test('rate-limit retries share the same finite request budget and idempotency identity', async () => {
  const ids = [];
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', retryDelaysMs: [0, 0], limits: { maxRequests: 2 },
    request: async (_body, { idempotencyKey }) => { ids.push(idempotencyKey); return new Response('{}', { status: 429 }); } });
  const result = await adapter.runAgentTask(prepared);
  assert.equal(result.failure.code, 'request-limit');
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test('Host token policy accepts an equal valid final response and reports explicit zero and missing usage', async () => {
  async function run(usage, limit) {
    const adapter = createApiAgentAdapter({ scope: 'usage-test', model: 'controlled-fixture',
      limits: limit === undefined ? {} : { maxTotalTokens: limit },
      request: async () => Response.json({ ...terminal(), usage }) });
    return adapter.runAgentTask(prepared);
  }
  for (const observed of [9, 10]) {
    assert.equal((await run({input_tokens: observed, output_tokens: 0}, 10)).status, 'succeeded');
  }
  assert.equal((await run({input_tokens: 11, output_tokens: 0}, 10)).failure.code, 'token-limit');
  const unknown = await run({input_tokens: 0});
  assert.equal(unknown.status, 'succeeded');
  assert.deepEqual(unknown.usage.tokenCoverage, { inputTokens: 'known', outputTokens: 'unknown', cachedInputTokens: 'unknown' });
  assert.equal(unknown.usage.providerRequests, 1);
});

test('both prepared input and full request limits fail before invoking the Provider', async () => {
  for (const maxInputBytes of [16, 400]) {
    let calls = 0;
    const adapter = createApiAgentAdapter({ scope: 'input-test', model: 'controlled-fixture',
      limits: { maxInputBytes }, request: async () => { calls++; return Response.json(terminal()); } });
    const result = await adapter.runAgentTask(prepared);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'size-limit');
    assert.equal(calls, 0);
  }
});

test('pure preassembled tasks work without tools while required tools and denied tools fail before execution', async () => {
  let requests = 0;
  const options = { scope: 'team', model: 'controlled-fixture', supportsTools: false,
    request: async () => { requests++; return Response.json(terminal()); } };
  assert.equal((await createApiAgentAdapter(options).runAgentTask(prepared)).status, 'succeeded');
  const required = await createApiAgentAdapter({ ...options, requiresTools: () => true }).runAgentTask(prepared);
  assert.equal(required.failure.code, 'capability-unavailable');
  assert.equal(requests, 1);
  const denied = await createApiAgentAdapter({ ...options, supportsTools: true, authorizeTool: () => false,
    request: async () => Response.json(answer([call()])), tools: [{ name: 'inspect', description: 'Read', parameters: {},
      sideEffect: 'read', validate: () => [], execute: async () => assert.fail('Denied tool executed') }] }).runAgentTask(prepared);
  assert.equal(denied.failure.code, 'tool-access-denied');
});

test('a non-cooperating Provider times out and a cancelled task returns a classified cancellation', async () => {
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', limits: { timeoutMs: 20 },
    request: () => new Promise(() => {}) });
  const guard = setTimeout(() => {}, 100);
  const result = await adapter.runAgentTask(prepared);
  clearTimeout(guard);
  assert.equal(result.failure.code, 'deadline-exceeded');
  const controller = new AbortController();
  controller.abort();
  const cancelled = await adapter.runAgentTask(prepared, { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.sideEffectStatus, 'none');
});

test('API task deadline retains its classification when the parent cancels after the deadline', { timeout: 5000 }, async t => {
  const nativeTimeout = AbortSignal.timeout;
  const timer = new AbortController();
  // Trigger the adapter's existing deadline only after actual provider dispatch.
  // No scheduler race or provider latency is needed to order the two causes.
  t.mock.method(AbortSignal, 'timeout', ms => ms === 12345 ? timer.signal : nativeTimeout(ms));
  const parent = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const deadline = new DOMException('API task deadline exceeded', 'TimeoutError');
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', limits: { timeoutMs: 12345 },
    request: async (_body, { signal }) => {
      signal.addEventListener('abort', () => parent.abort(signal.reason), { once: true });
      entered.resolve(signal);
      await release.promise;
      return Response.json(terminal());
    } });
  const pending = adapter.runAgentTask(prepared, { signal: parent.signal });
  try {
    const effective = await entered.promise;
    timer.abort(deadline);
    const result = await pending;
    assert.equal(effective.reason, deadline);
    assert.equal(parent.signal.aborted, true);
    // A caller may propagate the exact same reason object to its own controller.
    assert.equal(parent.signal.reason, deadline);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'deadline-exceeded');
    assert.equal(result.failure.sideEffectStatus, 'none');
    assert.equal(result.usage.providerRequests, 1);
  } finally { parent.abort(); release.resolve(); await pending; }
});

test('API parent cancellation is preserved when the adapter deadline follows it', { timeout: 5000 }, async t => {
  const nativeTimeout = AbortSignal.timeout;
  const timer = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => ms === 12345 ? timer.signal : nativeTimeout(ms));
  const parent = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const reason = new Error('Host cancelled first');
  const adapter = createApiAgentAdapter({ scope: 'team', model: 'controlled-fixture', limits: { timeoutMs: 12345 },
    request: async (_body, { signal }) => {
      entered.resolve(signal);
      await release.promise;
      return Response.json(terminal());
    } });
  const pending = adapter.runAgentTask(prepared, { signal: parent.signal });
  try {
    const effective = await entered.promise;
    parent.abort(reason);
    timer.abort(new DOMException('Later deadline', 'TimeoutError'));
    const result = await pending;
    assert.equal(effective.reason, reason);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.sideEffectStatus, 'none');
  } finally { parent.abort(); release.resolve(); await pending; }
});
