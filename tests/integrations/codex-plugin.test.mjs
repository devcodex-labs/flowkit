import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildCodexMarketplace } from '../../scripts/build-codex-plugin.mjs';
import { exportTrust, newExportKey, publicDelivery, readPortableExport } from '../../scripts/local-mcp-artifacts.mjs';
import { startLocalMcp } from '../../scripts/run-local-mcp.mjs';
import { defaultLayout, readWorkflowPageData } from '../../scripts/workflow-viewer.mjs';
import { generateLayout } from '../../scripts/workflow-viewer/auto-layout.mjs';
import { runArtifact } from '../../src/runtime/run.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { prepareStandardSkill } from '../../src/author/standard-artifact.mjs';
import { bindProfessionalNeeds } from '../../src/author/workflow-professional-bindings.mjs';
import { prepareProfessionalSkill } from '../../src/author/professional-skills.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { runApprovedCollectionWorkflow } from '../../src/host.mjs';
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

test('the local Author drafts only after catalog lookup, publishes the approved Skill with the workflow, and reuses it', async t => {
  let service, client, receiver, receiverClient;
  t.after(async () => { await receiverClient?.close(); await receiver?.close(); await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const model = monthlyTimesheetModel();
  const request = model.execution.request;
  let draftCount = 0;
  const skillBody = '# Review procedure\n\nUse the confirmed input and return a note.';
  model.execution.request = async input => {
    if (input.flowkitProfessionalSkill) {
      assert.equal(input.flowkitProfessionalSkill.id, 'review-procedure');
      draftCount++;
      return { body: skillBody };
    }
    if (input.prepared?.task.node.id !== 'proposal') return request(input);
    const entry = { id: 'review', kind: 'agent', name: 'Review record', requiredRole: { id: 'reviewer', label: '复核员' },
      professionalNeeds: [{ id: 'review-procedure', description: 'Review one provided record.' }],
      options: { description: 'Review the record', inputs: [], output: { type: 'object' }, next: 'finish' } };
    const nodes = [entry, { id: 'finish', kind: 'terminal', name: 'Complete', options: { status: 'succeeded' } }];
    return { status: 'succeeded', result: { rawText: JSON.stringify({ entryNodeId: entry.id, nodes, edges: [], coverage: [
      { intentId: 'timesheet', status: 'covered', coveredBy: ['review'] },
      { intentId: 'verify-copy', status: 'covered', coveredBy: ['review'] }
    ] }) }, events: [] };
  };
  const token = 'fixture-professional-skill-credential';
  const stateDir = path.join(root, 'state');
  service = await startLocalMcp({ listen: { port: 0 }, dataDir: stateDir, exportDir: path.join(root, 'exports') },
    { credential: token, modelBinding: model });
  client = new Client({ name: 'professional-skill-integration', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
  const tool = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  const start = async name => {
    const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: name, goal: 'Review one provided record.' });
    const prepared = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: name,
      expectedStateVersion: draft.stateVersion, input: 'Review one provided record.', target: { name } } });
    assert.equal(prepared.status, 'candidate-ready', JSON.stringify(prepared));
    return prepared;
  };
  const approvedSkills = () => {
    const db = new DatabaseSync(path.join(stateDir, 'author.sqlite'), { readOnly: true });
    try { return db.prepare("SELECT payload FROM fk_author_versions WHERE json_extract(payload,'$.manifest.kind')='professional'").all()
      .map(row => JSON.parse(row.payload)); }
    finally { db.close(); }
  };
  const cookie = await browserIdentity(service);
  const first = await start('review-first');
  assert.equal(draftCount, 1);
  assert.equal(approvedSkills().length, 0);
  const draftHtml = await (await fetch(first.candidate.previewUrl, { headers: { cookie } })).text();
  assert.match(draftHtml, /Use the confirmed input/);
  const [binding] = readWorkflowPageData(draftHtml).executionBindings;
  assert.equal(binding.role.label, '复核员');
  assert.equal(binding.skills[0].pendingApproval, true);
  const add = await tool('flowkit_add_workflow', { requestId: 'add-first', sourceRef: first.id, candidateHash: first.candidate.candidateHash });
  const saved = await (await confirmInTestBrowser(add.confirmationUrl, cookie)).json();
  assert.equal(saved.status, 'added');
  const [skill] = approvedSkills();
  assert.equal(approvedSkills().length, 1);
  assert.equal(skill.manifest.digest, binding.skills[0].digest);
  const second = await start('review-second');
  assert.equal(draftCount, 1);
  const reusedHtml = await (await fetch(second.candidate.previewUrl, { headers: { cookie } })).text();
  assert.doesNotMatch(reusedHtml, /Use the confirmed input/);
  const [reused] = readWorkflowPageData(reusedHtml).executionBindings;
  const { pendingApproval: _pending, ...pin } = binding.skills[0];
  assert.deepEqual(reused.skills, [pin]);

  const exported = await tool('flowkit_export_workflow', { draftId: first.id, candidateHash: first.candidate.candidateHash });
  const files = Object.fromEntries(await Promise.all(['workflow.js', 'workflow.mmd', 'workflow.html'].map(async name =>
    [name, await readFile(path.join(exported.directory, name), 'utf8')])));
  const trust = exportTrust([service.exportPublicKey]);
  const portable = readPortableExport(files, trust);
  assert.equal(portable.candidate.hash, first.candidate.candidateHash);
  assert.deepEqual(portable.candidate.manifest.professionalSkills[0], { nodeId: 'review', ...pin });
  assert.equal(readPortableExport({ ...files, 'workflow.mmd': files['workflow.mmd'] + '\n' }, trust).invalid, true);
  assert.equal(readPortableExport(files, exportTrust()).untrusted, true);
  for (const content of Object.values(files)) assert.doesNotMatch(content, /Use the confirmed input/);

  const receiverState = path.join(root, 'receiver');
  receiver = await startLocalMcp({ listen: { port: 0 }, dataDir: receiverState, exportDir: path.join(root, 'received'),
    trustedExportKeys: [service.exportPublicKey] }, { credential: token, modelBinding: monthlyTimesheetModel() });
  receiverClient = new Client({ name: 'professional-skill-receiver', version: '1.0.0' });
  await receiverClient.connect(new StreamableHTTPClientTransport(new URL(receiver.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
  const receiverOrigin = new URL(receiver.url).origin;
  const receiverCookie = await browserIdentity(receiver);
  const uploaded = await fetch(receiverOrigin + '/sources', { method: 'POST', headers: { cookie: receiverCookie, origin: receiverOrigin },
    body: new URLSearchParams({ source: JSON.stringify(files) }) });
  assert.equal(uploaded.status, 200);
  const { sourceRef } = await uploaded.json();
  const added = await receiverClient.callTool({ name: 'flowkit_add_workflow', arguments: { requestId: 'receive-bound', sourceRef,
    candidateHash: portable.candidate.hash, destination: 'flowkit' } });
  assert.equal(added.isError === true, false, JSON.stringify(added));
  const waiting = JSON.parse(added.content[0].text);
  const missingHtml = await (await fetch(waiting.confirmationUrl, { headers: { cookie: receiverCookie } })).text();
  assert.match(missingHtml, /当前宿主无法核对依赖/);
  const received = await (await confirmInTestBrowser(waiting.confirmationUrl, receiverCookie)).json();
  assert.equal(received.status, 'added');

  const store = openLocalSkillStore(path.join(receiverState, 'author.sqlite'), () => false, () => false, { namespace: 'flowkit-local' });
  try {
    const request = { collectionId: receiver.collectionId, skillId: received.workflowId, candidateHash: received.candidateHash,
      skillDirectory: exported.directory, executionRef: 'authorized-source-run' };
    let dispatched = 0;
    const runtime = { taskPolicy: { projectRoot: root, hostProfile: { schemaVersion: 1, hostId: 'receiver', hostVersion: '1.0.0',
      adapterId: 'local', adapterVersion: '1.0.0', executionModes: ['standard'], capabilities: { skillResourceLoading: 'supported' } } },
      isControlSignal: () => false, validateResult: () => [], async runAgentTask(prepared) {
        dispatched++;
        const [resource] = prepared.skills;
        assert.equal(resource.source, pin.source);
        assert.equal(resource.digest, pin.digest);
        assert.match(resource.files['SKILL.md'], /Use the confirmed input/);
        return { status: 'succeeded', result: {}, events: [] };
      } };
    const options = { hostProfile: portable.candidate.manifest.hostProfile, authorizeExecution: () => true, runtime };
    await assert.rejects(runApprovedCollectionWorkflow(store, request, options, {}), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    await assert.rejects(runApprovedCollectionWorkflow(store, request, { ...options, resolveRunProfessionalSkill: () =>
      ({ authorized: false, source: pin.source, candidate: skill }) }, {}), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    await assert.rejects(runApprovedCollectionWorkflow(store, request, { ...options, resolveRunProfessionalSkill: () =>
      ({ authorized: true, source: pin.source, candidate: { ...skill, manifest: { ...skill.manifest, version: '2.0.0' } } }) }, {}),
    { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    const altered = { ...skill, files: { ...skill.files, 'SKILL.md': skill.files['SKILL.md'] + '\nChanged.' } };
    await assert.rejects(runApprovedCollectionWorkflow(store, request, { ...options, resolveRunProfessionalSkill: () =>
      ({ authorized: true, source: pin.source, candidate: altered }) }, {}), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    assert.equal(dispatched, 0);
    const resolution = async requested => {
      assert.equal(requested.id, pin.id);
      return { authorized: true, source: pin.source, candidate: skill };
    };
    const run = await runApprovedCollectionWorkflow(store, request, { ...options, resolveRunProfessionalSkill: resolution }, {});
    assert.equal(run.status, 'succeeded');
    assert.equal(dispatched, 1);
  } finally { store.close(); }
});

test('incomplete and denied Professional Skill discovery never starts a Skill draft', async () => {
  const proposal = { nodes: [{ id: 'review', kind: 'agent', options: {},
    professionalNeeds: [{ id: 'review-procedure', description: 'Review the selected record.' }] }] };
  for (const searchResult of [{ complete: false, matches: [] }, { complete: true, denied: true, matches: [] }]) {
    const bound = await bindProfessionalNeeds(proposal, {
      catalog: { search: async () => searchResult }, collection: { id: 'collection' },
      read: (_request, operation) => operation(), draftSkill: () => { throw new Error('drafting is forbidden'); },
      drafts: new Map(), selectionFor: () => undefined
    });
    assert.equal(bound.unresolvedIssues[0].blocking, true);
    assert.equal(bound.resourceRequirements.length, 0);
  }
  const collection = { id: 'catalog', name: 'catalog', directory: 'catalog' };
  const candidate = prepareProfessionalSkill(collection, { id: 'review-procedure', name: 'review-procedure',
    version: '1.0.0', description: 'Review the selected record.', body: 'Review and report the evidence.' });
  const matches = ['source-a', 'source-b'].map(source => ({ source, candidate, approved: true }));
  const scope = { collection, catalog: { search: async () => ({ complete: true, matches }) }, read: (_input, run) => run(),
    drafts: new Map(), draftSkill: () => { throw new Error('drafting is forbidden'); } };
  const undecided = await bindProfessionalNeeds(proposal, { ...scope, selectionFor: () => undefined });
  assert.equal(undecided.unresolvedIssues[0].blocking, true);
  const choice = undecided.unresolvedIssues[0].options.find(option => option.label.endsWith('(source-b)'));
  const selected = await bindProfessionalNeeds(proposal, { ...scope, selectionFor: () => choice.value });
  assert.deepEqual(selected.unresolvedIssues, []);
  assert.equal(selected.resourceRequirements[0].source, 'source-b');
});

test('invalid placement and partition replies receive exact feedback before tightly scoped arrangement', async () => {
  for (const count of [52, 62]) {
    const nodes = Array.from({ length: count }, (_, index) => ({ id: 'node' + index, name: 'Step ' + index,
      type: index + 1 === count ? 'terminal' : 'action' }));
    const referenceEdges = nodes.slice(0, -1).map(({ id }, index) => ({
      edgeId: artifactDigest(id), from: id, to: nodes[index + 1].id, role: 'next', origin: 'declared'
    }));
    const graph = { graphDigest: artifactDigest(JSON.stringify(nodes)), entryNodeId: nodes[0].id, nodes,
      regions: [], referenceEdges, executionEdges: [] };
    const base = defaultLayout(graph);
    const result = await generateLayout(graph, base, async ({ input }) => {
      const reply = { schemaVersion: input.schemaVersion, graphDigest: input.graphDigest };
      if (input.task === 'placement') {
        if (input.feedback) {
          assert.ok(input.repair.findings.some(finding => finding.issue === 'occupied-cell'));
          assert.ok(input.repair.missingIds.length);
          assert.ok(input.repair.acceptedPlacements.length);
        }
        Object.assign(reply, { phases: [{ id: 'phase', title: 'Steps', direction: 'LR' }],
          placements: input.nodes.slice(0, 2).map(({ id }) => ({ id, phase: 'phase', col: 0, row: 0 })), routes: [] });
      } else if (input.task === 'partition') {
        if (input.feedback) assert.deepEqual([input.repair.minRegions, input.repair.actualRegions], [2, 1]);
        Object.assign(reply, { regions: [{ id: 'all', members: input.units.map(u => u.id) }] });
      } else {
        assert.ok(input.units.length <= 12);
        Object.assign(reply, { title: 'Smaller scope', direction: 'LR', span: Math.min(4, input.units.length),
          order: input.units.map(u => u.id) });
      }
      return { provider:'fixture', model:'fixture', text:JSON.stringify(reply) };
    });
    assert.ok(result.layout, result.reason);
    assert.equal(result.layout.nodes.length, count);
    assert.equal(result.layout.edges.length, referenceEdges.length);
    assert.deepEqual(new Set(result.layout.nodes.map(n => n.nodeId)), new Set(nodes.map(n => n.id)));
    assert.ok(result.receipts.some(r => r.task === 'arrangement' && r.accepted));
    assert.ok(result.receipts.some(r => r.diagnostics));
  }
});

test('automatic layout keeps a parallel repair subtree in its loop without changing graph membership', async () => {
  const kinds = { entry: 'action', loop: 'loop', check: 'verification', repair: 'parallel',
    lane: 'action', finish: 'terminal' };
  const nodes = Object.entries(kinds).map(([id, type]) => ({ id, name: id, type }));
  const referenceEdges = [
    ['entry', 'loop', 'next'], ['loop', 'check', 'loop-enter'], ['check', 'repair', 'loop-repair'],
    ['repair', 'lane', 'parallel-entry'], ['lane', 'finish', 'next'], ['check', 'finish', 'verify-ok']
  ].map(([from, to, role]) => ({ edgeId: artifactDigest(from + to), from, to, role, origin: 'declared' }));
  const regions = [
    { ownerId: 'loop', kind: 'loop', memberIds: ['check', 'repair'], normalExits: ['finish'] },
    { ownerId: 'repair', kind: 'parallel', memberIds: ['lane'], normalExits: ['finish'] }
  ];
  const graph = { graphDigest: artifactDigest(JSON.stringify(nodes)), entryNodeId: 'entry', nodes,
    regions, referenceEdges, executionEdges: [] };
  const before = structuredClone(graph);
  const base = defaultLayout(graph);
  const { layout, reason } = await generateLayout(graph, base, async ({ input }) => {
    const loop = input.groups.find(group => group.kind === 'loop');
    const parallel = input.groups.find(group => group.kind === 'parallel');
    assert.ok(parallel.members.every(id => loop.members.includes(id)));
    return { provider: 'fixture', model: 'fixture', text: JSON.stringify({
      schemaVersion: input.schemaVersion, graphDigest: input.graphDigest,
      phases: [{ id: 'flow', title: 'Flow', direction: 'LR' }],
      placements: input.nodes.map(({ id }, col) => ({ id, phase: 'flow', col, row: 0 })), routes: []
    }) };
  });
  assert.ok(layout, reason);
  assert.deepEqual(graph, before);
  const frame = layout.groups.find(group => group.ownerId === 'loop');
  const child = layout.groups.find(group => group.ownerId === 'repair');
  assert.ok(frame.x < child.x && frame.x + frame.w > child.x + child.w);
  assert.deepEqual(new Set(layout.edges.map(edge => edge.edgeId)), new Set(referenceEdges.map(edge => edge.edgeId)));
});

test('relayout is versioned and idempotent and preserves old signed downloads on failure and restart', async t => {
  let service, client;
  t.after(async () => { await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'data'), exportDir: path.join(root, 'output') };
  const credential = 'fixture-credential-for-explicit-relayout';
  const modelBinding = monthlyTimesheetModel();
  let calls = 0, available = false;
  modelBinding.planLayout = async ({ input }) => {
    const generation = ++calls;
    if (!available) throw new Error('fixture model unavailable');
    await new Promise(resolve => setTimeout(resolve, 10));
    const text = JSON.stringify({ schemaVersion: input.schemaVersion, graphDigest: input.graphDigest,
      phases: [{ id: 'p', title: 'Verified layout ' + generation, direction: 'TB' }],
      placements: input.nodes.map(({ id }, row) => ({ id, phase: 'p', col: 0, row })), routes: [] });
    return { text, provider: 'fixture', model: 'fixture' };
  };
  const start = async () => {
    service = await startLocalMcp(config, { credential, modelBinding });
    client = new Client({ name: 'relayout-integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { authorization: 'Bearer ' + credential } }
    }));
    return browserIdentity(service);
  };
  const tool = async (name, args, success = true) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, !success, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const cookie = await start();
  const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'layout-start', goal: '准备工时校验工作流' });
  const prepared = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'layout-prepare',
    expectedStateVersion: draft.stateVersion, input: '校验月度工时，写入副本并复核，失败结束。', target: { name: 'monthly-timesheet' } } });
  const { candidateHash, previewUrl, layoutRevision } = prepared.candidate;
  const args = { draftId: draft.id, candidateHash };
  await confirmInTestBrowser(previewUrl, cookie);
  const old = await tool('flowkit_export_workflow', args);
  const readDelivery = async dir => Object.fromEntries(await Promise.all(Object.keys(oldFiles).map(async name =>
    [name, await readFile(path.join(dir, name), 'utf8')])));
  const oldFiles = Object.fromEntries(old.files.map(file => [file.name, file]));
  const original = await readDelivery(old.directory);
  assert.ok(readWorkflowPageData(original['workflow.html']).layout.edges.every(edge => !edge.route));
  available = true;
  const request = { ...args, requestId: 'recover-fallback', expectedLayoutRevision: layoutRevision };
  const replacement = await tool('flowkit_relayout_workflow', request);
  assert.equal(replacement.status, 'relayout-complete');
  const reused = calls;
  assert.equal((await tool('flowkit_relayout_workflow', request)).layoutRevision, replacement.layoutRevision);
  assert.equal(calls, reused);
  assert.equal((await tool('flowkit_export_workflow', { ...args, layoutRevision }, false)).error.code, 'FKA_LAYOUT_CONFLICT');
  const newer = await tool('flowkit_export_workflow', { ...args, layoutRevision: replacement.layoutRevision });
  const revised = await readDelivery(newer.directory);
  assert.notEqual(newer.directory, old.directory);
  assert.equal(revised['workflow.js'], original['workflow.js']);
  assert.equal(revised['workflow.mmd'], original['workflow.mmd']);
  for (const file of [original, revised]) {
    assert.equal(readPortableExport(file, exportTrust([service.exportPublicKey])).candidate.hash, candidateHash);
  }
  assert.equal(await (await fetch(oldFiles['workflow.html'].url)).text(), original['workflow.html']);
  const opened = readWorkflowPageData(await (await fetch(replacement.previewUrl, { headers: { cookie } })).text());
  assert.deepEqual(opened, readWorkflowPageData(revised['workflow.html']));
  const concurrent = await Promise.all(['concurrent-first', 'concurrent-second'].map(requestId =>
    client.callTool({ name: 'flowkit_relayout_workflow', arguments: { ...args, requestId,
      expectedLayoutRevision: replacement.layoutRevision } })));
  assert.equal(concurrent.filter(result => result.isError === true).length, 1);
  const winning = JSON.parse(concurrent.find(result => !result.isError).content[0].text);
  assert.equal(winning.status, 'relayout-complete');
  assert.equal((await fetch(replacement.previewUrl, { headers: { cookie } })).status, 409);
  available = false;
  const failed = await tool('flowkit_relayout_workflow', { ...args, requestId: 'model-failed',
    expectedLayoutRevision: winning.layoutRevision });
  assert.deepEqual([failed.status, failed.layoutRevision], ['relayout-failed', winning.layoutRevision]);
  await client.close(); client = null;
  await service.close(); service = null;
  await start();
  const count = calls;
  const current = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
  assert.equal(current.candidate.layoutRevision, winning.layoutRevision);
  assert.ok(await tool('flowkit_export_workflow', { ...args, layoutRevision: winning.layoutRevision }));
  assert.equal(calls, count);
  assert.deepEqual(await readDelivery(old.directory), original);
});

test('local MCP pins a validated model layout, confirms the candidate and replays the three-file export after restart', async t => {
  let service, client;
  t.after(async () => { await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'data'), exportDir: path.join(root, 'output') };
  const credential = 'fixture-test-credential-for-flowkit-mcp';
  const modelBinding = monthlyTimesheetModel();
  let layoutRequests = 0;
  modelBinding.planLayout = async ({ guide, input }) => {
    assert.match(guide, /flowkit-workflow-layout/);
    assert.equal(input.task, 'placement');
    layoutRequests++;
    if (layoutRequests === 1) return { text: '{"schemaVersion":1}', provider: 'fixture', model: 'fixture' };
    if (layoutRequests > 2) throw new Error('fixture model unavailable');
    assert.match(input.feedback, /graph digest/);
    const text = JSON.stringify({ schemaVersion: input.schemaVersion, graphDigest: input.graphDigest,
      phases: [{ id: 'review', title: '工时复核', direction: 'TB' }],
      placements: input.nodes.map(({ id }, row) => ({ id, phase: 'review', col: row === 4 ? 1 : 0, row })),
      routes: [] });
    return { text, provider: 'fixture', model: 'fixture' };
  };
  const options = { credential, canInstall: selector => selector === 'fixture@market', modelBinding };
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
  assert.equal(unauthorized.headers.get('connection'), 'close');
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
  assert.equal(layoutRequests, 0);
  assert.equal((await fetch(preview + '/confirm', { method: 'POST' })).status, 404);
  const cookie = await browserIdentity(service);
  const openPreview = () => fetch(preview, { headers: { cookie } }).then(response => response.text()).then(readWorkflowPageData);
  const [first, second] = await Promise.all([openPreview(), openPreview()]);
  assert.equal(layoutRequests, 2);
  assert.deepEqual(first.layout, second.layout);
  assert.equal(first.layout.phases[0].title, '工时复核');
  assert.ok(first.layout.edges.every(edge => edge.route.length >= 2));
  await confirmInTestBrowser(preview, cookie);
  const approved = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
  assert.ok(approved.stateVersion > candidate.stateVersion);
  const exported = await tool('flowkit_export_workflow', args);
  const offline = readWorkflowPageData(await readFile(path.join(exported.directory, 'workflow.html'), 'utf8'));
  assert.deepEqual(offline, first);
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
  assert.equal(layoutRequests, 2);
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
  const fallback = readWorkflowPageData(await (await fetch(confirmExternal.confirmationUrl, { headers: { cookie: newCookie } })).text());
  assert.equal(layoutRequests, 4);
  assert.ok(fallback.layout.edges.every(edge => !edge.route));
  const imported = await (await confirmInTestBrowser(confirmExternal.confirmationUrl, newCookie)).json();
  assert.equal(imported.status, 'added');
  assert.equal(layoutRequests, 4);
  assert.equal((await tool('flowkit_collection', {})).skills.length, 2);
  assert.deepEqual(await tool('flowkit_add_workflow', externalRequest), imported);
});

test('local MCP imports an intact three-file export only from a trusted origin and requires new approval', async t => {
  let sender, receiver, sourceClient, targetClient;
  t.after(async () => {
    await sourceClient?.close();
    await targetClient?.close();
    await sender?.close();
    await receiver?.close();
  });
  const root = await ownedDirectory(t);
  const serviceConfig = name => ({ listen: { port: 0 }, dataDir: path.join(root, name), exportDir: path.join(root, name, 'exports') });
  const credential = 'fixture-test-credential-for-flowkit-mcp';
  const options = { credential, modelBinding: monthlyTimesheetModel() };
  const connect = async service => {
    const client = new Client({ name: 'flowkit-portable-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + credential } } }));
    return client;
  };
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  sender = await startLocalMcp(serviceConfig('sender'), options);
  sourceClient = await connect(sender);
  const draft = await call(sourceClient, 'flowkit_start_workflow', { operation: 'create', requestId: 'new', goal: '核对工时后验证副本。' });
  const ready = await call(sourceClient, 'flowkit_prepare_workflow', { turn: { draftId: draft.id,
    turnId: 'prepare', input: '核对工时后验证副本。', expectedStateVersion: draft.stateVersion } });
  assert.equal(ready.status, 'candidate-ready');
  const senderCookie = await browserIdentity(sender);
  await confirmInTestBrowser(ready.candidate.previewUrl, senderCookie);
  const delivered = await call(sourceClient, 'flowkit_export_workflow', { draftId: draft.id, candidateHash: ready.candidate.candidateHash });
  const files = Object.fromEntries(await Promise.all(delivered.files.map(async file =>
    [file.name, await readFile(path.join(delivered.directory, file.name), 'utf8')])));
  assert.deepEqual(Object.keys(files).sort(), ['workflow.html', 'workflow.js', 'workflow.mmd']);
  assert.match(files['workflow.html'], /id="flowkit-export-provenance"/);

  const receiverConfig = serviceConfig('receiver');
  const upload = async (filesToSend, cookie) => {
    const origin = new URL(receiver.url).origin;
    const response = await fetch(origin + '/sources', { method: 'POST', headers: { origin, cookie },
      body: new URLSearchParams({ source: JSON.stringify(filesToSend) }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  receiver = await startLocalMcp(receiverConfig, options);
  targetClient = await connect(receiver);
  const unknown = await upload(files, await browserIdentity(receiver));
  const choice = await call(targetClient, 'flowkit_add_workflow', { requestId: 'unknown', ...unknown });
  assert.equal(choice.status, 'choice_required');
  assert.equal(choice.options[0].available, false);
  assert.match(choice.reason, /尚未信任/);
  const receiverKey = receiver.exportPublicKey;
  await targetClient.close(); targetClient = null;
  await receiver.close(); receiver = null;

  receiver = await startLocalMcp({ ...receiverConfig, trustedExportKeys: [sender.exportPublicKey] }, options);
  assert.equal(receiver.exportPublicKey, receiverKey);
  targetClient = await connect(receiver);
  const cookie = await browserIdentity(receiver);
  assert.notEqual(cookie.split('=')[0], senderCookie.split('=')[0]);
  for (const name of Object.keys(files)) {
    const changed = { ...files, [name]: name === 'workflow.html' ? files[name].replace('<title>', '<title>Changed ') : files[name] + '\nchanged' };
    const ref = await upload(changed, cookie);
    assert.equal((await call(targetClient, 'flowkit_add_workflow', { requestId: 'changed-' + name, ...ref })).status, 'conflict');
  }
  const trusted = await upload(files, cookie);
  const add = { requestId: 'trusted', ...trusted };
  const pending = await call(targetClient, 'flowkit_add_workflow', add);
  assert.ok(pending.confirmationUrl, JSON.stringify(pending));
  const sourceView=readWorkflowPageData(files['workflow.html']);
  const receiverView=readWorkflowPageData(await (await fetch(pending.confirmationUrl,{headers:{cookie}})).text());
  assert.notEqual(receiverView.candidateHash,sourceView.candidateHash);
  assert.deepEqual(receiverView.graph,sourceView.graph);
  assert.equal(receiverView.mermaid,sourceView.mermaid);
  assert.equal((await call(targetClient, 'flowkit_collection')).skills.length, 0);
  const accepted = await (await confirmInTestBrowser(pending.confirmationUrl, cookie)).json();
  assert.equal(accepted.status, 'added');
  assert.equal(accepted.collectionId, receiver.collectionId);
  assert.notEqual(accepted.candidateHash, ready.candidate.candidateHash);
  assert.deepEqual(await call(targetClient, 'flowkit_add_workflow', add), accepted);
  const repeated = await upload(files, cookie);
  assert.equal((await call(targetClient, 'flowkit_add_workflow', { requestId: 'again', ...repeated })).status, 'already_added');
});

test('local MCP rechecks revoked imports and saves a reviewed same-origin update without reactivating history', async t => {
  let service, client, cookie;
  const stop = async () => {
    await client?.close(); client = null;
    if (service) assert.equal((await service.close()).closed, true);
    service = null;
  };
  t.after(stop);
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'data'), exportDir: path.join(root, 'exports') };
  const credential = 'fixture-test-credential-for-flowkit-mcp';
  const signer = newExportKey(), otherSigner = newExportKey();
  const hostProfile = { id: 'flowkit-local-authoring', digest: artifactDigest('flowkit-local-authoring-v1') };
  const original = await readFile(new URL('../../examples/docs/conditional-routing/sample.workflow.js', import.meta.url), 'utf8');
  const createFiles = async (version, identifier, key = signer) => {
    const file = path.join(root, identifier + '.workflow.js');
    await writeFile(file, original.replace("version: '1.0.0'", "version: '" + version + "'"));
    const { candidate, diagnostics } = await prepareStandardSkill({ file, collectionId: 'upstream', skillId: 'transferred',
      name: 'transferred', description: 'Transfer routing', version, hostProfile, buildId: identifier,
      compilerOptions: { skillCheck: false } });
    assert.ok(candidate, JSON.stringify(diagnostics));
    return publicDelivery(candidate, key);
  };
  const v1 = await createFiles('1.0.0', 'initial');
  const v2 = await createFiles('1.1.0', 'revision');
  const start = async trustedExportKeys => {
    service = await startLocalMcp({ ...config, trustedExportKeys }, { credential, modelBinding: monthlyTimesheetModel() });
    client = new Client({ name: 'flowkit-import-lifecycle', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url),
      { requestInit: { headers: { authorization: 'Bearer ' + credential } } }));
    cookie = await browserIdentity(service);
  };
  const tool = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  const register = async files => {
    const origin = new URL(service.url).origin;
    const response = await fetch(origin + '/sources', { method: 'POST', headers: { origin, cookie },
      body: new URLSearchParams({ source: JSON.stringify(files) }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const add = async (requestId, files) => {
    const args = { requestId, ...await register(files) };
    return { args, result: await tool('flowkit_add_workflow', args) };
  };
  const confirmation = async result => {
    assert.ok(result.confirmationUrl, JSON.stringify(result));
    const url = new URL(result.confirmationUrl);
    const html = await (await fetch(url, { headers: { cookie } })).text();
    const challenge = html.match(/name="challenge" value="([^"]+)"/)?.[1];
    assert.ok(challenge);
    return { url, html, challenge };
  };
  const submitChallenge = ({ url, challenge }) => {
    const origin = new URL(service.url).origin;
    return fetch(origin + url.pathname + '/confirm',
      { method: 'POST', headers: { origin, cookie }, body: new URLSearchParams({ challenge }) });
  };

  await start([signer.publicKey]);
  const unused = await register(v1);
  const pending = await add('before-revoke', v1);
  const oldLink = await confirmation(pending.result);
  const { value: { draftId, candidateHash } } = JSON.parse(Buffer.from(oldLink.url.pathname.split('/').at(-1).split('.')[0], 'base64url'));
  await stop();
  await start([]);
  assert.equal((await tool('flowkit_add_workflow', { requestId: 'unused-after-revoke', ...unused })).status, 'rejected');
  assert.equal((await tool('flowkit_add_workflow', pending.args)).status, 'rejected');
  assert.equal((await tool('flowkit_add_workflow', { requestId: 'draft-after-revoke', sourceRef: draftId, candidateHash })).status, 'rejected');
  assert.equal((await submitChallenge(oldLink)).status, 403);
  assert.equal((await tool('flowkit_collection')).skills.length, 0);
  await stop();

  await start([signer.publicKey, otherSigner.publicKey]);
  const first = await add('install-initial', v1);
  const firstSaved = await (await confirmInTestBrowser(first.result.confirmationUrl, cookie)).json();
  assert.equal(firstSaved.status, 'added');
  const next = await add('install-revision', v2);
  const update = await confirmation(next.result);
  assert.match(update.html, /当前版本 1\.0\.0，更新到 1\.1\.0/);
  assert.equal((await tool('flowkit_collection')).skills[0].candidateHash, firstSaved.candidateHash);
  const nextSaved = await (await submitChallenge(update)).json();
  assert.equal(nextSaved.status, 'added');
  assert.equal(nextSaved.version, '1.1.0');
  assert.equal(nextSaved.workflowId, firstSaved.workflowId);
  assert.equal((await add('historical-files', v1)).result.status, 'already_added');
  assert.deepEqual(await tool('flowkit_add_workflow', first.args), firstSaved);
  assert.equal((await tool('flowkit_collection')).skills[0].candidateHash, nextSaved.candidateHash);
  assert.equal((await add('same-version-other-content', await createFiles('1.1.0', 'replacement'))).result.status, 'conflict');
  assert.equal((await add('older-version', await createFiles('1.0.1', 'downgrade'))).result.status, 'conflict');
  assert.match((await add('wrong-signer', await createFiles('1.2.0', 'wrong-signer', otherSigner))).result.reason, /同一签名来源/);

  const stale = await confirmation((await add('earlier-revision', await createFiles('1.2.0', 'earlier'))).result);
  const later = await add('later-revision', await createFiles('1.3.0', 'later'));
  const latest = await (await confirmInTestBrowser(later.result.confirmationUrl, cookie)).json();
  assert.equal(latest.version, '1.3.0');
  assert.equal((await submitChallenge(stale)).status, 409);
  await stop();
  await start([]);
  assert.deepEqual(await tool('flowkit_add_workflow', later.args), latest);
  const { skills } = await tool('flowkit_collection');
  assert.deepEqual(skills.map(({ skillId, version }) => [skillId, version]), [[firstSaved.workflowId, '1.3.0']]);
});

async function verifyLocalRecovery(t, interruptedEffect) {
  let client, recoveredService, worker, closed;
  t.after(async () => {
    if (worker?.exitCode === null && worker.signalCode === null) worker.kill();
    await closed;
    await client?.close();
    await recoveredService?.close();
  });
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'data'), exportDir: path.join(root, 'exports') };
  const credential = 'fixture-test-credential-for-flowkit-mcp';
  worker = spawn(process.execPath, ['--input-type=module', '-e', [
    'const [serverUrl, fixtureUrl, rawConfig, credential, effect] = process.argv.slice(1);',
    'const { startLocalMcp } = await import(serverUrl);',
    'const { monthlyTimesheetModel } = await import(fixtureUrl);',
    'const modelBinding = monthlyTimesheetModel();',
    'const stopAfterReservation = () => { console.log("reserved"); return new Promise(() => {}); };',
    'if (effect === "read") modelBinding.execution.request = stopAfterReservation;',
    'else {',
    '  modelBinding.execution.tool = stopAfterReservation;',
    '  const createSession = modelBinding.execution.createSession;',
    '  modelBinding.execution.createSession = async ports => {',
    '    const session = await createSession(ports);',
    '    session.intentRuntime.parse = () => ports.tool({example: true},',
    '      {sideEffect: "write", toolName: "fixture-writer", operationKey: "interrupted"});',
    '    return session;',
    '  };',
    '}',
    'const service = await startLocalMcp(JSON.parse(rawConfig), { credential, modelBinding });',
    'console.log(service.url);'
  ].join('\n'), new URL('../../scripts/run-local-mcp.mjs', import.meta.url).href, new URL('./local-mcp-fixture.mjs', import.meta.url).href,
    JSON.stringify(config), credential, interruptedEffect], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = once(worker, 'close');
  const ready = Promise.withResolvers();
  const reserved = Promise.withResolvers();
  worker.stderr.resume();
  worker.on('error', ready.reject);
  closed.then(([code]) => { ready.reject(new Error('Author worker exited with ' + code)); reserved.resolve(false); });
  createInterface({ input: worker.stdout }).on('line', line => {
    if (line === 'reserved') reserved.resolve(true);
    else if (line.startsWith('http://127.0.0.1:')) ready.resolve(line);
  });
  const connect = async url => {
    client = new Client({ name: 'flowkit-recovery-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: 'Bearer ' + credential } } }));
  };
  const tool = async (name, args, success = true) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError === true, !success, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const options = { credential, modelBinding: monthlyTimesheetModel() };
  await connect(await ready.promise);
  await assert.rejects(startLocalMcp(config, options), /无法获取写锁/);
  const goal = '核对工时后验证副本。';
  const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'start', goal });
  const interrupted = client.callTool({ name: 'flowkit_prepare_workflow', arguments: { turn: {
    draftId: draft.id, turnId: 'interrupted', input: goal, expectedStateVersion: draft.stateVersion
  } } }).catch(() => {});
  assert.equal(await reserved.promise, true);
  worker.kill();
  await closed;
  await interrupted;
  await client.close(); client = null;
  recoveredService = await startLocalMcp(config, options);
  await connect(recoveredService.url);
  const list = (await client.listTools()).tools.map(item => item.name);
  assert.ok(list.includes('flowkit_recover_workflow'));
  assert.ok(!list.includes('flowkit_run_workflow') && !list.includes('flowkit_apply_collection_plan'));
  const before = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
  assert.equal(before.status, 'reconciliation-required');
  assert.equal(before.recovery.turnId, 'interrupted');
  const input = { draftId: draft.id, expectedStateVersion: before.stateVersion };
  if (interruptedEffect === 'write') {
    const rejected = await tool('flowkit_recover_workflow', input, false);
    assert.match(rejected.error.message, /Trusted Host settlement evidence/);
    const unchanged = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
    assert.equal(unchanged.status, 'reconciliation-required');
    assert.equal(unchanged.stateVersion, before.stateVersion);
    return;
  }
  await tool('flowkit_recover_workflow', { ...input, expectedStateVersion: before.stateVersion - 1 }, false);
  const settled = await tool('flowkit_recover_workflow', input);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.recovery, undefined);
  assert.equal((await tool('flowkit_recover_workflow', input)).stateVersion, settled.stateVersion);
  const result = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'after-recovery',
    input: goal, expectedStateVersion: settled.stateVersion } });
  assert.equal(result.id, draft.id);
  assert.equal(result.status, 'candidate-ready');
}

for (const interruptedEffect of ['read', 'write']) {
  test('local MCP recovers a stopped process only with verifiable effects: ' + interruptedEffect, { timeout: 30000 },
    t => verifyLocalRecovery(t, interruptedEffect));
}
