import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowAuthorHost } from '@devcodex-labs/flowkit/host';
import { runArtifact, isControlSignal } from '@devcodex-labs/flowkit';

// Controlled protocol example: no real model, native discovery or user approval is claimed.
export async function runAuthorExample() {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowkit-author-example-'));
  const context = { namespace: 'example', principalId: 'fixture-user', sessionId: 'fixture-session', workspaceId: 'example-project',
    authorizedCollections: ['team'], authorizationSnapshotRef: 'fixture-only-policy' };
  const plan = { entryNodeId: 'inspect', nodes: [{ id: 'inspect', kind: 'action' }, { id: 'done', kind: 'terminal' }],
    edges: [{ from: 'inspect', to: 'done', kind: 'control' }], coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['inspect'] }] };
  const intent = { effective: { intents: [{ id: 'goal', goal: 'Inspect', understanding: 'clear', children: [], constraints: [] }],
    constraints: [], relations: [], coverage: 'complete', unresolved: [] }, turn: { changes: [], facts: {} }, issues: [], inferences: [], evidence: [] };
  const source = `import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'example',version:'1.0.0',name:'Inspect',nodes:[
action('inspect',{name:'Inspect',action:'inspect',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
  const observed = new Set(); let host;
  try {
    host = await createWorkflowAuthorHost({ namespace: 'example', storageFile: path.join(directory, 'author.sqlite'), collectionIds: ['team'],
      hostProfile: { id: 'controlled-example', digest: 'sha256:' + 'a'.repeat(64) }, defaults: { executionMode: 'standard' },
      capacity: { maxPhysicalExecutions: 2, maxDrafts: 16, maxDraftBytes: 1048576, maxRetainedDraftBytes: 8388608,
        maxReceiptBytes: 8388608, maxTurnsPerDraft: 32 },
      authorization: { authorize: async ({ requestContext }) => requestContext.principalId === 'fixture-user',
        observeReview: async ({ task }) => observed.has(task.execution.requestId) ?
          { passed: true, subjectId: 'fixture-review-step', executionId: task.execution.requestId } : null,
        verifyApproval: async () => ({ approved: false, subjectId: 'fixture-user', approvalId: 'none' }) },
      execution: { async request(input) {
        if (input.stage === 'intent') return structuredClone(intent);
        const id = input.prepared.task.node.id;
        const result = id === 'proposal' ? { rawText: JSON.stringify(plan) } : id === 'semantic-review' ?
          { passed: true, findings: [] } : { rawText: source };
        observed.add(input.prepared.task.execution.requestId);
        return { status: 'succeeded', events: [], result };
      }, async createSession(ports) {
        return { intentRuntime: { parse: input => ports.request({ stage: 'intent', input }) },
          runtime: { validateResult: () => [], runAgentTask: prepared => ports.request({ stage: 'agent', prepared }) } };
      } } });
    const draft = await host.start({ collectionId: 'team', requestId: 'example-start', goal: 'Inspect',
      target: { name: 'inspect', description: 'Inspect', version: '1.0.0' } }, context);
    const ready = await host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion,
      turnId: 'example-turn', input: 'Inspect' }, context);
    assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
    assert.deepEqual(Object.keys(ready.candidate.files), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
    await assert.rejects(host.recordApproval({ draftId: ready.id, expectedStateVersion: ready.stateVersion,
      candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'model-said-yes' }, context));
    for (const [file, body] of Object.entries(ready.candidate.files)) await writeFile(path.join(directory, file), body);
    assert.equal((await host.close()).closed, true);
    // This explicit local fixture run is separate from publication and production execution authorization.
    const actions = [];
    const run = await runArtifact(path.join(directory, 'workflow.js'), ready.candidate.manifest.artifactHash,
      { isControlSignal, async runAction(action) { actions.push(action); } });
    assert.deepEqual(actions, ['inspect']); assert.equal(run.terminal, 'done');
    return { fixture: true, status: ready.status, files: Object.keys(ready.candidate.files), standalone: run.terminal, published: false };
  } finally { if (host) assert.equal((await host.close({ mode: 'cancel' })).closed, true); await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runAuthorExample()));
