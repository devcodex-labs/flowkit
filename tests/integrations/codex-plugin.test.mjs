import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildCodexMarketplace } from '../../scripts/build-codex-plugin.mjs';
import { startLocalMcp } from '../../scripts/run-local-mcp.mjs';
import { runArtifact } from '../../src/runtime/run.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { prepareStandardSkill } from '../../src/author/standard-artifact.mjs';
import { browserIdentity, confirmInTestBrowser, monthlyTimesheetModel } from './local-mcp-fixture.mjs';

async function ownedDirectory(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'flowkit-mcp-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), parent);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('Codex marketplace contains a pure FlowKit MCP plugin and a credential reference', async t => {
  const root = await ownedDirectory(t);
  const url = 'http://127.0.0.1:9876/mcp';
  const { marketplace, plugin, selector } = await buildCodexMarketplace(root, { url });
  const entry = JSON.parse(await readFile(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(path.resolve(marketplace, entry.plugins[0].source.path), plugin);
  assert.equal(selector, 'flowkit-mcp@flowkit-local');
  assert.deepEqual((await readdir(plugin)).sort(), ['.codex-plugin', '.mcp.json']);
  const manifest = JSON.parse(await readFile(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'flowkit-mcp');
  assert.equal(manifest.interface.displayName, 'FlowKit MCP');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(Object.hasOwn(manifest, 'skills'), false);
  const mcp = JSON.parse(await readFile(path.join(plugin, manifest.mcpServers), 'utf8'));
  assert.deepEqual(mcp.mcpServers.flowkit, { type: 'http', url, bearer_token_env_var: 'FLOWKIT_MCP_TOKEN' });
});

test('local MCP previews and confirms an exact candidate, exports three files and replays additions after restart', async t => {
  let service, client;
  t.after(async () => { await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'data'), exportDir: path.join(root, 'output') };
  const credential = 'fixture-test-credential-for-flowkit-mcp';
  const renderer = 'var mermaid = {initialize(){}, async render(){return {svg:"<svg></svg>"}}};';
  const options = { credential, renderer, canInstall: selector => selector === 'fixture@market', modelBinding: monthlyTimesheetModel() };
  service = await startLocalMcp(config, options);
  const connect = async () => {
    client = new Client({ name: 'flowkit-local-integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { authorization: 'Bearer ' + credential } }
    }));
  };
  const tool = async (name, args, success = true) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, !success, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  await connect();
  const origin = new URL(service.url).origin;
  const unauthorized = await fetch(service.url, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  assert.equal(unauthorized.status, 401);
  assert.ok((await client.listTools()).tools.some(item => item.name === 'flowkit_add_workflow'));
  assert.equal(client.getServerCapabilities().resources, undefined);
  const collection = await tool('flowkit_collection', {});
  assert.equal(collection.collection.name, 'flowkit-workflows');
  assert.equal(Object.hasOwn(collection.collection, 'rootSkill'), false);
  const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'monthly-start',
    goal: '校验月度工时输入，写入副本并二次校验，失败结束。', includeSource: true });
  const candidate = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'monthly-prepare',
    expectedStateVersion: draft.stateVersion, input: '首次准备月度工时', target: { name: 'monthly-timesheet' } } });
  assert.equal(candidate.status, 'candidate-ready', JSON.stringify(candidate));
  assert.equal(Object.hasOwn(candidate.candidate, 'files'), false);
  assert.equal(Object.hasOwn(candidate, 'approvalReceipt'), false);
  const args = { draftId: draft.id, candidateHash: candidate.candidate.candidateHash };
  await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'stale-prepare',
    expectedStateVersion: draft.stateVersion, input: '新的请求不能覆盖已完成的版本' } }, false);
  await tool('flowkit_export_workflow', args, false);
  const preview = candidate.candidate.previewUrl;
  assert.match(await (await fetch(preview)).text(), /Check input/);
  assert.equal((await fetch(preview + '/confirm', { method: 'POST' })).status, 404);
  const cookie = await browserIdentity(service);
  await confirmInTestBrowser(preview, cookie);
  const approved = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
  assert.ok(approved.stateVersion > candidate.stateVersion);
  const exported = await tool('flowkit_export_workflow', args);
  assert.deepEqual((await readdir(exported.directory)).sort(), ['workflow.html','workflow.js','workflow.mmd']);
  for (const file of exported.files) {
    const contents = await readFile(path.join(exported.directory, file.name));
    assert.equal(artifactDigest(contents), file.sha256);
    assert.equal(artifactDigest(Buffer.from(await (await fetch(file.url)).arrayBuffer())), file.sha256);
  }
  const artifact = exported.files.find(file => file.name === 'workflow.js');
  for (const failedAt of [null, 'check-input', 'check-copy']) {
    const calls = [];
    const result = await runArtifact(path.join(exported.directory, artifact.name), artifact.sha256, {
      isControlSignal: () => false,
      async runVerification(id) { calls.push(id); return id !== failedAt; },
      async runAction(id) { calls.push(id); }
    }, {});
    assert.equal(result.terminal, failedAt ? 'failed' : 'done');
    assert.deepEqual(calls, failedAt === 'check-input' ? ['check-input'] : ['check-input', 'write-copy', 'check-copy']);
  }
  const addRequest = { requestId: 'add-monthly', sourceRef: draft.id, candidateHash: args.candidateHash };
  assert.equal((await tool('flowkit_add_workflow', { ...addRequest, approvalRef: 'caller-supplied-approval' })).status, 'rejected');
  const readyToAdd = await tool('flowkit_add_workflow', addRequest);
  assert.equal(readyToAdd.status, 'rejected');
  assert.equal((await tool('flowkit_collection', {})).skills.length, 0);
  const added = await (await confirmInTestBrowser(readyToAdd.confirmationUrl, cookie)).json();
  assert.equal(added.status, 'added');
  assert.equal(added.candidateHash, args.candidateHash);
  assert.equal((await tool('flowkit_collection', {})).skills.length, 1);
  await client.close(); client = null;
  const oldId = service.collectionId;
  await service.close(); service = null;
  const journal = new DatabaseSync(path.join(config.dataDir, 'local-mcp.sqlite'));
  try {
    const key = 'add:' + addRequest.requestId;
    const { result: _result, ...pending } = JSON.parse(journal.prepare('SELECT value FROM local_mcp WHERE key=?').get(key).value);
    journal.prepare('UPDATE local_mcp SET value=? WHERE key=?').run(JSON.stringify(pending), key);
    journal.prepare('DELETE FROM local_mcp WHERE key LIKE ?').run('export-source:%');
  } finally { journal.close(); }
  service = await startLocalMcp(config, options);
  assert.equal(service.collectionId, oldId);
  await connect();
  assert.deepEqual(await tool('flowkit_add_workflow', addRequest), added);
  const recoveredExport = await tool('flowkit_export_workflow', args);
  assert.equal(recoveredExport.directory, exported.directory);
  assert.deepEqual(recoveredExport.files.map(file => file.sha256), exported.files.map(file => file.sha256));
  assert.equal((await tool('flowkit_add_workflow', { ...addRequest, requestId: 'another-add' })).status, 'already_added');
  assert.equal((await tool('flowkit_add_workflow', { ...addRequest, sourceRef: 'other-candidate' })).status, 'conflict');
  const restoredOrigin = new URL(service.url).origin;
  const newCookie = await browserIdentity(service);
  const returned = Object.fromEntries(await Promise.all(exported.files.map(async file =>
    [file.name, await readFile(path.join(exported.directory, file.name), 'utf8')])));
  const upload = source => fetch(restoredOrigin + '/sources', {
    method: 'POST', headers: { origin: restoredOrigin, cookie: newCookie },
    body: new URLSearchParams({ source: JSON.stringify(source), codex: 'fixture@market' })
  }).then(response => response.json());
  const same = await upload(returned);
  assert.equal((await tool('flowkit_add_workflow', { requestId: 'same-files', ...same })).status, 'already_added');
  const changed = await upload({ ...returned, 'workflow.mmd': returned['workflow.mmd'] + '\nchanged' });
  assert.equal((await tool('flowkit_add_workflow', { requestId: 'changed-files', ...changed })).status, 'conflict');
  const external = await upload({});
  const choice = await tool('flowkit_add_workflow', { requestId: 'external-probe', ...external });
  assert.equal(choice.status, 'choice_required');
  assert.deepEqual(choice.options.map(option => option.available), [false, true]);
  const install = await tool('flowkit_add_workflow', { requestId: 'external-choice', destination: 'codex', ...external });
  assert.equal(install.status, 'install_required');
  const { candidate: externalCandidate } = await prepareStandardSkill({
    file: path.resolve('examples/docs/conditional-routing/sample.workflow.js'),
    collectionId: 'other-collection', skillId: 'external-routing', name: 'external-routing',
    description: 'External routing workflow', version: '1.0.0', buildId: 'test-build',
    hostProfile: { id: 'flowkit-local-authoring', digest: artifactDigest('flowkit-local-authoring-v1') },
    compilerOptions: { skillCheck: false }
  });
  assert.ok(externalCandidate);
  const source = await upload(externalCandidate);
  const optionsForCandidate = await tool('flowkit_add_workflow', { requestId: 'compatible-choice', ...source });
  assert.deepEqual(optionsForCandidate.options.map(option => option.available), [true, true]);
  const externalRequest = { requestId: 'add-external', destination: 'flowkit', ...source };
  const confirmExternal = await tool('flowkit_add_workflow', externalRequest);
  const imported = await (await confirmInTestBrowser(confirmExternal.confirmationUrl, newCookie)).json();
  assert.equal(imported.status, 'added');
  assert.equal((await tool('flowkit_collection', {})).skills.length, 2);
  assert.deepEqual(await tool('flowkit_add_workflow', externalRequest), imported);
});
