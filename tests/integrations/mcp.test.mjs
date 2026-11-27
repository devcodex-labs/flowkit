import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
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
  const published=await client.callTool({name:'flowkit_publish_candidate',arguments:{...publication,approvalRef:'fixture-approved'}});
  assert.equal(published.isError,undefined);
  const executed=await client.callTool({name:'flowkit_run_workflow',arguments:{collectionId:'test-collection',skillId:ready.target.skillId,candidateHash:candidate.hash,executionRef:'fixture-execution'}});
  assert.equal(executed.isError,undefined);
  assert.equal(JSON.parse(executed.content[0].text).terminal,'done');
  const allResources = await client.listResources();
  assert.equal(allResources.resources.length, 2);
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
