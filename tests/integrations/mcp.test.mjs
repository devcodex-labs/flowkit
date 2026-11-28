import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { createFlowkitHttpHandler } from '../../src/mcp.mjs';
import { fixtureOptions } from './mcp-fixture.mjs';

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowkit-mcp-'));
  const close = [];
  t.after(async () => {
    for (const fn of close.reverse()) await fn();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, close };
}

async function assertClient(client, extended = false) {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert.ok(tools.tools.some(tool => tool.name === 'flowkit_start_workflow'));
  const result = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', requestId: 'fixture-start', operation: 'create', goal: 'Create a review workflow'
  } });
  assert.equal(result.isError, undefined);
  const draft = JSON.parse(result.content[0].text);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.choices.collectionName, 'fixture-flows');
  assert.equal(draft.questions[0].recommended, 'standard');
  const denied = await client.callTool({ name: 'flowkit_collection', arguments: { collectionId: 'another-team' } });
  assert.equal(denied.isError, true);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 1);
  const uri = resources.resources[0].uri;
  const read = await client.readResource({ uri });
  assert.match(read.contents[0].text, /Review test output/);
  await assert.rejects(client.readResource({ uri: uri.replace('test-project', 'unrelated-project') }));
  await assert.rejects(client.readResource({ uri: uri.replace('test-collection', 'another-team') }));
  await assert.rejects(client.readResource({ uri: uri + '/../secret.txt' }));
  if (extended) {
    const skills = new SkillsClient(client);
    assert.equal(skills.supported, true);
    const catalog = await skills.list();
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0].frontmatter.name, 'fixture-review');
    const file = await skills.read(catalog.skills[0], 'references/check.md');
    assert.equal(file.verified, true);
    assert.equal(file.text, 'Inspect the terminal.');
  }
  return draft;
}

test('real MCP stdio client reaches the same Author and scoped approved Skill resources', async t => {
  const { dir, close } = await directory(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url)), path.join(dir, 'host.sqlite')], stderr: 'pipe' });
  transport.stderr.resume();
  const client = new Client({ name: 'flowkit-integration', version: '1.0.0' });
  close.push(() => client.close());
  await client.connect(transport);
  const draft = await assertClient(client);
  const prepared = await client.callTool({ name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + draft.id } });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
  assert.equal(JSON.parse(prepared.content[0].text).status, 'candidate-ready');
  const startTool = (await client.listTools()).tools.find(item => item.name === 'flowkit_start_workflow');
  assert.ok(Object.hasOwn(startTool.inputSchema.properties, 'includeSource'));
  const withSource = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', requestId: 'fixture-start-with-source', operation: 'create',
    goal: 'Create a review workflow retaining the source', includeSource: true
  } });
  assert.equal(withSource.isError, undefined, JSON.stringify(withSource));
  assert.equal(JSON.parse(withSource.content[0].text).choices.includeSource, true);
});

test('stdio reports a write awaiting reconciliation and does not duplicate it after reopening', async t => {
  const { dir, close } = await directory(t), database = path.join(dir, 'host.sqlite');
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url)), database, 'write-without-result'], stderr: 'pipe' });
    transport.stderr.resume();
    const client = new Client({ name: 'flowkit-reconciliation-test', version: '1.0.0' });
    close.push(() => client.close());
    await client.connect(transport);
    return client;
  };
  const client = await connect();
  const draft = await assertClient(client);
  const request = { name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + draft.id } };
  const response = await client.callTool(request);
  assert.equal(response.isError, undefined);
  const pending = JSON.parse(response.content[0].text);
  assert.equal(pending.status, 'reconciliation-required');
  assert.equal(pending.reconciliationRequired, true);
  assert.equal(await readFile(database + '.writes', 'utf8'), 'written\n');
  await client.close();
  const reopened = await connect();
  const replay = await reopened.callTool(request);
  assert.equal(replay.isError, undefined);
  const persisted = JSON.parse(replay.content[0].text);
  assert.equal(persisted.id, draft.id);
  assert.equal(persisted.status, 'reconciliation-required');
  assert.equal(await readFile(database + '.writes', 'utf8'), 'written\n');
});

test('HTTP tool errors expose only authorized effect classifications and bounded draft recovery', async t => {
  const { dir, close } = await directory(t);
  const fixture = await fixtureOptions(path.join(dir, 'http-errors.sqlite'));
  close.push(fixture.close);
  let allowed = true, revokeOnFailure = false;
  fixture.options.authorize = async () => allowed;
  fixture.options.resolveAuthoringInput = async () => {
    if (revokeOnFailure) allowed = false;
    throw Object.assign(new Error('Host could not establish the result'), {
      code: 'FIXTURE_EFFECT_UNKNOWN', retryable: false, sideEffectStatus: 'unknown'
    });
  };
  const handler = createFlowkitHttpHandler(() => fixture.options);
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  close.push(() => new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  const client = new Client({ name: 'flowkit-http-error-test', version: '1.0.0' });
  close.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + http.address().port + '/mcp')));
  const callError = async request => {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    return JSON.parse(result.content[0].text).error;
  };
  const prepare = { name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'test-ref' } };
  assert.deepEqual(await callError(prepare), {
    code: 'FIXTURE_EFFECT_UNKNOWN', message: 'Host could not establish the result', retryable: false, sideEffectStatus: 'unknown'
  });
  revokeOnFailure = true;
  assert.deepEqual(await callError(prepare), { code: 'FKA_HOST_OPERATION_FAILED', message: 'FlowKit access denied for this collection' });
  allowed = true;
  const start = { name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', requestId: 'response-limited-draft', operation: 'create', goal: 'Review a scoped draft'
  } };
  fixture.options.limits.maxResponseBytes = 220;
  const limited = await callError(start);
  assert.equal(limited.code, 'FKA_RESPONSE_LIMIT');
  assert.equal(limited.retryable, false);
  assert.equal((await fixture.authorHost.readDraft(limited.recovery, fixture.requestContext)).id, limited.recovery.draftId);
  assert.deepEqual((await callError(start)).recovery, limited.recovery);
  fixture.options.limits.maxResponseBytes = Buffer.byteLength(JSON.stringify({ error: { code: 'FKA_RESPONSE_LIMIT' } }));
  assert.deepEqual(await callError(start), { code: 'FKA_RESPONSE_LIMIT' });
  fixture.options.limits.maxResponseBytes=512;
  let writes=0;
  fixture.options.runWorkflow=async ({executionRef})=>{
    writes++;
    return executionRef==='serialization'?{payload:1n}:{payload:'x'.repeat(1000)};
  };
  for (const [executionRef,code] of [['limit','FKA_RESPONSE_LIMIT'],['serialization','FKA_HOST_OPERATION_FAILED']]) {
    const failure=await callError({name:'flowkit_run_workflow',arguments:{collectionId:'test-collection',
      skillId:'review',candidateHash:'sha256:'+'1'.repeat(64),executionRef}});
    assert.equal(failure.code,code);
    assert.equal(failure.retryable,false);
    assert.equal(failure.sideEffectStatus,'unknown');
    assert.deepEqual(failure.recovery,{executionRef});
  }
  assert.equal(writes,2);
});

function sendHttpTool(url, requestId, params) {
  const outbound = httpRequest(url, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  outbound.on('error', () => {});
  outbound.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params }));
  return outbound;
}

test('HTTP cancellation prevents unadmitted Author work and leaves admitted work available by draft ID', { timeout: 15000 }, async t => {
  const { dir, close } = await directory(t);
  const fixture = await fixtureOptions(path.join(dir, 'client-wait.sqlite'));
  close.push(fixture.close);
  const barrier = Promise.withResolvers();
  fixture.controls.barrier = barrier.promise;
  let dispatched = Promise.withResolvers();
  const invoke = fixture.options.authorHost.advanceTurn, queue = fixture.options.queueAuthoringTurn;
  let active;
  fixture.options.authorHost = { ...fixture.options.authorHost, advanceTurn(...args) {
    active = invoke(...args);
    dispatched.resolve();
    return active;
  } };
  fixture.options.queueAuthoringTurn = (...args) => {
    active = queue(...args);
    dispatched.resolve();
    return active;
  };
  const materialEntered = Promise.withResolvers(), releaseMaterial = Promise.withResolvers();
  let holdMaterial = true, longMaterial = false;
  fixture.options.workflowUi = { defaultCollectionId: 'test-collection', present: draft => draft,
    async authoringMaterials({ input }, _context, signal) {
      if (holdMaterial) {
        materialEntered.resolve(signal);
        await releaseMaterial.promise;
      }
      return longMaterial ? { ...input, contextSnapshot: { materials: [{ id: 'long', title: 'Long',
        content: 'A material line.\n'.repeat(1500) }] } } : input;
    }
  };
  const http = createServer(createFlowkitHttpHandler(() => fixture.options));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  close.push(() => new Promise(resolve => http.close(resolve)));
  const url = new URL('http://127.0.0.1:' + http.address().port + '/mcp');
  async function connect() {
    const client = new Client({ name: 'flowkit-http-wait-test', version: '1.0.0' });
    close.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url));
    return client;
  }
  const client = await connect();
  const opened = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    requestId: 'wait-draft', operation: 'create', goal: 'Inspect', executionMode: 'standard'
  } });
  const { id, stateVersion } = JSON.parse(opened.content[0].text);
  const request = { name: 'flowkit_prepare_workflow', arguments: { inputRef: 'fixture-input-' + id } };
  const controller = new AbortController();
  try {
    const outbound = sendHttpTool(url, 'before-admission', request);
    t.after(() => outbound.destroy());
    const transportSignal = await materialEntered.promise;
    const disconnected = once(transportSignal, 'abort', { signal: t.signal });
    outbound.destroy();
    await disconnected;
    holdMaterial = false;
    releaseMaterial.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, undefined);
    assert.deepEqual(fixture.calls, []);

    for (const queued of [false, true]) {
      longMaterial = queued;
      const entered = Promise.withResolvers(), authorize = Promise.withResolvers();
      fixture.controls.authorize = async ({ action, signal }) => {
        if (action !== 'advance') return;
        entered.resolve(signal);
        await authorize.promise;
      };
      const duringAuth = sendHttpTool(url, 'authorizing-' + queued, request);
      try {
        const signal = await entered.promise;
        assert.ok(signal instanceof AbortSignal);
        const abort = once(signal, 'abort', { signal: t.signal });
        const denied = assert.rejects(active, { name: 'AbortError' });
        duringAuth.destroy();
        await abort;
        authorize.resolve();
        await denied;
        assert.equal((await fixture.authorHost.readDraft({ draftId: id }, fixture.requestContext)).stateVersion, stateVersion);
        assert.deepEqual(fixture.calls, []);
      } finally { duringAuth.destroy(); authorize.resolve(); }
    }
    fixture.controls.authorize = null;
    longMaterial = false;
    dispatched = Promise.withResolvers();

    const second = await connect();
    const pending = assert.rejects(second.callTool(request, { signal: controller.signal }));
    await dispatched.promise;
    let running;
    do {
      t.signal.throwIfAborted();
      running = await fixture.authorHost.readDraft({ draftId: id }, fixture.requestContext);
      if (running.status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
    } while (running.status !== 'running');
    controller.abort();
    await pending;
    const reconnected = await connect();
    const read = () => reconnected.callTool({ name: 'flowkit_get_workflow_draft', arguments: { draftId: id } });
    assert.equal(JSON.parse((await read()).content[0].text).status, 'running');
    barrier.resolve();
    const ready = await active;
    const observed = JSON.parse((await read()).content[0].text);
    assert.equal(observed.status, 'candidate-ready', JSON.stringify(observed));
    assert.equal(observed.candidate.hash, ready.candidate.hash);
    assert.equal(fixture.calls.filter(call => call.intent).length, 1);
    assert.equal(fixture.calls.filter(call => call.prepared?.task.node.id === 'proposal').length, 1);
  } finally { releaseMaterial.resolve(); barrier.resolve(); }
});

test('HTTP disconnect reaches an in-flight standalone Capability Graph lookup', { timeout: 5000 }, async t => {
  const { dir, close } = await directory(t);
  const fixture = await fixtureOptions(path.join(dir, 'graph-wait.sqlite'));
  close.push(fixture.close);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), stopped = Promise.withResolvers();
  fixture.options.workflowUi = { defaultCollectionId: 'test-collection', async matchCapability(_input, _context, signal) {
    entered.resolve(signal);
    await release.promise;
    stopped.resolve(signal.aborted);
    signal.throwIfAborted();
  } };
  const http = createServer(createFlowkitHttpHandler(() => fixture.options));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  close.push(() => new Promise(resolve => http.close(resolve)));
  const url = new URL('http://127.0.0.1:' + http.address().port + '/mcp');
  const outbound = sendHttpTool(url, 'graph', { name: 'flowkit_match_capability', arguments: { goal: 'Find a synthetic capability' } });
  try {
    const signal = await entered.promise;
    assert.ok(signal instanceof AbortSignal);
    const abort = once(signal, 'abort', { signal: t.signal });
    outbound.destroy();
    await abort;
    release.resolve();
    assert.equal(await stopped.promise, true);
  } finally { outbound.destroy(); release.resolve(); }
});

test('real HTTP MCP authenticates requests and returns R-03 S03 clarification before preparing or publishing', async t => {
  const { dir, close } = await directory(t);
  const fixture = await fixtureOptions(path.join(dir, 'http.sqlite'));
  close.push(fixture.close);
  const handler = createFlowkitHttpHandler(request => request.headers.authorization === 'Bearer test-only' ? fixture.options : null);
  const http = createServer((request, response) => { handler(request, response).catch(error => {
    if (!response.headersSent) response.writeHead(500);
    response.end(String(error.message));
  }); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = http.address().port;
  close.push(() => new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve())));
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const unauthenticated = await fetch(url, { method: 'POST', body: '{}' });
  assert.equal(unauthenticated.status, 401);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer test-only' } } });
  const client = new Client({ name: 'flowkit-http-test', version: '1.0.0' });
  close.push(() => client.close());
  await client.connect(transport);
  const unclear = JSON.parse((await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', requestId: 'unclear-delivery', operation: 'create', goal: 'Create a delivery workflow', executionMode: 'standard'
  } })).content[0].text);
  fixture.controls.intentGap = 'publication-destination';
  const response = await client.callTool({ name: 'flowkit_prepare_workflow', arguments: {
    collectionId: 'test-collection', inputRef: 'fixture-input-' + unclear.id
  } });
  fixture.controls.intentGap = null;
  assert.equal(response.isError, undefined);
  const pending = JSON.parse(response.content[0].text);
  assert.equal(pending.status, 'needs-clarification');
  assert.equal(pending.candidate, null);
  assert.equal(pending.choices.executionMode, 'standard');
  assert.deepEqual(pending.questions.map(({ id }) => id), ['intent:publication-destination']);
  assert.equal(pending.questions[0].recommended, 'keep-draft');
  assert.equal(pending.questions[0].customAllowed, true);
  assert.deepEqual(fixture.calls.map(call => Boolean(call.intent)), [true]);
  const rejectedStart = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', requestId: 'rejected-review', operation: 'create', goal: 'Inspect the rejected review'
  } });
  const rejectedDraft = JSON.parse(rejectedStart.content[0].text);
  fixture.controls.reviewFindings = [{ message: 'The declared action needs review.', nodeIds: ['work'] }];
  const rejectedResult = await client.callTool({ name: 'flowkit_prepare_workflow',
    arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + rejectedDraft.id } });
  fixture.controls.reviewFindings = [];
  assert.equal(rejectedResult.isError, undefined);
  const rejected = JSON.parse(rejectedResult.content[0].text);
  assert.equal(rejected.status, 'needs-revision');
  assert.equal(rejected.reviewRejection.candidateHash, rejected.candidate.hash);
  const viewed = await client.callTool({ name: 'flowkit_review_candidate', arguments: { collectionId: 'test-collection',
    draftId: rejected.id, candidateHash: rejected.candidate.hash, previousHash: rejected.previousHash } });
  assert.equal(viewed.isError, undefined);
  const failure = JSON.parse(viewed.content[0].text);
  assert.deepEqual(failure.rejection, rejected.reviewRejection);
  assert.equal(failure.receipt, null);
  const draft = await assertClient(client, true);
  const prepared = await client.callTool({name:'flowkit_prepare_workflow',arguments:{collectionId:'test-collection',inputRef:'fixture-input-' + draft.id}});
  assert.equal(prepared.isError,undefined);
  const ready = JSON.parse(prepared.content[0].text), {candidate} = ready;
  assert.equal(ready.status, 'candidate-ready');
  const identity={collectionId:'test-collection',draftId: ready.id,candidateHash:candidate.hash,previousHash:null};
  const review=await client.callTool({name:'flowkit_review_candidate',arguments:identity});
  const reviewed = JSON.parse(review.content[0].text);
  assert.equal(reviewed.diff.files.length,3);
  const publication = { ...identity, expectedStateVersion: ready.stateVersion, publicationId: 'publication', reviewRef: reviewed.receipt.reviewRef };
  const refused=await client.callTool({name:'flowkit_publish_candidate',arguments:{...publication,approvalRef:'denied'}});
  assert.equal(refused.isError,true);
  fixture.approve('fixture-approved', candidate.hash);
  fixture.options.limits.maxResponseBytes=235;
  const published=await client.callTool({name:'flowkit_publish_candidate',arguments:{...publication,approvalRef:'fixture-approved'}});
  assert.equal(published.isError,true);
  const publicationError=JSON.parse(published.content[0].text).error;
  assert.equal(publicationError.code,'FKA_RESPONSE_LIMIT');
  assert.equal(publicationError.sideEffectStatus,'known');
  assert.equal(publicationError.retryable,false);
  assert.deepEqual(publicationError.recovery,{draftId:ready.id,publicationId:'publication'});
  const recovered=await client.callTool({name:'flowkit_review_candidate',arguments:{...identity,publicationId:'publication'}});
  assert.equal(recovered.isError,undefined,JSON.stringify(recovered));
  const saved=JSON.parse(recovered.content[0].text);
  assert.equal(saved.status,'saved');
  assert.equal(saved.candidateHash,candidate.hash);
  assert.equal(saved.publicationId,'publication');
  assert.equal(saved.generation,undefined);
  assert.equal(saved.storeId,undefined);
  delete fixture.options.limits.maxResponseBytes;
  const executed=await client.callTool({name:'flowkit_run_workflow',arguments:{collectionId:'test-collection',skillId:ready.target.skillId,candidateHash:candidate.hash,executionRef:'fixture-execution'}});
  assert.equal(executed.isError,undefined);
  assert.equal(JSON.parse(executed.content[0].text).terminal,'done');
  const allResources = await client.listResources();
  assert.equal(allResources.resources.length, 2);
  const collectionAuthorization=fixture.options.authorize;
  let checks=0;
  fixture.options.authorize=async()=>{if(++checks===2)fixture.revoke();return true;};
  const receiptDenied=await client.callTool({name:'flowkit_review_candidate',arguments:{...identity,publicationId:'publication'}});
  assert.equal(receiptDenied.isError,true);
  assert.ok(!receiptDenied.content[0].text.includes(candidate.hash));
  fixture.options.authorize=collectionAuthorization;
  fixture.revoke();
  const denied = await client.callTool({ name: 'flowkit_collection', arguments: { collectionId: 'test-collection' } });
  assert.equal(denied.isError, true);
});

test('I3 S26/S27/S46/S68/S87/S108/S109: distinct HTTP subjects use one durable service and never inherit previous request authority', async t => {
  const { dir, close } = await directory(t); const fixture = await fixtureOptions(path.join(dir, 'subjects.sqlite')); close.push(fixture.close);
  const handler = createFlowkitHttpHandler(request => {
    const principalId = request.headers.authorization === 'A' ? 'fixture-user' : 'denied';
    return fixture.optionsFor({ ...fixture.requestContext, principalId });
  });
  const http = createServer(handler); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  close.push(() => new Promise(resolve => http.close(resolve)));
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`), clients = [];
  for (const identity of ['A', 'B']) {
    const client = new Client({ name: identity, version: '1' }); clients.push(client); close.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: identity } } }));
  }
  const started = await clients[0].callTool({ name: 'flowkit_start_workflow', arguments: { collectionId: 'test-collection', requestId: 'subject', operation: 'create', goal: 'Inspect' } });
  const draft = JSON.parse(started.content[0].text);
  const prepared = await clients[0].callTool({ name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + draft.id } });
  const ready = JSON.parse(prepared.content[0].text); assert.equal(ready.status, 'candidate-ready');
  assert.equal(ready.baselineEvidence, undefined); assert.equal(ready.authorizedRequest, undefined); assert.equal(ready.publications, undefined);
  const identity = { collectionId: 'test-collection', draftId: ready.id, candidateHash: ready.candidate.hash, previousHash: null };
  assert.equal((await clients[1].callTool({ name: 'flowkit_review_candidate', arguments: identity })).isError, true);
  assert.equal((await clients[0].callTool({ name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + draft.id, requestContext: { principalId: 'forged' } } })).isError, true);
  await clients[0].close();
  assert.equal((await fixture.authorHost.readDraft({ draftId: ready.id }, fixture.requestContext)).candidate.hash, ready.candidate.hash);
  fixture.approve('fixture-approved', ready.candidate.hash); fixture.revoke();
  await assert.rejects(fixture.authorHost.publish({ ...identity, expectedStateVersion: ready.stateVersion, publicationId: 'revoked',
    reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'fixture-approved' }, fixture.requestContext), /denied/);
  assert.equal(fixture.options.store.readActive('test-collection', ready.target.skillId), null);
});

test('I3 S106: disconnecting HTTP stops the request waiter while the shared independently executing turn commits', async t => {
  const { dir, close } = await directory(t); const fixture = await fixtureOptions(path.join(dir, 'disconnect.sqlite')); close.push(fixture.close);
  let release; fixture.controls.barrier = new Promise(resolve => { release = resolve; });
  close.push(() => release());
  const handler = createFlowkitHttpHandler(() => fixture.options);
  const http = createServer((req, res) => { handler(req, res).catch(() => { if (!res.writableEnded) res.end(); }); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); close.push(() => new Promise(resolve => http.close(resolve)));
  const client = new Client({ name: 'disconnect', version: '1' }); close.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
  const started = await client.callTool({ name: 'flowkit_start_workflow', arguments: { collectionId: 'test-collection', requestId: 'disconnect', operation: 'create', goal: 'Inspect' } });
  const draft = JSON.parse(started.content[0].text);
  const waiting = client.callTool({ name: 'flowkit_prepare_workflow', arguments: { collectionId: 'test-collection', inputRef: 'fixture-input-' + draft.id } }).catch(() => null);
  for (let attempt = 0; attempt < 100 && !fixture.calls.some(call => call.prepared); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fixture.calls.some(call => call.prepared)); await client.close(); release(); await waiting;
  let result;
  for (let attempt = 0; attempt < 100; attempt++) {
    result = await fixture.authorHost.readDraft({ draftId: draft.id }, fixture.requestContext);
    if (result.status === 'candidate-ready') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(result.status, 'candidate-ready', JSON.stringify(result.diagnostics));
});
