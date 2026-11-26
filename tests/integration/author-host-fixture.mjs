import { createWorkflowAuthorHost } from '../../dist/host.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { planNewCollection } from '../../src/author/collections.mjs';

export const source = `import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'sample',version:'1.0.0',name:'Sample',nodes:[
action('work',{name:'Work',action:'inspect',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
export const proposal = { entryNodeId: 'work', nodes: [{ id: 'work', kind: 'action' }, { id: 'done', kind: 'terminal' }],
  edges: [{ from: 'work', to: 'done', kind: 'control' }], coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['work'] }] };
export const executableProposal = { ...proposal, edges: [], nodes: [
  { id: 'work', kind: 'action', name: 'Work', options: { action: 'inspect', next: 'done' } },
  { id: 'done', kind: 'terminal', name: 'Done', options: { status: 'succeeded' } }
] };
export const intent = { effective: { intents: [{ id: 'goal', goal: 'Inspect', understanding: 'clear', children: [], constraints: [] }],
  constraints: [], relations: [], coverage: 'complete', unresolved: [] }, turn: { changes: [], facts: {} }, issues: [], inferences: [], evidence: [] };
export const context = { namespace: 'test', principalId: 'user', sessionId: 'host-session', workspaceId: 'project', authorizedCollections: ['team'], authorizationSnapshotRef: 'controlled-permissions-v1' };

/** Controlled execution tests infrastructure, never real model quality or native Host discovery. */
export async function fixture(file, overrides = {}) {
  const calls = [], approvals = new Map();
  const options = { namespace: 'test', storageFile: file, collectionIds: ['team'],
    hostProfile: { id: 'controlled-host', digest: artifactDigest('controlled-host') }, defaults: { executionMode: 'standard' },
    capacity: { maxPhysicalExecutions: 4, maxDrafts: 256, maxDraftBytes: 8388608, maxRetainedDraftBytes: 67108864,
      maxReceiptBytes: 67108864, maxTurnsPerDraft: 256 },
    execution: {
      async request(input) {
        calls.push(input);
        if (input.stage === 'intent') return structuredClone(intent);
        const id = input.prepared.task.node.id;
        if (id.startsWith('document-') && overrides.documentTask) {
          return { status: 'succeeded', result: await overrides.documentTask(id, input.prepared.task.input), events: [] };
        }
        if (id === 'proposal' && overrides.documentPlanFallback) {
          return { status: 'failed', failure: { code: 'invalid-result', message: 'Incomplete Plan response',
            sideEffectStatus: 'none', retryable: false }, events: [] };
        }
        const plan = overrides.proposal ?? (input.prepared.task.input.authorizedRequest?.planSource === 'node-options' ? executableProposal : proposal);
        const result = id === 'proposal' || id === 'plan-repair' ? { rawText: JSON.stringify(plan) } :
          id === 'semantic-review' ? { passed: true, findings: [] } : { rawText: source };
        return { status: 'succeeded', result, events: [] };
      },
      async createSession(ports) {
        return { intentRuntime: { parse: request => ports.request({ stage: 'intent', request }) },
          runtime: { validateResult: () => [], runAgentTask: prepared => ports.request({ stage: 'agent', prepared }) } };
      }
    },
    authorization: { authorize: async () => true, resolveApplicableSafetyPolicies: () => [],
      async observeReview({ task, result }) {
        if (!calls.some(call => call.prepared?.task.execution.requestId === task.execution.requestId) || result.result.passed !== true) return null;
        return { passed: true, subjectId: 'review-executor', executionId: task.execution.requestId };
      },
      async verifyApproval(binding) {
        const approved = approvals.get(binding.approvalRef);
        return { approved: approved === binding.candidateHash, subjectId: 'user', approvalId: binding.approvalRef };
      },
      async verifySettlement(binding) { return { verified: true, physicalDone: true, noEffect: true,
        draftId: binding.draftId, turnId: binding.turnId, attemptId: binding.attemptId, evidenceRef: binding.evidenceRef, resultHash: binding.resultHash }; }
    }, ...overrides };
  if (overrides.capacity) options.capacity = { maxPhysicalExecutions: 4, maxDrafts: 256, maxDraftBytes: 8388608,
    maxRetainedDraftBytes: 67108864, maxReceiptBytes: 67108864, maxTurnsPerDraft: 256, ...overrides.capacity };
  const host = await createWorkflowAuthorHost(options);
  return { host, options, calls, approvals, async register() {
    const plan = planNewCollection({ name: 'team-workflows', source: { id: 'team' }, preserveId: true }, [], () => null);
    return host.createMcpOptions().applyCollectionPlan(plan, 'collection-approved', context);
  }, async start(extra = {}) {
    return host.start({ collectionId: 'team', requestId: 'start', goal: 'Inspect', target: { name: 'inspect', description: 'Inspect', version: '1.0.0' }, ...extra }, context);
  } };
}
