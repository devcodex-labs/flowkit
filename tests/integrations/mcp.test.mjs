import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
  assert.ok(tools.tools.some(tool => tool.name === 'flowkit_start_workflow'));
  const result = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
    collectionId: 'test-collection', goal: 'Create a review workflow'
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
}

test('real MCP stdio client reaches the same Author and scoped approved Skill resources', async t => {
  const { dir, close } = await directory(t);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url)), path.join(dir, 'host.sqlite')], stderr: 'pipe' });
  transport.stderr.resume();
  const client = new Client({ name: 'flowkit-integration', version: '1.0.0' });
  close.push(() => client.close());
  await client.connect(transport);
  await assertClient(client);
});

test('real HTTP MCP client authenticates each request and verifies negotiated Skill content', async t => {
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
  await assertClient(client, true);
  const prepared = await client.callTool({name:'flowkit_prepare_workflow',arguments:{collectionId:'test-collection',inputRef:'fixture-input'}});
  assert.equal(prepared.isError,undefined);
  const {candidate}=JSON.parse(prepared.content[0].text);
  const identity={collectionId:'test-collection',candidateHash:candidate.hash,previousHash:null};
  const review=await client.callTool({name:'flowkit_review_candidate',arguments:identity});
  assert.equal(JSON.parse(review.content[0].text).files.length,3);
  const refused=await client.callTool({name:'flowkit_publish_candidate',arguments:{...identity,reviewRef:'fixture-review',approvalRef:'denied'}});
  assert.equal(refused.isError,true);
  const published=await client.callTool({name:'flowkit_publish_candidate',arguments:{...identity,reviewRef:'fixture-review',approvalRef:'fixture-approved'}});
  assert.equal(published.isError,undefined);
  const executed=await client.callTool({name:'flowkit_run_workflow',arguments:{collectionId:'test-collection',skillId:'workflow',candidateHash:candidate.hash,executionRef:'fixture-execution'}});
  assert.equal(executed.isError,undefined);
  assert.equal(JSON.parse(executed.content[0].text).terminal,'done');
  const allResources = await client.listResources();
  assert.equal(allResources.resources.length, 2);
  fixture.revoke();
  const denied = await client.callTool({ name: 'flowkit_collection', arguments: { collectionId: 'test-collection' } });
  assert.equal(denied.isError, true);
});
