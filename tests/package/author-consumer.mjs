import assert from 'node:assert/strict';
import { createWorkflowAuthorHost } from '@devcodex-labs/flowkit/host';
import { runArtifact, isControlSignal } from '@devcodex-labs/flowkit';
import { writeFile } from 'node:fs/promises';

const context = { namespace: 'installed', principalId: 'user', sessionId: 'local', workspaceRef: 'consumer', collectionIds: ['team'] };
const hash = 'sha256:' + 'a'.repeat(64);
const plan = { entryNodeId: 'done', nodes: [{ id: 'done', kind: 'terminal' }], edges: [],
  coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['done'] }] };
const intent = { effective: { intents: [{ id: 'goal', goal: 'Done', children: [], constraints: [] }],
  constraints: [], coverage: 'complete', relations: [], unresolved: [] }, turn: { changes: [], facts: {} }, issues: [], inferences: [] };
const host = await createWorkflowAuthorHost({ namespace: 'installed', storageFile: 'installed-author.sqlite', collectionIds: ['team'],
  hostProfile: { id: 'controlled-installed-fixture', digest: hash }, defaults: { executionMode: 'standard' },
  authorization: { authorize: async () => true, observeReview: async ({ task }) => ({ passed: true, subjectId: 'controlled-review', executionId: task.execution.requestId }),
    verifyApproval: async () => ({ approved: false, subjectId: 'user', approvalId: 'none' }) },
  execution: { async request(input) {
    if (input.intent) return intent;
    const id = input.task.task.node.id;
    return { status: 'succeeded', events: [], result: id === 'proposal' ? { rawText: JSON.stringify(plan) } :
      id === 'semantic-review' ? { passed: true, findings: [] } : { rawText: `import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'installed',version:'1.0.0',name:'Installed',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});` } };
  }, async createSession(ports) { return { intentRuntime: { parse: input => ports.request({ intent: input }) },
    runtime: { validateResult: () => [], runAgentTask: task => ports.request({ task }) } }; } } });
try {
  const draft = await host.start({ collectionId: 'team', requestId: 'first', goal: 'Done', target: { name: 'installed', description: 'Installed', version: '1.0.0' } }, context);
  const ready = await host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Done' }, context);
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(Object.keys(ready.candidate.files).length, 3);
  await writeFile('workflow.js', ready.candidate.files['workflow.js']);
  await host.close();
  // The delivered target executes using the public Runtime after its Author is closed.
  assert.equal((await runArtifact('workflow.js', ready.candidate.manifest.artifactHash, { isControlSignal })).terminal, 'done');
} finally { await host.close({ mode: 'cancel' }); }
