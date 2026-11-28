import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildCodexMarketplace } from '../../scripts/build-codex-plugin.mjs';
import { exportTrust, newExportKey, publicDelivery, readPortableExport } from '../../scripts/local-mcp-artifacts.mjs';
import { createLocalCodexSkills } from '../../scripts/local-codex-skills.mjs';
import { runModelInSlot, startLocalMcp } from '../../scripts/run-local-mcp.mjs';
import { localModel } from '../../scripts/local-mcp-model.mjs';
import { defaultLayout, readWorkflowPageData } from '../../scripts/workflow-viewer.mjs';
import { generateLayout } from '../../scripts/workflow-viewer/auto-layout.mjs';
import { runArtifact } from '../../src/runtime/run.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { prepareStandardSkill } from '../../src/author/standard-artifact.mjs';
import { bindProfessionalNeeds } from '../../src/author/workflow-professional-bindings.mjs';
import { prepareProfessionalSkill } from '../../src/author/professional-skills.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { flowkitProvider } from '../../src/integrations/capability-graph.mjs';
import { openOfflineWorkflowDependencies, runApprovedCollectionWorkflow, sealOfflineWorkflowDependencies } from '../../src/host.mjs';
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

test('local service rejects unknown and invalid configuration before creating data', async t => {
  const root = await ownedDirectory(t);
  const dataDir = path.join(root, 'never-created');
  const credential = 'test-config-validation-credential';
  const modelBinding = monthlyTimesheetModel();
  const base = { dataDir, exportDir: path.join(root, 'exports'), listen: { port: 0 } };
  for (const [invalid, expected] of [
    [{ authorTurnDuratonMs: 50 }, /Unknown local config field: authorTurnDuratonMs/],
    [{ listen: { porrt: 0 } }, /Unknown listen field: porrt/],
    [{ listen: null }, /listen must be an object/],
    [{ listen: { port: null } }, /Invalid listen field: port/],
    [{ namespace: null }, /namespace/],
    [{ authorTaskTimeoutMs: null }, /authorTaskTimeoutMs/],
    [{ authorTurnDurationMs: 2147483648 }, /authorTurnDurationMs/],
    [{ designTurnDurationMs: 1.5 }, /designTurnDurationMs/],
    [{ resourceReadTimeoutMs: 0 }, /resourceReadTimeoutMs/],
    [{ capabilityGraph: 'false' }, /capabilityGraph/],
    [{ authorProvider: 'invalid' }, /provider/],
    [{ trustedExportKeys: null }, /trustedExportKeys/],
    [{ codexSkillsWorkspace: 'relative' }, /absolute directory/],
    [{ defaultCollection: 'Invalid' }, /portable Skill name/],
    [{ workspaceId: '' }, /workspaceId/]
  ]) {
    await assert.rejects(startLocalMcp({ ...base, ...invalid }, { credential, modelBinding }), expected);
    await assert.rejects(lstat(dataDir), { code: 'ENOENT' });
  }
  for (const invalid of [null, [], 'invalid']) {
    await assert.rejects(startLocalMcp(invalid, { credential, modelBinding }), /local config must be an object/);
  }
  const service = await startLocalMcp({ ...base, capabilityGraph: false }, { credential, modelBinding });
  assert.equal((await service.close()).closed, true);
});

test('local Author default and all-turn override budgets are persisted by the actual MCP entry', async t => {
  const root = await ownedDirectory(t);
  const credential = 'test-effective-local-budget-credential';
  for (const [index, durationMs, expected] of [[0, undefined, [240000, 900000]], [1, 120000, [120000, 120000]]]) {
    const dataDir = path.join(root, 'state-' + index);
    const modelBinding = monthlyTimesheetModel();
    modelBinding.execution.request = async () => { throw new Error('Controlled stop after admission'); };
    const service = await startLocalMcp({ listen: { port: 0 }, dataDir, exportDir: path.join(root, 'exports-' + index),
      ...(durationMs === undefined ? {} : { authorTurnDurationMs: durationMs }) }, { credential, modelBinding });
    const client = new Client({ name: 'local-budget-test', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { authorization: 'Bearer ' + credential } }
      }));
      for (const [turnId, sources] of [['ordinary', undefined], ['material', ['first', 'second'].map(id =>
        ({ kind: 'text', id, title: id, content: 'x'.repeat(11500) }))]]) {
        const started = await client.callTool({ name: 'flowkit_start_workflow', arguments: {
          requestId: turnId, goal: 'Inspect', operation: 'create', executionMode: 'standard'
        } });
        assert.ok(!started.isError, JSON.stringify(started));
        const draft = JSON.parse(started.content[0].text);
        const admitted = await client.callTool({ name: 'flowkit_prepare_workflow', arguments: { turn: {
          draftId: draft.id, turnId, expectedStateVersion: draft.stateVersion, input: 'Inspect'
        }, ...(sources ? { sources } : {}) } });
        assert.ok(!admitted.isError, JSON.stringify(admitted));
      }
      const db = new DatabaseSync(path.join(dataDir, 'author.sqlite'));
      try {
        const limits = id => JSON.parse(db.prepare('SELECT payload FROM fk_author_turns WHERE turn_id=?').get(id).payload).budget.limits;
        const ordinary = limits('ordinary'), material = limits('material');
        assert.deepEqual([ordinary.durationMs, material.durationMs], expected);
        assert.deepEqual([ordinary.maxRequests, material.maxRequests], [8, 168]);
        assert.equal(material.maxBytes, 48 * 1024 * 1024);
      } finally { db.close(); }
    } finally { await client.close(); await service.close(); }
  }
});

test('local model queue cancellation does not release an outstanding physical slot', { timeout: 10000 }, async () => {
  const active = new Set();
  const runningController = new AbortController();
  const waitingController = new AbortController();
  const reason = new Error('cancel queued request');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const run = (operation, signal) => runModelInSlot(operation, signal, active, 1);
  let waiting, observed, next, timer;
  let queuedDispatches = 0, nextDispatches = 0;
  const running = run(() => { entered(); return gate; }, runningController.signal);
  try {
    await started;
    assert.equal(active.size, 1);
    waiting = run(() => { queuedDispatches++; return 'unexpected'; }, waitingController.signal);
    observed = assert.rejects(waiting, error => error === reason);
    await new Promise(setImmediate);
    waitingController.abort(reason);
    const cancelled = await Promise.race([observed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    assert.equal(cancelled, true, 'Queued cancellation must settle before the active transport releases its slot');
    runningController.abort(new Error('non-cooperative transport remains outstanding'));
    assert.equal(active.size, 1);
    next = run(() => { nextDispatches++; return 'next'; }, new AbortController().signal);
    await new Promise(setImmediate);
    assert.equal(queuedDispatches, 0);
    assert.equal(nextDispatches, 0);
    release('first');
    assert.equal(await running, 'first');
    await observed;
    assert.equal(await next, 'next');
    assert.equal(nextDispatches, 1);
    assert.equal(active.size, 0);
    await assert.rejects(run(() => assert.fail('Must not dispatch an already cancelled request'),
      AbortSignal.abort(reason)), error => error === reason);
    const beforeDispatch = new AbortController();
    const reserved = run(() => assert.fail('Cancelled before transport dispatch'), beforeDispatch.signal);
    assert.equal(active.size, 1);
    beforeDispatch.abort(reason);
    await assert.rejects(reserved, error => error === reason);
    assert.equal(active.size, 0);
  } finally {
    clearTimeout(timer);
    release('first');
    await Promise.allSettled([running, waiting, observed, next]);
  }
});

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

test('a portable signature covers fixed public FlowKit design evidence and excludes other documentation', async () => {
  const capability = flowkitProvider.capabilities.find(item => item.id === 'define-workflow');
  const document = capability.documents.find(item => item.id === 'flowkit-doc-authoring');
  const evidence = { capabilityId: 'flowkit::define-workflow', documentId: document.id,
    revision: artifactDigest('fixed-provider-revision'), contentHash: artifactDigest('authorized guide bytes'), source: document.source };
  const key = newExportKey();
  const trust = exportTrust([key.publicKey]);
  const prepare = async source => {
    const { candidate, diagnostics } = await prepareStandardSkill({ file: path.resolve('examples/docs/conditional-routing/sample.workflow.js'),
      collectionId: 'doc-evidence', skillId: 'portable', name: 'portable', description: 'Verify design evidence', version: '1.0.0',
      hostProfile: { id: 'fixed', digest: artifactDigest('fixed host') }, buildId: 'portable-references', safetyPolicies: [],
      documents: [{ ...evidence, source }], compilerOptions: { skillCheck: false } });
    assert.ok(candidate, JSON.stringify(diagnostics));
    return candidate;
  };
  const candidate = await prepare(evidence.source);
  const signed = publicDelivery(candidate, key);
  const imported = readPortableExport(signed, trust).candidate;
  assert.equal(imported.hash, candidate.hash);
  assert.deepEqual(imported.manifest.documents, [evidence]);
  for (const source of [{ type: 'file', path: 'private.md' }, { type: 'url', url: 'https://private.example/guide.mdx' },
    { type: 'url', url: evidence.source.url + '?credential=fixture' }]) {
    assert.deepEqual(readPortableExport(publicDelivery(await prepare(source), key), trust), {});
  }
});

test('the default local Author uses the formal Intent SDK for validation and stable baselines', async () => {
  const source = { root: 'input', pointer: '' };
  const messages = Object.fromEntries(['changed', 'notApplicable', 'noValue', 'noDeclaration', 'explicitNull', 'invalid',
    'open', 'mixed', 'semanticUnknown', 'unresolved', 'relationConflict'].map(key => [key, 'Interpret the supplied evidence.']));
  const base = {
    version: 'candidate-2', kind: 'request', normalizedInput: 'Inspect one record.', relatedKeys: ['inspect'],
    historyCoverage: 'complete', usedHistory: false, messages,
    nodes: [{ key: 'inspect', parentKey: null, priorRef: null, domain: 'records', action: 'inspect', target: 'record',
      goal: 'Inspect one record', understanding: 'clear', optional: null, expectedOutput: [], sources: [source] }],
    constraints: [], references: [], relations: [], priorTargets: [],
    changes: [{ operation: 'add', effect: 'applied', targetKind: 'intent', targetKey: 'inspect', conditionKey: null,
      description: 'Inspect one record', sources: [source], deltaHints: [] }],
    observations: [], issues: [], inferences: [], evidence: [], suggestions: []
  };
  let result = base, status = 'completed', requests = 0;
  const model = localModel({ provider: 'openai', model: 'fixture', apiKey: 'fixture',
    async fetcher(_url, options) {
      requests++;
      const request = JSON.parse(options.body);
      const [instructions, material] = request.input;
      assert.equal(request.max_output_tokens, 8192);
      assert.equal(instructions.role, 'developer');
      assert.match(instructions.content, /candidate-2/);
      assert.match(instructions.content, /A Human decision required before a business action is a workflow constraint/);
      assert.equal(material.role, 'user');
      assert.ok(JSON.parse(material.content));
      return Response.json({ status, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    } });
  const { intentRuntime } = await model.execution.createSession({ request: model.execution.request });
  assert.equal(intentRuntime.usesOfficialIntent, true);
  const input = { input: 'Inspect one record.', output: { evidence: true } };
  const first = await intentRuntime.parse(input);
  assert.equal(first.effective.intents.length, 1);
  const userId = first.effective.intents[0].id;
  result = structuredClone(base);
  result.kind = 'amendment';
  result.usedHistory = true;
  result.nodes[0].priorRef = { root: 'baseline', pointer: '/intents/0' };
  result.changes[0].operation = 'modify';
  assert.equal((await intentRuntime.parse({ ...input, baseline: first.effective })).effective.intents[0].id, userId);
  const beforeInvalidBaseline = requests;
  await assert.rejects(intentRuntime.parse({ ...input, baseline: { intents: [], coverage: 'complete' } }),
    { code: 'INPUT_INVALID', details: { path: '/baseline' } });
  assert.equal(requests, beforeInvalidBaseline);

  const issue = optionKeys => ({ key: 'decision', ownerKey: null, fieldTarget: null, code: 'CHOOSE_RECORD', category: 'ambiguity',
    message: 'Choose a record.', sources: [source], candidates: [
      { key: 'first', description: 'First record', intentKey: null, sources: [source] },
      { key: 'second', description: 'Second record', intentKey: null, sources: [source] }],
    questions: [{ question: 'Which record?', optionKeys }] });
  for (const corrupt of [
    value => { value.changes[0].targetKey = null; },
    value => { Object.assign(value.changes[0], { operation: 'confirm', targetKey: 'unknown' }); },
    value => { value.nodes[0].sources[0].root = 'unknown'; },
    value => { value.issues = [issue(['first', 'second'])]; value.issues[0].questions[0].question = 5; },
    value => { value.issues = [issue(['first', 'nonexistent'])]; },
    value => { value.changes[0].sources = []; },
    value => { delete value.version; }
  ]) {
    result = structuredClone(base);
    corrupt(result);
    await assert.rejects(intentRuntime.parse(input), { code: 'MODEL_OUTPUT_INVALID' });
  }
  status = 'incomplete';
  await assert.rejects(intentRuntime.parse(input), { code: 'MODEL_OUTPUT_INCOMPLETE' });
});

test('the local model deadline covers the formal Intent response body', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    let signal;
    const model = localModel({ provider: 'openai', model: 'fixture', apiKey: 'fixture', timeoutMs: 15,
      async fetcher(_url, options) {
        signal = options.signal;
        return new Response(new ReadableStream({ start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        } }));
      } });
    const { intentRuntime } = await model.execution.createSession({ request: model.execution.request });
    await assert.rejects(intentRuntime.parse({ input: 'Inspect' }), { code: 'FKA_AUTHOR_MODEL_TIMEOUT' });
    assert.equal(signal.aborted, true);
    await assert.rejects(intentRuntime.parse({ input: 'Inspect' }, { signal: AbortSignal.abort() }), { code: 'REQUEST_ABORTED' });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('direct local model response-body timeouts are attributed to the model, including through Graph', async () => {
  const { createLocalCapabilityGraph } = await import('../../scripts/local-capability-graph.mjs');
  const graph = await createLocalCapabilityGraph(1000);
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const model = localModel({ provider: 'openai', model: 'fixture', apiKey: 'fixture', timeoutMs: 15,
      async fetcher(_url, { signal }) {
        return new Response(new ReadableStream({ start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        } }));
      } });
    await Promise.all([
      assert.rejects(graph.match('Draft a workflow', { request: model.execution.request }), { code: 'CG_MODEL_TIMEOUT' }),
      assert.rejects(model.execution.request({ flowkitProfessionalSkillReview: { need: { id: 'fixture' }, text: 'body' } }),
        { code: 'FKA_AUTHOR_MODEL_TIMEOUT' }),
      assert.rejects(model.planLayout({ guide: 'fixture', input: {} }), { code: 'FKA_AUTHOR_MODEL_TIMEOUT' }),
      assert.rejects(model.planDesign({ title: 'fixture', materials: [], section: {} }), { code: 'FKA_DESIGN_MODEL_TIMEOUT' })
    ]);
  } finally {
    clearTimeout(keepAlive);
    await graph.registry.close();
  }
});

test('Graph phase deadline and parent cancellation do not release a real model slot early', { timeout: 10000 }, async t => {
  const { createLocalCapabilityGraph } = await import('../../scripts/local-capability-graph.mjs');
  const graph = await createLocalCapabilityGraph(1000);
  const nativeTimer = globalThis.setTimeout;
  let expire;
  // The actual Graph 2.1.1 SDK creates its own 60-second matching timer.
  // Capture that callback and expire it after dispatch rather than sleep a minute.
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms > 59000 && ms <= 60000) expire = () => callback(...args);
    return nativeTimer(callback, ms, ...args);
  });
  try {
    for (const first of ['graph', 'parent']) {
      expire = undefined;
      const active = new Set(), parent = new AbortController(), waiting = new AbortController();
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      let physical, queued, dispatched = 0;
      const run = (operation, signal) => runModelInSlot(operation, signal, active, 1);
      const matched = graph.match('Draft a workflow', { signal: parent.signal, request: (_body, { signal }) => {
        physical = run(async () => {
          entered.resolve(signal);
          await release.promise;
          return { decision: 'none', ids: [] };
        }, signal);
        return physical;
      } });
      const result = assert.rejects(matched, { code: first === 'graph' ? 'CG_MODEL_TIMEOUT' : 'CG_MODEL_CANCELLED' });
      try {
        const signal = await entered.promise;
        assert.equal(active.size, 1);
        assert.equal(typeof expire, 'function', 'Actual Graph SDK deadline must be observed');
        if (first === 'graph') {
          expire();
          parent.abort(new Error('Later parent cancellation'));
        } else {
          parent.abort(new Error('Parent cancelled first'));
          expire();
        }
        await result;
        assert.equal(signal.aborted, true);
        assert.equal(signal.reason.code, first === 'graph' ? 'CG_MODEL_TIMEOUT' : 'CG_MODEL_CANCELLED');
        assert.equal(active.size, 1, 'Graph logical exit is not physical completion');
        queued = run(() => { dispatched++; return 'layout'; }, waiting.signal);
        const stopped = assert.rejects(queued, { name: 'AbortError' });
        waiting.abort();
        await stopped;
        assert.equal(dispatched, 0);
        assert.equal(active.size, 1);
        release.resolve();
        await physical;
        assert.equal(await run(() => { dispatched++; return 'layout'; }, new AbortController().signal), 'layout');
        assert.equal(dispatched, 1);
        assert.equal(active.size, 0);
      } finally {
        waiting.abort(); parent.abort(); release.resolve();
        await Promise.allSettled([matched, result, physical, queued]);
      }
    }
  } finally { await graph.registry.close(); }
});

test('local Graph search is opt-in per draft and an explicit search fails closed', async t => {
  let service, client;
  t.after(async () => { await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const token = 'fixture-graph-discovery-credential';
  const model = monthlyTimesheetModel();
  const execute = model.execution.request;
  let searches = 0, reads = 0, available = false, hasMatch = true;
  model.execution.request = async input => {
    if (!input.flowkitCapabilityMatch) return execute(input);
    searches++;
    if (!available) throw new Error('Graph selector is unavailable');
    return hasMatch ? { decision: 'selected', ids: ['flowkit::define-workflow'] } :
      { decision: 'none', ids: [], reason: 'No authorized capability matches' };
  };
  service = await startLocalMcp({
    listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports'), capabilityGraph: true
  }, { credential: token, modelBinding: model,
    async readDocumentUrl(url) { reads++; return { url, bytes: Buffer.from('# Control guide') }; }
  });
  client = new Client({ name: 'graph-discovery-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  }
  async function draft(name, input, useCapabilityGraph) {
    const opened = await tool('flowkit_start_workflow', { requestId: name, operation: 'create', goal: input });
    return tool('flowkit_prepare_workflow', { turn: { draftId: opened.id, turnId: name, input,
      expectedStateVersion: opened.stateVersion, target: { name }, useCapabilityGraph } });
  }
  const input = 'Review the timesheet and verify the copy.';
  const ordinary = await draft('ordinary-graph-enabled', input);
  assert.equal(ordinary.status, 'candidate-ready', JSON.stringify(ordinary.diagnostics));
  assert.deepEqual([searches, reads], [0, 0]);
  const unavailable = await draft('required-graph-unavailable', input, true);
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.diagnostics[0].code, 'CG_MODEL_UNAVAILABLE');
  assert.deepEqual([searches, reads], [1, 0]);
  available = true;
  const selected = await draft('required-graph-available', input, true);
  assert.equal(selected.status, 'candidate-ready', JSON.stringify(selected.diagnostics));
  assert.equal(searches, 2);
  assert.ok(reads > 0);
  const db = new DatabaseSync(path.join(root, 'state', 'author.sqlite'), { readOnly: true });
  try {
    const stored = JSON.parse(db.prepare('SELECT payload FROM fk_author_drafts WHERE draft_id=?').get(selected.id).payload);
    assert.deepEqual(stored.plan.capabilityRequirements, ['flowkit::define-workflow']);
    assert.equal(stored.resources.capabilities.nodes[0].capability.id, 'flowkit::define-workflow');
    assert.equal(stored.resources.documents[0].text, '# Control guide');
  } finally { db.close(); }
  const beforeNamedGuide = reads;
  const named = await draft('named-guide', input + ' Consult the workflow-authoring guide.');
  assert.equal(named.status, 'candidate-ready', JSON.stringify(named.diagnostics));
  assert.deepEqual([searches, reads], [2, beforeNamedGuide]);
  const beforeOptOut = reads;
  const optedOut = await draft('skip-guide', input + ' Do not consult workflow-authoring.', false);
  assert.equal(optedOut.status, 'candidate-ready', JSON.stringify(optedOut.diagnostics));
  assert.deepEqual([searches, reads], [2, beforeOptOut]);

  const continued = await tool('flowkit_prepare_workflow', { turn: { draftId: selected.id, turnId: 'continue-graph',
    expectedStateVersion: selected.stateVersion, input } });
  assert.equal(continued.status, 'candidate-ready', JSON.stringify(continued.diagnostics));
  assert.equal(searches, 3);
  assert.ok(reads > beforeOptOut);
  const beforeWithdrawal = reads;
  const withdrawn = await tool('flowkit_prepare_workflow', { turn: { draftId: continued.id, turnId: 'withdraw-graph',
    expectedStateVersion: continued.stateVersion, input, useCapabilityGraph: false } });
  assert.equal(withdrawn.status, 'candidate-ready', JSON.stringify(withdrawn.diagnostics));
  assert.deepEqual([searches, reads], [3, beforeWithdrawal]);

  hasMatch = false;
  const missing = await draft('required-graph-no-match', input, true);
  assert.equal(missing.status, 'needs-clarification', JSON.stringify(missing.diagnostics));
  assert.equal(missing.diagnostics[0].code, 'FKA_GRAPH_DISCOVERY_REQUIRED');
  assert.ok(missing.questions.some(({ id }) => id === 'capability-graph'));
  assert.deepEqual([searches, reads], [4, beforeWithdrawal]);
  assert.equal(missing.candidate, undefined);

  hasMatch = true;
  const recovered = await tool('flowkit_prepare_workflow', { turn: { draftId: unavailable.id, turnId: 'resume-after-unavailable',
    expectedStateVersion: unavailable.stateVersion, input } });
  assert.equal(recovered.status, 'candidate-ready', JSON.stringify(recovered.diagnostics));
  assert.equal(searches, 5);
  assert.ok(reads > beforeWithdrawal);

  await client.close(); await service.close();
  service = await startLocalMcp({ listen: { port: 0 }, dataDir: path.join(root, 'empty-state'),
    exportDir: path.join(root, 'empty-exports') },
  { credential: token, modelBinding: model, capabilityGraph: {}, discoverCapabilities: async () => undefined });
  client = new Client({ name: 'empty-graph-discovery-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
  const empty = await draft('required-graph-without-result', input, true);
  assert.equal(empty.status, 'needs-clarification', JSON.stringify(empty.diagnostics));
  assert.ok(empty.questions.some(({ id }) => id === 'capability-graph'));
});

test('native Skill search checks same-purpose alternatives and refuses to draft from an incomplete search', async t => {
  const root = await ownedDirectory(t);
  const collection = { id: 'team', name: 'team-workflows', directory: 'team-workflows' };
  const entries = [];
  const receipts = new Map();
  let errors = [];
  async function addSkill(name, description, body) {
    const folder = path.join(root, '.agents', 'skills', name);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'SKILL.md');
    await writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, 'utf8');
    entries.push({ name, description, path: file, scope: 'repo' });
  }
  const description = 'Validate artifact digests before publication.';
  const body = 'Compare the artifact digest with the approved digest before release.';
  await addSkill('release-guard', description, body);
  const native = await createLocalCodexSkills({ workspace: root, root: path.join(root, 'generated'),
    collection, get: key => receipts.get(key), put: (key, value) => receipts.set(key, value),
    readCatalog: async () => ({ skills: entries, errors }) });
  const calls = [];
  async function verifyApplicability(_need, candidate) {
    calls.push(candidate.manifest.skillId);
    return candidate.files['SKILL.md'].includes(body);
  }
  const need = { id: 'release-preflight', description: 'Verify the workflow digest against its approval before release.' };
  const proposal = { nodes: [{ id: 'review', kind: 'agent', options: {}, professionalNeeds: [need] }] };
  let draftCount = 0;
  const scope = { catalog: native, collection, read: (_input, run) => run(), drafts: new Map(),
    selectionFor: () => undefined, verifyApplicability, draftSkill: () => { draftCount++; return 'Drafted duplicate'; } };
  const result = await bindProfessionalNeeds(proposal, scope);
  assert.equal(result.resourceRequirements[0].id, 'release-guard');
  assert.equal(result.resourceRequirements[0].lookup.resolution, 'reuse-approved');
  assert.deepEqual(calls, ['release-guard']);
  assert.equal(draftCount, 0);
  for (let i = 0; i < 100; i++) await addSkill('unrelated-' + i, 'Unrelated procedure ' + i, 'Alternate body.');
  const reused = await bindProfessionalNeeds(proposal, { ...scope,
    selectCandidates: (_need, catalog) => [catalog.find(x => x.id === 'release-guard').key] });
  assert.equal(reused.resourceRequirements[0].id, 'release-guard');
  assert.deepEqual(calls, ['release-guard', 'release-guard']);
  for (const selectCandidates of [undefined, () => [], (_need, catalog) => [catalog.find(x => x.id === 'unrelated-0').key]]) {
    const incomplete = await bindProfessionalNeeds(proposal, { ...scope, selectCandidates });
    assert.equal(incomplete.unresolvedIssues[0].blocking, true);
    assert.equal(incomplete.resourceRequirements.length, 0);
  }
  errors = [{ message: 'One authorized catalog root is unavailable' }];
  assert.equal((await bindProfessionalNeeds(proposal, { ...scope, selectCandidates: () => [] })).unresolvedIssues[0].blocking, true);
  assert.equal(draftCount, 0);
  errors = [];
  const exact = await native.search({ id: 'release-guard', description, verifyApplicability });
  assert.equal(exact.complete, true);
  assert.equal(exact.matches[0].candidate.manifest.skillId, 'release-guard');
  const pin = { id: 'release-guard', source: exact.matches[0].source, ...exact.matches[0].candidate.manifest };
  // An unavailable unrelated catalog row cannot deny anchor-verified resolution.
  errors = [{ message: 'Unreadable unrelated root' }];
  assert.equal((await native.resolveExact(pin)).status, 'resolved');
  errors = [];
  const [entry] = entries;
  entry.enabled = false;
  assert.equal((await native.resolveExact(pin)).status, 'denied');
  entry.enabled = true;
  entries.shift();
  assert.equal((await native.resolveExact(pin)).status, 'denied');
  entries.unshift(entry);
  assert.equal((await native.resolveExact(pin)).status, 'resolved');
  const directory = path.dirname(entry.path);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'rule.md'), 'Not part of the Skill');
  await symlink(outside, path.join(directory, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await native.resolveExact(pin)).status, 'denied');
  await rename(directory, path.join(root, 'withdrawn-skill'));
  entries.shift();
  assert.equal((await native.resolveExact(pin)).status, 'unavailable');
  entries.splice(1);
  const emptyMatch = await bindProfessionalNeeds(proposal, scope);
  assert.equal(emptyMatch.resourceRequirements[0].lookup.resolution, 'draft-after-no-match');
  assert.equal(draftCount, 1);
});

test('native discovery distinguishes an exact directory mapping from observation of its children', async t => {
  const workspace = await ownedDirectory(t);
  const source = path.join(workspace, 'generated');
  const generation = path.join(source, 'test-generation');
  const directory = path.join(generation, 'team-workflows');
  const child = path.join(directory, 'skills', 'check');
  const entryDirectory = path.join(directory, 'skills', 'team-workflows');
  await mkdir(child, { recursive: true });
  await mkdir(entryDirectory, { recursive: true });
  await writeFile(path.join(entryDirectory, 'SKILL.md'), 'Owned collection');
  await writeFile(path.join(child, 'SKILL.md'), 'Owned child');
  const collection = { id: 'team', name: 'team-workflows', directory: 'team-workflows' };
  const mapping = { generationId: 'generation', discoveryRoot: generation, snapshotHash: 'snapshot',
    manifestHash: 'manifest', operationId: 'publish' };
  const files = ['team-workflows/skills/team-workflows/SKILL.md', 'team-workflows/skills/check/SKILL.md'];
  const receipts = new Map();
  const skills = [];
  const create = () => createLocalCodexSkills({ workspace, root: source, collection,
    get: key => receipts.get(key), put: (key, value) => receipts.set(key, value),
    readCatalog: async () => ({ skills }) });
  const first = await create();
  assert.equal(await first.discovery.compareAndSetMapping({ expected: null, next: mapping }), true);
  const restored = await create();
  assert.deepEqual(await restored.discovery.readMapping(), mapping);
  const entry = (name, file) => ({ name, path: file, description: name, scope: 'repo', enabled: true });
  skills.push(entry('team-workflows', path.join(entryDirectory, 'SKILL.md')));
  assert.equal(await restored.discovery.observeMapping({ mapping, files }), false);
  skills.push(entry('check', path.join(child, 'SKILL.md')));
  assert.equal(await restored.discovery.observeMapping({ mapping, files }), true);
  skills[1].enabled = false;
  assert.equal(await restored.discovery.observeMapping({ mapping, files }), false);
});

test('the local Author drafts only after catalog lookup, publishes the approved Skill with the workflow, and reuses it', async t => {
  let service, client, receiver, receiverClient;
  t.after(async () => { await receiverClient?.close(); await receiver?.close(); await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const model = monthlyTimesheetModel();
  const request = model.execution.request;
  let draftCount = 0;
  let need = { id: 'review-procedure', description: 'Review one provided record.' };
  const applicabilityChecks = [];
  const skillBody = '# Review procedure\n\nUse the confirmed input and return a note.';
  model.execution.request = async input => {
    if (input.flowkitProfessionalSkill) {
      assert.equal(input.flowkitProfessionalSkill.id, need.id);
      draftCount++;
      return { body: need.id === 'temperature-assessment' ? 'Apply the stated temperature procedure.' : skillBody };
    }
    if (input.flowkitProfessionalSkillReview) {
      const { need, text } = input.flowkitProfessionalSkillReview;
      applicabilityChecks.push(need.id);
      assert.ok(text.includes(skillBody));
      return need.id === 'unknown-fit' ? {} : { applicable: need.id !== 'temperature-assessment' };
    }
    if (input.prepared?.task.node.id !== 'proposal') return request(input);
    const entry = { id: 'review', kind: 'agent', name: 'Review record', requiredRole: { id: 'reviewer', label: '复核员' },
      professionalNeeds: [need],
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
  const start = async (name, status = 'candidate-ready') => {
    const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: name, goal: 'Review one provided record.' });
    const prepared = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: name,
      expectedStateVersion: draft.stateVersion, input: 'Review one provided record.', target: { name } } });
    assert.equal(prepared.status, status, JSON.stringify(prepared));
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
  need = { ...need, id: 'review-record-alias' };
  const alias = await start('review-alias');
  const aliasHtml = await (await fetch(alias.candidate.previewUrl, { headers: { cookie } })).text();
  assert.deepEqual(readWorkflowPageData(aliasHtml).executionBindings[0].skills, [pin]);
  need = { id: 'different-name', description: 'Inspect an individual record.' };
  const paraphrase = await start('review-paraphrase');
  const paraphraseHtml = await (await fetch(paraphrase.candidate.previewUrl, { headers: { cookie } })).text();
  assert.deepEqual(readWorkflowPageData(paraphraseHtml).executionBindings[0].skills, [pin]);
  need = { ...need, id: 'unknown-fit' };
  const unclear = await start('review-unclear', 'needs-clarification');
  assert.ok(unclear.questions.some(question => question.id === 'skill-review-unknown-fit'));
  assert.deepEqual(applicabilityChecks, ['review-procedure', 'review-record-alias', 'different-name', 'unknown-fit']);
  assert.equal(draftCount, 1);
  need = { id: 'temperature-assessment', description: 'Assess a temperature reading.' };
  const unmatched = await start('temperature-assessment');
  const unmatchedHtml = await (await fetch(unmatched.candidate.previewUrl, { headers: { cookie } })).text();
  assert.equal(readWorkflowPageData(unmatchedHtml).executionBindings[0].skills[0].id, need.id);
  assert.equal(draftCount, 2);

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
    const options = { hostProfile: portable.candidate.manifest.hostProfile, authorizeExecution: () => true,
      resolveApplicableSafetyPolicies: () => [], runtime };
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

    const keyDb = new DatabaseSync(path.join(stateDir, 'local-mcp.sqlite'), { readOnly: true });
    let signer;
    try {
      const key = JSON.parse(keyDb.prepare('SELECT value FROM local_mcp WHERE key = ?').get('export-key-v1').value);
      signer = createPrivateKey({ key: Buffer.from(key.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
    } finally { keyDb.close(); }
    const recipient = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const origin = openLocalSkillStore(path.join(stateDir, 'author.sqlite'), () => false, () => false, { namespace: 'flowkit-local' });
    let encoded;
    try {
      const original = portable.candidate;
      const bundleOptions = { store: origin, target: { collectionId: original.manifest.collectionId,
        skillId: original.manifest.skillId, candidateHash: original.hash }, signerPrivateKey: signer,
      recipientPublicKey: recipient.publicKey, resolveProfessionalSkill: resolution };
      await assert.rejects(sealOfflineWorkflowDependencies({ ...bundleOptions, authorize: () => false }), /denied/);
      encoded = await sealOfflineWorkflowDependencies({ ...bundleOptions, authorize: scope => scope.action === 'export' });
    } finally { origin.close(); }
    assert.doesNotMatch(encoded, /Use the confirmed input/);
    let activeTrust = true, activeGrant = true;
    const recipientOptions = { recipientPrivateKey: recipient.privateKey,
      isTrustedSigner: value => activeTrust && value === service.exportPublicKey,
      authorize: scope => activeGrant && (scope.action !== 'read-skill' || scope.execution.executionRef === request.executionRef) };
    await assert.rejects(openOfflineWorkflowDependencies(encoded, { ...recipientOptions,
      recipientPrivateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /recipient/);
    const edited = JSON.parse(encoded);
    edited.ciphertext = (edited.ciphertext[0] === 'a' ? 'b' : 'a') + edited.ciphertext.slice(1);
    await assert.rejects(openOfflineWorkflowDependencies(JSON.stringify(edited), recipientOptions), /verify/);
    await assert.rejects(openOfflineWorkflowDependencies(encoded, { ...recipientOptions, authorize: () => false }), /authorize/);
    const offline = await openOfflineWorkflowDependencies(encoded, recipientOptions);
    const installed = store.readVersion(request.collectionId, request.skillId, request.candidateHash);
    const offlineOptions = { ...options, resolveRunProfessionalSkill: offline.resolverFor(installed) };
    assert.equal((await runApprovedCollectionWorkflow(store, request, offlineOptions, {})).status, 'succeeded');
    assert.equal(dispatched, 2);
    activeGrant = false;
    await assert.rejects(runApprovedCollectionWorkflow(store, request, offlineOptions, {}), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    activeGrant = true; activeTrust = false;
    await assert.rejects(runApprovedCollectionWorkflow(store, request, offlineOptions, {}), { code: 'FKA_DEPENDENCY_UNAVAILABLE' });
    assert.equal(dispatched, 2);
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

async function finishedDesign(request) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const response = await request();
    if (response.isError || JSON.parse(response.content[0].text).status !== 'running') return response;
    if (Date.now() >= deadline) throw new Error('Design fixture did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const scope of ['model', 'turn']) {
  test('project design preserves the ' + scope + ' timeout and resumes each attempt at most once', async t => {
    let client, service;
    t.after(async () => { try { await client?.close(); } finally { await service?.close(); } });
    const root = await ownedDirectory(t);
    const token = 'test-design-resume-timeout-credential';
    const config = { listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports'),
      authorProvider: 'openai', designTurnDurationMs: scope === 'turn' ? 400 : 4000 };
    let block = true, deny = false;
    const calls = [];
    const model = localModel({
      provider: 'openai', model: 'fixture', apiKey: 'fixture', timeoutMs: scope === 'model' ? 60 : 5000,
      async fetcher(_url, options) {
        const input = JSON.parse(JSON.parse(options.body).input[1].content);
        const [part] = input.materials;
        calls.push(part.id);
        if (part.title === 'Second' && block) {
          return new Response(new ReadableStream({start(controller) {
            options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
          }}));
        }
        const proposal = { schemaVersion: 1, nodes: [{ id: part.id, name: part.title, description: 'Read source ' + part.title,
          sources: [part.id] }], edges: [], unresolved: [], coverage: [{ source: part.id, status: 'represented', reason: 'Read' }] };
        return Response.json({ status: 'completed', id: 'design-' + calls.length, output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }
        ] });
      }
    });
    delete model.planLayout;
    const materials = ['First', 'Second'].map((title, index) =>
      ({ id: 'part-' + index, title, content: ('Read the selected ' + title + ' source.\n').repeat(200) }));
    const sources = materials.map(({ id, content }) => ({ kind: 'material', id, sha256: artifactDigest(content) }));
    const input = { requestId: 'same-design', title: 'Two approved sources', sources };
    async function connect() {
      service = await startLocalMcp(config, { credential: token, modelBinding: model, readAuthoringMaterial({ id }) {
        const material = materials.find(item => item.id === id);
        return !deny && material ? { ...material, authorized: true } : null;
      } });
      client = new Client({ name: 'design-timeout-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { authorization: 'Bearer ' + token } }
      }));
    }
    const request = (args = input) => client.callTool({ name: 'flowkit_create_design_diagram', arguments: args });
    const read = response => {
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    const expectedCode = scope === 'model' ? 'FKA_DESIGN_MODEL_TIMEOUT' : 'FKA_DESIGN_TURN_TIMEOUT';

    await connect();
    assert.deepEqual(read(await request()), { status: 'running', requestId: input.requestId });
    const first = read(await finishedDesign(request));
    assert.equal(first.status, 'timed-out');
    assert.equal(first.error.code, expectedCode);
    assert.equal(first.requestId, input.requestId);
    assert.ok(first.resumeToken);
    assert.equal(calls.length, 2);
    for (const poll of await Promise.all([request(), request(), request({ ...input, resumeToken: 'stale' })])) {
      assert.deepEqual(read(poll), first);
    }
    assert.equal(calls.length, 2);
    await client.close();
    const originalAddress = service.url;
    assert.equal((await service.close()).closed, true);
    await assert.rejects(fetch(originalAddress));

    if (scope === 'turn') {
      // A killed service may leave the original deadline without a terminal write.
      const db = new DatabaseSync(path.join(config.dataDir, 'local-mcp.sqlite'));
      try {
        const key = 'design:' + artifactDigest(input.requestId).slice(7);
        const record = JSON.parse(db.prepare('SELECT value FROM local_mcp WHERE key=?').get(key).value);
        record.attempt = { id: record.attempt.id, status: 'running', deadlineMs: Date.now() - 1 };
        db.prepare('UPDATE local_mcp SET value=? WHERE key=?').run(JSON.stringify(record), key);
      } finally { db.close(); }
    }
    await connect();
    assert.deepEqual(read(await request()), first);
    deny = true;
    assert.ok((await request({ ...input, resumeToken: first.resumeToken })).isError);
    deny = false;
    assert.equal(calls.length, 2);
    assert.equal(read(await request({ ...input, resumeToken: first.resumeToken })).status, 'running');
    const second = read(await finishedDesign(request));
    assert.equal(second.error.code, expectedCode);
    assert.notEqual(second.resumeToken, first.resumeToken);
    assert.deepEqual(read(await request({ ...input, resumeToken: first.resumeToken })), second);
    assert.equal(calls.length, 3);

    block = false;
    const resume = { ...input, resumeToken: second.resumeToken };
    for (const start of await Promise.all([request(resume), request(resume)])) {
      assert.ok(['running', 'ready'].includes(read(start).status));
    }
    const delivered = read(await finishedDesign(request));
    assert.equal(delivered.status, 'ready');
    assert.equal(delivered.files.length, 1);
    assert.deepEqual(calls, [calls[0], calls[1], calls[1], calls[1]]);
    assert.notEqual(calls[0], calls[1]);
    assert.equal(read(await request(resume)).designHash, delivered.designHash);
  });
}

test('disconnecting a Design client preserves work and orderly Host stop records an interruption', async t => {
  let service, client;
  t.after(async () => { try { await client?.close(); } finally { await service?.close(); } });
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports') };
  const token = 'test-design-stop-credential';
  const model = monthlyTimesheetModel();
  let modelSignal;
  let calls = 0;
  model.planDesign = async ({ signal }) => {
    calls++;
    modelSignal = signal;
    if (!signal.aborted) await once(signal, 'abort');
    signal.throwIfAborted();
  };
  async function connect() {
    service = await startLocalMcp(config, { credential: token, modelBinding: model });
    client = new Client({ name: 'design-stop-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { authorization: 'Bearer ' + token } }
    }));
  }
  const input = { requestId: 'stop-design', title: 'Design', materials: [{ id: 'one', title: 'One', content: 'Read' }] };
  const request = () => client.callTool({ name: 'flowkit_create_design_diagram', arguments: input });
  await connect();
  assert.equal(JSON.parse((await request()).content[0].text).status, 'running');
  await client.close();
  assert.equal(modelSignal?.aborted, false);
  const address = service.url;
  assert.equal((await service.close()).closed, true);
  await assert.rejects(fetch(address));
  assert.equal(modelSignal.aborted, true);
  await connect();
  const stopped = JSON.parse((await request()).content[0].text);
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.error.code, 'FKA_DESIGN_INTERRUPTED');
  assert.ok(stopped.resumeToken);
  assert.equal(calls, 1);
});

test('local shutdown reports non-cooperative Design and Author work without releasing the service lease', { timeout: 25000 }, async t => {
  const root = await ownedDirectory(t);
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports') };
  const credential = 'test-noncooperative-shutdown-key';
  const model = monthlyTimesheetModel();
  const designEntered = Promise.withResolvers(), authorEntered = Promise.withResolvers();
  const designRelease = Promise.withResolvers(), authorRelease = Promise.withResolvers();
  let service, client, authorClient, pending, recovered;
  const raw = model.execution.request;
  model.execution.request = async (input, options) => {
    if (input.flowkitIntent) {
      authorEntered.resolve(options.signal);
      await authorRelease.promise;
    }
    return raw(input, options);
  };
  model.planDesign = async ({ signal }) => {
    designEntered.resolve(signal);
    await designRelease.promise;
    signal.throwIfAborted();
  };
  const connect = async active => {
    const connection = new Client({ name: 'shutdown-test', version: '1.0.0' });
    await connection.connect(new StreamableHTTPClientTransport(new URL(active.url), {
      requestInit: { headers: { authorization: 'Bearer ' + credential } }
    }));
    return connection;
  };
  const input = { requestId: 'blocked-design', title: 'Design', materials: [{ id: 'one', title: 'One', content: 'Read' }] };
  try {
    service = await startLocalMcp(config, { credential, modelBinding: model });
    client = await connect(service);
    authorClient = await connect(service);
    const opened = await authorClient.callTool({ name: 'flowkit_start_workflow', arguments: {
      requestId: 'blocked-author', operation: 'create', goal: 'Inspect', executionMode: 'standard'
    } });
    const draft = JSON.parse(opened.content[0].text);
    pending = authorClient.callTool({ name: 'flowkit_prepare_workflow', arguments: { turn: {
      draftId: draft.id, turnId: 'blocked-turn', expectedStateVersion: draft.stateVersion, input: 'Inspect'
    } } }).catch(error => error);
    const started = await client.callTool({ name: 'flowkit_create_design_diagram', arguments: input });
    assert.equal(JSON.parse(started.content[0].text).status, 'running');
    const [designSignal, authorSignal] = await Promise.all([designEntered.promise, authorEntered.promise]);
    const stopped = await service.close({ timeoutMs: 40 });
    assert.equal(stopped.closed, false);
    assert.ok(stopped.outstanding >= 2, JSON.stringify(stopped));
    assert.equal(stopped.local.design, 1);
    assert.equal(designSignal.aborted, true);
    assert.equal(authorSignal.aborted, true);
    await assert.rejects(fetch(service.url));
    await assert.rejects(startLocalMcp(config, { credential, modelBinding: model }), /数据目录已被其他本机 MCP 服务占用/);
    designRelease.resolve();
    const stillAuthor = await service.close({ timeoutMs: 100 });
    assert.equal(stillAuthor.closed, false);
    await assert.rejects(startLocalMcp(config, { credential, modelBinding: model }), /数据目录已被其他本机 MCP 服务占用/);
    authorRelease.resolve();
    assert.deepEqual(await service.close(), { closed: true, outstanding: 0 });
    recovered = await startLocalMcp(config, { credential, modelBinding: model });
    const next = await connect(recovered);
    try {
      const result = await next.callTool({ name: 'flowkit_create_design_diagram', arguments: input });
      const record = JSON.parse(result.content[0].text);
      assert.equal(record.status, 'interrupted');
      assert.equal(record.error.code, 'FKA_DESIGN_INTERRUPTED');
      assert.ok(record.resumeToken);
      const read = await next.callTool({ name: 'flowkit_get_workflow_draft', arguments: { draftId: draft.id } });
      const observed = JSON.parse(read.content[0].text);
      assert.equal(observed.candidate, undefined);
    } finally { await next.close(); }
  } finally {
    designRelease.resolve(); authorRelease.resolve();
    await Promise.allSettled([client?.close(), authorClient?.close(), pending]);
    if (service) await service.close();
    if (recovered) await recovered.close();
  }
});

// The optional layout cutoff is the subject of this fixture, not the mandatory
// Design deadline (covered separately above). Trigger its TimeoutError after
// physical dispatch, instead of racing publication I/O against a 2-second turn.
for (const grouped of [false, true]) {
  test(grouped ? 'all Design view scopes share one optional layout deadline' :
    'an optional layout timeout does not prevent delivery or repeat the design model', async t => {
    let service, client;
    let modelCalls = 0, layoutCalls = 0, layoutDeadlines = 0;
    let layoutSignal, finishLayout;
    const parentDuration = 46_000;
    const optionalDeadline = new AbortController();
    const nativeTimeout = AbortSignal.timeout;
    // Only intercept the fixture's optional half-turn deadline after Design planning.
    // The parent deadline and unrelated transport timers remain real.
    const timeout = t.mock.method(AbortSignal, 'timeout', duration => {
      if (modelCalls && duration >= parentDuration / 4 && duration <= parentDuration / 2) {
        layoutDeadlines++;
        return optionalDeadline.signal;
      }
      return nativeTimeout(duration);
    });
    t.after(async () => {
      finishLayout?.();
      await client?.close();
      await service?.close();
    });
    const root = await ownedDirectory(t);
    const model = monthlyTimesheetModel();
    model.planLayout = ({ signal }) => {
      layoutCalls++;
      layoutSignal = signal;
      const pending = new Promise((_, reject) => { finishLayout = () => reject(new Error('Layout stopped')); });
      setImmediate(() => optionalDeadline.abort(new DOMException('Optional layout deadline', 'TimeoutError')));
      return pending;
    };
    model.planDesign = async ({ materials: [material] }) => {
      modelCalls++;
      const nodes = grouped ? ['one', 'two', 'three', 'four'].map((id, index) => ({
        id, name: 'Step ' + id, description: 'Read source at step ' + id, sources: [material.id],
        subflow: index < 2 ? { key: 'first', name: 'First phase' } : { key: 'second', name: 'Second phase' }
      })) : [{ id: 'start', name: 'Start', description: 'Read request', sources: [material.id] }];
      const edges = grouped ? nodes.slice(0, -1).map((node, index) => ({
        from: node.id, to: nodes[index + 1].id, description: 'Continue to next step', sources: [material.id]
      })) : [];
      return { status: 'completed', requestId: 'design-result', provider: 'fixture', model: 'fixture', proposal: {
        schemaVersion: 1, nodes, edges, unresolved: [],
        coverage: [{ source: material.id, status: 'represented', reason: 'Source-backed steps' }]
      } };
    };
    const token = 'test-design-layout-timeout';
    service = await startLocalMcp({ listen: { port: 0 }, dataDir: path.join(root, 'state'),
      exportDir: path.join(root, 'exports'), designTurnDurationMs: parentDuration }, { credential: token, modelBinding: model });
    client = new Client({ name: 'flowkit-design-timeout-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    const arguments_ = { requestId: 'design-layout-timeout', title: 'Request', materials: [{ id: 'guide', title: 'Guide', content: 'Read' }] };
    const request = () => client.callTool({ name: 'flowkit_create_design_diagram', arguments: arguments_ });
    const response = await finishedDesign(request);
    timeout.mock.restore();
    assert.ok(!response.isError, JSON.stringify(response));
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'ready');
    assert.equal(result.layoutSource, 'fallback');
    assert.equal(layoutSignal?.aborted, true);
    assert.equal(layoutSignal.reason, optionalDeadline.signal.reason);
    assert.equal(layoutSignal.reason.name, 'TimeoutError');
    assert.equal(layoutDeadlines, 1, 'Do not renew optional layout time for another scope');
    assert.equal(layoutCalls, 1, 'Do not dispatch more layout work after the shared deadline');
    assert.equal(modelCalls, 1);
    assert.deepEqual(await readdir(result.directory), ['design.html']);
    if (grouped) {
      const page = readWorkflowPageData(await readFile(path.join(result.directory, 'design.html'), 'utf8'));
      assert.equal(page.graph.nodes.length, 4);
      assert.equal(page.project.positions.length, 3);
      assert.ok(page.project.positions.every(scope => scope.layoutSource === 'fallback'));
    }
    assert.equal(JSON.parse((await request()).content[0].text).designHash, result.designHash);
  });
}

test('project design uses known source IDs, commits one offline HTML and replays an exact request', async t => {
  let service, client;
  t.after(async () => { await client?.close(); await service?.close(); });
  const root = await ownedDirectory(t);
  const model = monthlyTimesheetModel();
  const material = { id: 'guide', title: '交付指南', content: '先复审，后由用户确认。' };
  const materialRef = { kind: 'material', id: material.id, sha256: artifactDigest(material.content) };
  let activeSource = true, changedSource = false, allowExcerpt = false, authorInputs = [], acceptedRuns = 0;
  const physical = model.execution.request;
  model.execution.request = async input => {
    if (input.flowkitIntent) authorInputs.push(input.flowkitIntent);
    return physical(input);
  };
  let calls = 0;
  model.planDesign = async ({ materials }) => {
    calls++;
    return { status: 'completed', provider: 'test', model: 'test', requestId: 'design-test-observation', proposal: { schemaVersion: 1,
      nodes: [{ id: 'review', name: '复审工作流', description: '核对候选', sources: [materials[0].id] },
        { id: 'confirm', name: '确认候选', description: '由用户确认', sources: [materials[0].id] }],
      coverage: [{ source: materials[0].id, status: 'represented', reason: '已识别复审和确认节点' }],
      edges: [{ from: 'review', to: 'confirm', description: '复审完成', sources: [materials[0].id] }],
      unresolved: [{ question: '谁依照仓库制度执行复审？', sources: [materials[0].id] }] } };
  };
  const token = 'test-design-diagram-credential';
  service = await startLocalMcp({ listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports') },
    { credential: token, modelBinding: model,
      authorizeDesignExcerptExport({ sourceId, sourceDigest, rangeDigest }) {
        return allowExcerpt && sourceId === material.id && sourceDigest === materialRef.sha256 && rangeDigest === materialRef.sha256;
      },
      readAuthoringMaterial({ id, requestContext }) {
        assert.equal(requestContext.principalId, 'flowkit-local-owner');
        return activeSource && id === material.id
          ? { authorized: true, ...material, content: changedSource ? material.content + '变更' : material.content } : null;
      },
      async runWorkflow(scope, { candidate, store }) {
        if (scope.executionRef !== 'authorized-design-run') throw new Error('Host denied this execution reference');
        const skillDirectory = path.join(root, 'runtime');
        await writeFile(path.join(skillDirectory, 'workflow.js'), candidate.files['workflow.js']);
        return runApprovedCollectionWorkflow(store, { ...scope, skillDirectory }, {
          hostProfile: candidate.manifest.hostProfile, authorizeExecution: ({ executionRef }) => executionRef === 'authorized-design-run',
          resolveApplicableSafetyPolicies: () => [],
          runtime: { isControlSignal: () => false, runVerification: () => true, runAction: async () => { acceptedRuns++; } }
        }, {});
      }
    });
  client = new Client({ name: 'flowkit-design-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
  const input = { requestId: 'delivery-design', title: '交付流程设计', materials: [material] };
  const create = args => finishedDesign(() => client.callTool({ name: 'flowkit_create_design_diagram', arguments: args }));
  const first = await create(input);
  assert.ok(!first.isError, JSON.stringify(first));
  const result = JSON.parse(first.content[0].text);
  assert.deepEqual(await readdir(result.directory), ['design.html']);
  const html = await readFile(path.join(result.directory, 'design.html'), 'utf8');
  const view = readWorkflowPageData(html);
  assert.equal(view.graph.mode, 'design');
  assert.deepEqual(view.design.sources, [{ id: material.id, title: material.title, digest: artifactDigest(material.content) }]);
  assert.equal(view.design.excerpts, undefined);
  assert.equal(view.design.unresolved.length, 1);
  assert.equal(JSON.parse((await create(input)).content[0].text).designHash, result.designHash);
  assert.equal((await create({ ...input, title: '不同请求' })).isError, true);
  assert.equal(calls, 1);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(response.content[0].text), isError: response.isError === true };
  };
  allowExcerpt = true;
  const pinnedResult = await create({ requestId: 'pinned-design', title: input.title, sources: [materialRef] });
  assert.ok(!pinnedResult.isError, JSON.stringify(pinnedResult));
  const pinned = JSON.parse(pinnedResult.content[0].text);
  assert.equal((await fetch(pinned.files[0].url)).status, 200);
  const pinnedView = readWorkflowPageData(await readFile(path.join(pinned.directory, 'design.html'), 'utf8'));
  const [excerpt] = pinnedView.design.excerpts;
  assert.equal(excerpt.text, material.content);
  const evidenceUrl = new URL('evidence', pinned.files[0].url);
  evidenceUrl.search = new URLSearchParams({ source: material.id, range: excerpt.rangeId });
  assert.equal((await fetch(evidenceUrl)).status, 403);
  const evidenceHeaders = { cookie: await browserIdentity(service) };
  const evidenceResponse = await fetch(evidenceUrl, { headers: evidenceHeaders });
  assert.equal(evidenceResponse.status, 200);
  assert.equal((await evidenceResponse.json()).text, material.content);
  changedSource = true;
  assert.equal((await fetch(evidenceUrl, { headers: evidenceHeaders })).status, 404);
  changedSource = false;
  const draft = await call('flowkit_start_workflow', { requestId: 'design-to-workflow', operation: 'create',
    goal: '基于交付指南起草工作流', executionMode: 'standard' });
  const turn = { draftId: draft.id, turnId: 'from-design', expectedStateVersion: draft.stateVersion,
    input: '结合交付指南和需求起草流程', target: { name: 'monthly-timesheet' } };
  const designSource = { kind: 'design', ref: pinned.designRef, sha256: pinned.designHash };
  const requirement = { kind: 'text', id: 'requirement', title: '交付需求', content: '副本校验通过后交付。' };
  const wrong = await call('flowkit_prepare_workflow', { turn, sources: [{ ...designSource, sha256: artifactDigest('wrong') }] });
  assert.equal(wrong.error.code, 'FKA_MATERIAL_UNAVAILABLE');
  assert.equal(authorInputs.length, 0);
  const candidate = await call('flowkit_prepare_workflow', { turn, sources: [designSource, requirement] });
  assert.equal(candidate.status, 'candidate-ready', JSON.stringify(candidate));
  assert.deepEqual(authorInputs[0].context.materials.map(item => item.id), [material.id, requirement.id]);
  assert.equal(authorInputs[0].context.designs[0].sha256, pinned.designHash);
  const follow = { ...turn, turnId: 'continued', expectedStateVersion: candidate.stateVersion, input: '继续复审' };
  activeSource = false;
  assert.equal((await call('flowkit_prepare_workflow', { turn: follow })).error.code, 'FKA_MATERIAL_UNAVAILABLE');
  assert.equal((await call('flowkit_export_workflow', { draftId: draft.id,
    candidateHash: candidate.candidate.candidateHash })).error.code, 'FKA_MATERIAL_UNAVAILABLE');
  for (const file of pinned.files) assert.equal((await fetch(file.url)).status, 403);
  activeSource = true; changedSource = true;
  assert.equal((await call('flowkit_prepare_workflow', { turn: follow })).error.code, 'FKA_MATERIAL_CHANGED');
  assert.equal((await fetch(pinned.files[0].url)).status, 403);
  changedSource = false;
  assert.equal((await fetch(pinned.files[0].url)).status, 200);
  assert.equal(authorInputs.length, 1);
  await mkdir(path.join(root, 'runtime'));
  const execution = { skillId: 'unapproved', candidateHash: candidate.candidate.candidateHash, executionRef: 'authorized-design-run' };
  assert.equal((await call('flowkit_run_workflow', execution)).isError, true);
  const accepted = await call('flowkit_add_workflow', { requestId: 'approve-design-run',
    sourceRef: draft.id, candidateHash: candidate.candidate.candidateHash });
  const cookie = evidenceHeaders.cookie;
  const saved = await (await confirmInTestBrowser(accepted.confirmationUrl, cookie)).json();
  assert.equal((await call('flowkit_run_workflow', { ...execution, skillId: saved.workflowId, executionRef: 'denied' })).isError, true);
  assert.equal((await call('flowkit_run_workflow', { ...execution, skillId: saved.workflowId })).status, 'succeeded');
  assert.equal(acceptedRuns, 1);
  await writeFile(path.join(result.directory, 'design.html'), 'tampered');
  assert.equal((await fetch(result.files[0].url)).status, 409);
  assert.equal((await create(input)).isError, true);
});

test('project design resumes authorized persisted fragments and delivers one complete large HTML', async t => {
  let client, service;
  t.after(async () => { try { await client?.close(); } finally { await service?.close(); } });
  const root = await ownedDirectory(t);
  const model = monthlyTimesheetModel();
  const contents = Array.from({ length: 7 }, (_, index) => ({
    id: 'material-' + index, title: 'Phase ' + index,
    content: index === 0 ? '🙂中'.repeat(2100) + '\r\n结尾' : 'Actual project phase ' + index
  }));
  const sources = contents.map(material => ({ kind: 'material', id: material.id, sha256: artifactDigest(material.content) }));
  const stats = new Map();
  let calls = 0, unavailable = false, fail = true, revokeDuringPlanning = false;
  model.planDesign = async ({ materials: [part] }) => {
    stats.set(part.id, (stats.get(part.id) ?? 0) + 1);
    if (++calls === 2 && fail) throw new Error('Interrupted design');
    if (revokeDuringPlanning && part.id === 'material-6') unavailable = true;
    const nodes = Array.from({ length: 51 }, (_, index) => ({ id: 'step-' + index, name: 'Step ' + index,
      description: 'A reviewed step', sources: [part.id] }));
    return { status: 'completed', requestId: 'plan-' + calls, proposal: { schemaVersion: 1, nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id,
        description: 'continues', sources: [part.id] })),
      unresolved: Array.from({ length: 3 }, (_, index) => ({ question: 'Review ' + index, sources: [part.id] })),
      coverage: [{ source: part.id, status: 'represented', reason: 'Bound to reviewed phases' }]
    } };
  };
  const credential = 'test-resumable-project-key';
  const config = { listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports') };
  async function connect() {
    service = await startLocalMcp(config, { credential, modelBinding: model, readAuthoringMaterial({ id }) {
      const material = contents.find(value => value.id === id);
      return material && !(unavailable && id === 'material-0') ? { authorized: true, ...material } : null;
    } });
    client = new Client({ name: 'project-resumption-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { authorization: 'Bearer ' + credential } } }));
  }
  const input = { requestId: 'large-design', title: 'Large project', sources };
  const request = args => client.callTool({ name: 'flowkit_create_design_diagram', arguments: args });
  const create = args => finishedDesign(() => request(args));
  async function noDelivery() {
    const entries = await readdir(config.exportDir).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return [];
    });
    assert.deepEqual(entries, []);
  }
  await connect();
  const pending = JSON.parse((await request(input)).content[0].text);
  assert.deepEqual(pending, { status: 'running', requestId: input.requestId });
  assert.equal((await create(input)).isError, true);
  await noDelivery();
  const first = [...stats.keys()][0];
  await client.close();
  await service.close();
  await connect();
  fail = false;
  unavailable = true;
  assert.equal((await create(input)).isError, true);
  assert.equal(calls, 2);
  unavailable = false;
  revokeDuringPlanning = true;
  assert.equal((await create(input)).isError, true);
  await noDelivery();
  assert.equal(stats.get(first), 1);
  const finished = calls;
  unavailable = false;
  revokeDuringPlanning = false;
  let result = await create(input);
  if (result.isError) {
    assert.match(result.content[0].text, /authorize|unavailable/i);
    result = await create(input);
  }
  assert.ok(!result.isError, JSON.stringify(result));
  const delivered = JSON.parse(result.content[0].text);
  assert.equal(delivered.status, 'ready');
  assert.equal(calls, finished);
  assert.deepEqual(await readdir(delivered.directory), ['design.html']);
  const data = readWorkflowPageData(await readFile(path.join(delivered.directory, 'design.html'), 'utf8'));
  assert.ok(data.graph.nodes.length > 360);
  assert.ok(data.graph.referenceEdges.length > 120);
  assert.ok(data.design.unresolved.length > 20);
  assert.deepEqual(data.design.sources.map(source => source.id), contents.map(part => part.id));
  const nodeIds = new Set(data.graph.nodes.map(node => node.id));
  const positions = data.project.positions.flatMap(scope => scope.tiles).map(tile => tile.id).filter(id => nodeIds.has(id));
  assert.deepEqual(positions.sort(), [...nodeIds].sort());
  assert.ok(data.project.root.length > 1);
  assert.equal((await create({ ...input, sources: sources.slice(1) })).isError, true);
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
  const database = new DatabaseSync(path.join(config.dataDir, 'local-mcp.sqlite'));
  try {
    const key = 'export:' + old.exportReceipt;
    const record = JSON.parse(database.prepare('SELECT value FROM local_mcp WHERE key=?').get(key).value);
    database.prepare('UPDATE local_mcp SET value=? WHERE key=?')
      .run(JSON.stringify({ ...record, viewerHash: artifactDigest('retired renderer') }), key);
  } finally { database.close(); }
  await start();
  const count = calls;
  const current = await tool('flowkit_get_workflow_draft', { draftId: draft.id });
  assert.equal(current.candidate.layoutRevision, winning.layoutRevision);
  assert.ok(await tool('flowkit_export_workflow', { ...args, layoutRevision: winning.layoutRevision }));
  assert.equal(calls, count);
  assert.deepEqual(await readDelivery(old.directory), original);
  const renewed = await tool('flowkit_export_workflow', { ...args, exportReceipt: old.exportReceipt });
  assert.equal(renewed.directory, old.directory);
  assert.equal(renewed.exportReceipt, old.exportReceipt);
  assert.deepEqual(renewed.files.map(file => file.sha256), old.files.map(file => file.sha256));
  for (const file of renewed.files) {
    const response = await fetch(file.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), original[file.name]);
  }
  assert.equal(calls, count);
  await tool('flowkit_export_workflow', { ...args, exportReceipt: old.exportReceipt, layoutRevision: winning.layoutRevision }, false);
  const member = path.join(old.directory, 'workflow.html');
  const rejected = await tool('flowkit_export_workflow', { ...args, exportReceipt: '0'.repeat(64) }, false);
  assert.equal(rejected.error.code, 'FKA_HOST_OPERATION_FAILED');
  assert.ok(!rejected.error.message.includes(old.directory));
  await rm(member);
  const missing = await tool('flowkit_export_workflow', { ...args, exportReceipt: old.exportReceipt }, false);
  assert.equal(missing.error.code, 'FKA_EXPORT_FILES_UNAVAILABLE');
  assert.ok(!missing.error.message.includes(old.directory));
  await writeFile(member, original['workflow.html'] + '\n');
  const changed = await tool('flowkit_export_workflow', { ...args, exportReceipt: old.exportReceipt }, false);
  assert.equal(changed.error.code, 'FKA_EXPORT_FILES_UNAVAILABLE');
  assert.ok(!changed.error.message.includes(old.directory));
  assert.equal((await fetch(renewed.files.find(file => file.name === 'workflow.html').url)).status, 409);
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
  const availableTools = (await client.listTools()).tools;
  assert.equal(Object.hasOwn(availableTools.find(item => item.name === 'flowkit_start_workflow').inputSchema.properties, 'includeSource'), false);
  assert.equal(Object.hasOwn(availableTools.find(item => item.name === 'flowkit_add_workflow').inputSchema.properties, 'approvalRef'), false);
  async function assertUnsupported(name, args, field) {
    let result;
    try { result = await client.callTool({ name, arguments: args }); }
    catch (error) {
      assert.match(String(error.message), new RegExp(field));
      return;
    }
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), new RegExp(field));
  }
  assert.equal(client.getServerCapabilities().resources, undefined);
  const collection = await tool('flowkit_collection', {});
  assert.equal(collection.collection.name, 'flowkit-workflows');
  assert.equal(Object.hasOwn(collection.collection, 'rootSkill'), false);
  const startRequest = { operation: 'create', requestId: 'monthly-start',
    goal: '校验月度工时输入，写入副本并二次校验，失败结束。' };
  await assertUnsupported('flowkit_start_workflow', { ...startRequest, includeSource: true }, 'includeSource');
  await assertUnsupported('flowkit_start_workflow', { ...startRequest, includeSource: false }, 'includeSource');
  const draft = await tool('flowkit_start_workflow', startRequest);
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
  await assertUnsupported('flowkit_add_workflow', { ...addRequest, approvalRef: 'caller-supplied-approval' }, 'approvalRef');
  assert.equal((await tool('flowkit_collection', {})).skills.length, 0);
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
    safetyPolicies: [],
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
      safetyPolicies: [],
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
