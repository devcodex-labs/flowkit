import { createWorkflowAuthorHost } from '../../dist/host.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { planNewCollection } from '../../src/author/collections.mjs';

export const source = `import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'sample',version:'1.0.0',name:'Sample',nodes:[
action('work',{name:'Work',action:'inspect',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
export const proposal = { entryNodeId: 'work', nodes: [{ id: 'work', kind: 'action' }, { id: 'done', kind: 'terminal' }],
  edges: [{ from: 'work', to: 'done', kind: 'control' }], coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['work'] }] };
export const intent = { effective: { intents: [{ id: 'goal', goal: 'Inspect', understanding: 'clear', children: [], constraints: [] }],
  constraints: [], relations: [], coverage: 'complete', unresolved: [] }, turn: { changes: [], facts: {} }, issues: [], inferences: [], evidence: [] };
export const context = { namespace: 'test', principalId: 'user', sessionId: 'host-session', workspaceRef: 'project', collectionIds: ['team'] };

/** Controlled execution tests infrastructure, never real model quality or native Host discovery. */
export async function fixture(file, overrides = {}) {
  const calls = [], approvals = new Map();
  const options = { namespace: 'test', storageFile: file, collectionIds: ['team'],
    hostProfile: { id: 'controlled-host', digest: artifactDigest('controlled-host') }, defaults: { executionMode: 'standard' },
    execution: {
      async request(input) {
        calls.push(input);
        if (input.stage === 'intent') return structuredClone(intent);
        const id = input.prepared.task.node.id;
        const result = id === 'proposal' || id === 'plan-repair' ? { rawText: JSON.stringify(proposal) } :
          id === 'semantic-review' ? { passed: true, findings: [] } : { rawText: source };
        return { status: 'succeeded', result, events: [] };
      },
      async createSession(ports) {
        return { intentRuntime: { parse: request => ports.request({ stage: 'intent', request }) },
          runtime: { validateResult: () => [], runAgentTask: prepared => ports.request({ stage: 'agent', prepared }) } };
      }
    },
    authorization: { authorize: async () => true,
      async observeReview({ task, result }) {
        if (!calls.some(call => call.prepared?.task.execution.requestId === task.execution.requestId) || result.result.passed !== true) return null;
        return { passed: true, subjectId: 'review-executor', executionId: task.execution.requestId };
      },
      async verifyApproval(binding) {
        const approved = approvals.get(binding.approvalRef);
        return { approved: approved === binding.candidateHash, subjectId: 'user', approvalId: binding.approvalRef };
      },
      async verifySettlement() { return { verified: true, physicalDone: true, noEffect: true }; }
    }, ...overrides };
  const host = await createWorkflowAuthorHost(options);
  return { host, options, calls, approvals, async register() {
    const plan = planNewCollection({ name: 'team-workflows', source: { id: 'team' }, preserveId: true }, [], () => null);
    return host.createMcpOptions().applyCollectionPlan(plan, 'collection-approved', context);
  }, async start(extra = {}) {
    return host.start({ collectionId: 'team', requestId: 'start', goal: 'Inspect', target: { name: 'inspect', description: 'Inspect', version: '1.0.0' }, ...extra }, context);
  } };
}
