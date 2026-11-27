import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createIndependentAgentAdapter } from '../../src/host.mjs';

const task = (runId = 'run-a', artifactHash = 'artifact-a') => ({ task: { workflow: { artifactHash }, run: { runId },
  node: { id: 'work' }, execution: { requestId: 'request-a' }, input: { value: runId } } });
const binding = ({ artifactHash, runId, nodeId }) => ({ artifactHash, runId, nodeId, subjectId: runId,
  sessionId: runId, workspaceRef: runId, permissionRef: 'fixture-permissions',
  runAgentTask: async () => ({ status: 'succeeded', result: {}, events: [] }) });

test('independent agent rejects misspelled Host limits', () => {
  const options={scope:'fixture',select:binding,authorize:()=>true};
  assert.throws(()=>createIndependentAgentAdapter({...options,limits:{maxConcurent:1}}), /Unknown Independent Agent limit field/);
  assert.equal(createIndependentAgentAdapter({...options,limits:{maxConcurrent:1}}).status().activeExecutions,0);
});

test('two real worker processes receive separate Runs and working directories through Host routing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowkit-subjects-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  const workers = new Map();
  for (const runId of ['run-a', 'run-b']) {
    const cwd = path.join(root, runId);
    await mkdir(cwd);
    const child = fork(fileURLToPath(new URL('./independent-worker.mjs', import.meta.url)), [], {
      cwd, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    children.push(child);
    workers.set(runId, { child, cwd });
  }
  const adapter = createIndependentAgentAdapter({ scope: 'project-a', authorize: () => true,
    select: async request => {
      const { child, cwd } = workers.get(request.runId);
      return { ...binding(request), subjectId: `process-${child.pid}`, workspaceRef: cwd,
        async runAgentTask(prepared) {
          const reply = once(child, 'message');
          child.send(prepared);
          return (await reply)[0];
        } };
    } });
  const [first, second] = await Promise.all([adapter.runAgentTask(task('run-a')), adapter.runAgentTask(task('run-b'))]);
  assert.equal(first.status, 'succeeded');
  assert.equal(second.status, 'succeeded');
  assert.notEqual(first.result.pid, second.result.pid);
  assert.notEqual(first.result.cwd, second.result.cwd);
  assert.equal(first.result.value, 'run-a');
  assert.equal(second.result.value, 'run-b');
  assert.equal(first.events[0].runId, 'run-a');
  adapter.releaseRun('artifact-a', 'run-a');
  adapter.releaseRun('artifact-a', 'run-b');
  assert.deepEqual(adapter.status(), { activeExecutions: 0, sessionBindings: 0 });
});

test('same Node ID cannot reuse the wrong Artifact session or self-review subject', async () => {
  const adapter = createIndependentAgentAdapter({ scope: 'project', authorize: () => true,
    select: async request => ({ ...binding(request), sessionId: 'fixed-session' }) });
  assert.equal((await adapter.runAgentTask(task())).status, 'succeeded');
  const otherArtifact = await adapter.runAgentTask(task('run-a', 'artifact-b'));
  assert.equal(otherArtifact.failure.code, 'agent-binding-rejected');
  const reviewer = createIndependentAgentAdapter({ scope: 'project', authorize: () => true, select: async request => binding(request),
    independentFrom: () => ({ subjectId: 'run-a', sessionId: 'other', workspaceRef: 'other' }) });
  const rejected = await reviewer.runAgentTask(task());
  assert.match(rejected.failure.message, /independent review/);
  assert.equal(rejected.failure.sideEffectStatus, 'none');
});

test('cancelled or late work retains physical capacity until its actual completion', async () => {
  let finish;
  const adapter = createIndependentAgentAdapter({ scope: 'project', authorize: () => true,
    limits: { maxConcurrent: 1, timeoutMs: 20 }, select: async request => ({ ...binding(request),
      runAgentTask: () => new Promise(resolve => { finish = resolve; }) }) });
  const keepAlive = setTimeout(() => {}, 100);
  const result = await adapter.runAgentTask(task());
  clearTimeout(keepAlive);
  assert.equal(result.failure.code, 'agent-deadline');
  assert.equal(result.failure.sideEffectStatus, 'unknown');
  assert.equal(adapter.status().activeExecutions, 1);
  assert.throws(() => adapter.releaseRun('artifact-a', 'run-a'), /still active/);
  const blocked = await adapter.runAgentTask(task('run-b'));
  assert.equal(blocked.failure.code, 'agent-capacity');
  finish({ status: 'succeeded', result: { late: true }, events: [] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(adapter.status().activeExecutions, 0);
  assert.equal(result.status, 'failed');
  adapter.releaseRun('artifact-a', 'run-a');
});

test('denied or missing Host binding never dispatches the selected subject', async () => {
  const denied = createIndependentAgentAdapter({ scope: 'project', authorize: () => false,
    select: async request => ({ ...binding(request), runAgentTask: async () => assert.fail('Unauthorized Agent') }) });
  assert.equal((await denied.runAgentTask(task())).failure.sideEffectStatus, 'none');
  const missing = createIndependentAgentAdapter({ scope: 'project', authorize: () => true, select: async () => null });
  assert.match((await missing.runAgentTask(task())).failure.message, /incomplete/);
});
