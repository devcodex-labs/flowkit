import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileArtifact, isControlSignal, run, runArtifact } from '../../src/index.mjs';

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const integrity = value => `sha256-${createHash('sha256').update(value).digest('base64')}`;
const success = (result = { ok: true }) => ({ status: 'succeeded', result, events: [] });
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const runtime = extra => ({
  isControlSignal,
  validateResult: (_schema, result) => typeof result.ok === 'boolean' ? [] : ['expected boolean'],
  runAgentTask: async () => success(),
  ...extra
});
const profile = { schemaVersion: 1, hostId: 'test-host', hostVersion: '1.0.0', adapterId: 'fixture',
  adapterVersion: '1.0.0', executionModes: ['standard'], capabilities: { skillResourceLoading: 'supported' } };

async function sample(t, fields, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowkit-task-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sample.workflow.js');
  const nodeFields = { name: 'Work', output: schema, next: 'done', ...fields, ...extra };
  await writeFile(file, `
import { defineWorkflow, node, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'sample', version: '1.0.0', name: 'Sample', nodes: [
  node('work', ${JSON.stringify(nodeFields)}), terminal('done', { name: 'Done', status: 'succeeded' })
] });`);
  return { dir, file };
}

test('description task runs with isolated declared input and commits only validated results', async t => {
  const { file } = await sample(t, { description: ['Do this', 'Then inspect'], inputs: ['record', 'nil', 'absent'], retries: 1 });
  const original = { record: { count: 1 }, nil: null, unrelated: 'excluded' };
  const tasks = [];
  const results = [];
  const out = await run(file, runtime({
    recordAgentResult: (task, result) => results.push([task, result]),
    async runAgentTask(prepared) {
      const { task } = prepared;
      tasks.push(task);
      assert.deepEqual(task.task.description, ['Do this', 'Then inspect']);
      assert.deepEqual(task.input, { record: { count: 1 }, nil: null });
      assert.deepEqual(task.missing, ['absent']);
      assert.throws(() => { task.input.record.count = 3; }, TypeError);
      assert.match(prepared.resourceManifest.manifestHash, /^sha256:/);
      return tasks.length === 1 ? success({ ok: 'invalid' }) :
        { ...success(), events: [{ type: 'validation-passed' }], usage: { inputTokens: 12 } };
    }
  }), original);
  assert.equal(out.state.ok, true);
  assert.equal(out.state.usage, undefined);
  assert.equal(out.state.events, undefined);
  assert.deepEqual(original.record, { count: 1 });
  assert.deepEqual(tasks.map(task => task.execution.attempt), [1, 2]);
  assert.equal(tasks[0].execution.activationId, tasks[1].execution.activationId);
  assert.notEqual(tasks[0].execution.requestId, tasks[1].execution.requestId);
  assert.equal(results.length, 2);
});

test('refs-only task fixes ordered resource identities and requires explicit instruction', async t => {
  const { dir, file } = await sample(t, { descriptionRefs: [
    { uri: 'instruction.md', role: 'instruction' }, { uri: 'reference.txt' }, { uri: 'evidence.md', role: 'evidence' }
  ], requiredSkills: [{ id: 'reviewer', version: '1.2.3' }, { id: 'reader' }] });
  for (const [name, content] of [['instruction.md', 'Validate output'], ['reference.txt', 'Reference'], ['evidence.md', 'Evidence']]) {
    await writeFile(path.join(dir, name), content);
  }
  const calls = [];
  const out = await run(file, runtime({
    taskPolicy: { projectRoot: dir, hostProfile: profile },
    async prepareAgentTask(task, context) {
      return { protocolVersion: 2, task, descriptionResources: context.descriptionResources, skills: [
        { logicalId: 'reviewer', resolvedVersion: '1.2.3', digest: hash('reviewer') },
        { logicalId: 'reader', resolvedVersion: '2.0.0', digest: hash('reader') }
      ] };
    },
    async runAgentTask(prepared) {
      calls.push(prepared);
      assert.deepEqual(prepared.descriptionResources.map(item => item.role), ['instruction', 'reference', 'evidence']);
      assert.equal(prepared.descriptionResources[0].digest, hash('Validate output'));
      assert.equal(prepared.task.task.requiredSkills[1].version, undefined);
      assert.equal(prepared.resourceManifest.resources.length, 5);
      return success();
    }
  }));
  assert.equal(out.state.ok, true);
  assert.equal(calls.length, 1);
});

test('prepared task data rejects non-JSON inputs and leaves committed business data mutable by Actions', async t => {
  const { file } = await sample(t, { description: 'Unused' });
  await writeFile(file, `
import { defineWorkflow, node, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'mutable', version: '1.0.0', name: 'Mutable', nodes: [
  node('agent', { name: 'Agent', description: 'Work', inputs: ['input'], output: { type: 'object' }, next: 'save' }),
  action('save', { name: 'Save', action: 'save', next: 'done' }),
  terminal('done', { name: 'Done', status: 'succeeded' })
] });`);
  const payload = { ok: true, written: { count: 1 } };
  let dispatched = 0;
  const host = runtime({
    async runAgentTask() { dispatched++; return success(payload); },
    async runAction(_id, _name, context) { context.state.written.count++; }
  });
  await assert.rejects(run(file, host, { input: new Date() }), { kind: 'invalid-task' });
  assert.equal(dispatched, 0);
  const result = await run(file, host, { input: null });
  assert.deepEqual(result.state.written, { count: 2 });
  assert.deepEqual(payload.written, { count: 1 });
});

test('compiler rejects invalid task descriptions, unsafe paths and floating Skill versions', async t => {
  const cases = [
    [{ description: '' }, 'FK_C007'],
    [{ description: [] }, 'FK_C007'],
    [{ description: ['valid', 7] }, 'FK_C007'],
    [{ descriptionRefs: [{ uri: 'evidence.md', role: 'evidence' }] }, 'FK_C050'],
    [{ description: 'Work', descriptionRefs: [{ uri: '../outside.md' }] }, 'FK_C052'],
    [{ description: 'Work', descriptionRefs: [{ uri: 'http://example.test/info.md' }] }, 'FK_C052'],
    [{ description: 'Work', descriptionRefs: [{ uri: 'https://other.test/info.md' }] }, 'FK_C057'],
    [{ description: 'Work', requiredSkills: [{ id: 'reviewer', version: 'latest' }] }, 'FK_C002'],
    [{ description: 'Work', requiredSkills: [{ id: 'reviewer', version: '^1.0.0' }] }, 'FK_C002']
  ];
  for (const [fields, expected] of cases) {
    const { file } = await sample(t, fields);
    const result = await compileArtifact(file);
    assert.equal(result.artifactHash, null);
    assert.ok(result.diagnostics.some(item => item.code === expected), JSON.stringify(result.diagnostics));
  }
});

test('description validation fails before dispatch on symlink escape, bad UTF-8, size or hash', async t => {
  const bodies = [
    { body: Buffer.from([0xc3, 0x28]), error: 'FK_R014' },
    { body: 'oversize', error: 'FK_R014', maxResourceBytes: 3 },
    { body: 'mismatch', error: 'FK_R013', integrity: integrity('expected') }
  ];
  for (const { body, error, maxResourceBytes, integrity: digest } of bodies) {
    const reference = { uri: 'task.md', role: 'instruction', ...(digest ? { integrity: digest } : {}) };
    const { dir, file } = await sample(t, { descriptionRefs: [reference] });
    await writeFile(path.join(dir, 'task.md'), body);
    await assert.rejects(run(file, runtime({
      taskPolicy: { projectRoot: dir, maxResourceBytes },
      runAgentTask: async () => assert.fail('unexpected dispatch')
    })), { code: error });
  }
  const { dir, file } = await sample(t, { descriptionRefs: [{ uri: 'link/source.md', role: 'instruction' }] });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'flowkit-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'source.md'), 'Outside authorized root');
  await symlink(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(file, runtime({ taskPolicy: { projectRoot: dir },
    runAgentTask: async () => assert.fail('unexpected dispatch') })), { code: 'FK_R011' });
});

test('trusted transport runs policy for every remote read and rejects cross-origin redirects', async t => {
  const ref = { uri: 'https://example.test/task.md', role: 'instruction', integrity: integrity('Work') };
  const { file } = await sample(t, { descriptionRefs: [ref] });
  const options = { remoteSkillHosts: ['example.test'] };
  const requested = [];
  const host = runtime({
    taskPolicy: {
      authorizeRemote: url => new URL(url).hostname === 'example.test',
      fetch: async url => {
        requested.push(url);
        return new Response('Work', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
  });
  assert.equal((await run(file, host, {}, options)).state.ok, true);
  assert.deepEqual(requested, [ref.uri]);
  host.taskPolicy.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.test/task.md' } });
  await assert.rejects(run(file, host, {}, options), { code: 'FK_R012' });
  host.taskPolicy.authorizeRemote = () => false;
  host.taskPolicy.fetch = async () => assert.fail('unauthorized fetch');
  await assert.rejects(run(file, host, {}, options), { code: 'FK_R012' });
});

test('Run dispatch limit and unknown side effects prevent uncontrolled retries', async t => {
  const { file } = await sample(t, { description: 'Work', retries: 3 });
  let calls = 0;
  const fail = sideEffectStatus => ({ status: 'failed', events: [],
    failure: { code: 'provider-failure', message: 'Failed', retryable: true, sideEffectStatus } });
  await assert.rejects(run(file, runtime({
    taskPolicy: { maxDispatches: 1 },
    async runAgentTask() { calls++; return fail('none'); }
  })), { kind: 'dispatch-limit' });
  assert.equal(calls, 1);
  await assert.rejects(run(file, runtime({
    async runAgentTask() { calls++; return fail('unknown'); }
  })), { kind: 'provider-failure' });
  assert.equal(calls, 2);
});

test('missing Host capability blocks the required path while a description task still executes', async t => {
  const needsSkill = await sample(t, { description: 'Needs a Skill', requiredSkills: [{ id: 'reviewer' }] });
  const plain = await sample(t, { description: 'Plain task' });
  const unsupported = runtime({
    prepareAgentTask: async (task, context) => {
      assert.equal(task.task.requiredSkills, undefined);
      return { protocolVersion: 2, task, descriptionResources: context.descriptionResources, skills: [] };
    }
  });
  await assert.rejects(run(needsSkill.file, unsupported), { kind: 'capability-unavailable' });
  assert.equal((await run(plain.file, unsupported)).state.ok, true);
});

test('independent run authorization roots resolve identical references separately', async t => {
  const { file, dir } = await sample(t, { descriptionRefs: [{ uri: 'instruction.md', role: 'instruction' }] });
  const secondRoot = path.join(dir, 'second');
  await mkdir(secondRoot);
  await writeFile(path.join(dir, 'instruction.md'), 'First project');
  await writeFile(path.join(secondRoot, 'instruction.md'), 'Second project');
  const received = [];
  for (const projectRoot of [dir, secondRoot]) {
    await run(file, runtime({ taskPolicy: { projectRoot },
      async runAgentTask(task) { received.push(task.descriptionResources[0].content); return success(); } }));
  }
  assert.deepEqual(received, ['First project', 'Second project']);
});

test('the Host may not switch an approved Skill identity between attempts', async t => {
  const { file } = await sample(t, { description: 'Work', requiredSkills: [{ id: 'reviewer' }], retries: 2 });
  let dispatched = 0;
  const host = runtime({
    taskPolicy: { hostProfile: profile },
    async prepareAgentTask(task, context) {
      const version = dispatched ? '2.0.0' : '1.0.0';
      return { protocolVersion: 2, task, descriptionResources: context.descriptionResources,
        skills: [{ logicalId: 'reviewer', resolvedVersion: version, digest: hash(version) }] };
    },
    async runAgentTask() { dispatched++; return success({ ok: 'retry' }); }
  });
  await assert.rejects(run(file, host), { kind: 'invalid-preparation', message: /identity changed/ });
  assert.equal(dispatched, 1);
});

test('a stalled host observes the original deadline and cannot produce a late committed result', async t => {
  const { file, dir } = await sample(t, { description: 'Work' });
  const artifact = await compileArtifact(file);
  const entry = path.join(dir, 'workflow.js');
  await writeFile(entry, artifact.code);
  let late;
  await assert.rejects(runArtifact(entry, artifact.artifactHash, runtime({
    taskPolicy: { deadlineMs: Date.now() + 300 },
    runAgentTask(_task, context) {
      late = new Promise(resolve => {
        context.signal.addEventListener('abort', () => resolve(success()), { once: true });
      });
      const holdEventLoop = setTimeout(() => {}, 500);
      return late.finally(() => clearTimeout(holdEventLoop));
    }
  })), { name: 'TimeoutError' });
  assert.equal((await late).status, 'succeeded');
});

test('bounded Human loop rejects after the configured number of revisions', async t => {
  const { file } = await sample(t, { description: 'Unused' });
  await writeFile(file, `
import { defineWorkflow, human, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'approval', version: '1.0.0', name: 'Approval', nodes: [
  human('approve', { name: 'Approve', onApprove: 'done', onReject: 'repair', maxRevisions: 1 }),
  action('repair', { name: 'Repair', action: 'fix', next: 'approve' }),
  terminal('done', { name: 'Done', status: 'succeeded' })
] });`);
  let approvals = 0;
  let revisions = 0;
  await assert.rejects(run(file, runtime({
    async runHuman() { approvals++; return false; },
    async runAction() { revisions++; }
  })), { code: 'FK_R004', message: /revision limit/ });
  assert.equal(approvals, 2);
  assert.equal(revisions, 1);
});

test('formal workflow.js executes approved bytes without source or module type and rejects mismatches', async t => {
  const { file, dir } = await sample(t, { description: 'Work' });
  const artifact = await compileArtifact(file);
  const delivery = path.join(dir, 'delivery');
  await mkdir(delivery);
  const artifactFile = path.join(delivery, 'workflow.js');
  await writeFile(path.join(delivery, 'package.json'), '{"type":"commonjs"}');
  await writeFile(artifactFile, artifact.code);
  await unlink(file);
  const out = await runArtifact(artifactFile, artifact.artifactHash, runtime());
  assert.equal(out.state.ok, true);
  const unsupported = artifact.code.replace('"programAbiVersion":2', '"programAbiVersion":1');
  await writeFile(artifactFile, unsupported);
  await assert.rejects(runArtifact(artifactFile, artifact.artifactHash, runtime()), { code: 'FK_R001' });
  await assert.rejects(runArtifact(artifactFile, hash(unsupported), runtime()), { code: 'FK_R001' });
});
