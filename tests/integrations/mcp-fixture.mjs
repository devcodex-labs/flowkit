import { fileURLToPath } from 'node:url';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkflowAuthorHost } from '../../dist/host.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { planNewCollection } from '../../src/author/collections.mjs';
import { prepareProfessionalSkill, publishProfessionalSkill } from '../../src/author/professional-skills.mjs';
import { connectFlowkitStdio } from '../../src/mcp.mjs';
import { createWorkflowPlan } from '../../src/author/workflow-plan.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { runApprovedCollectionWorkflow } from '../../src/author/approved-run.mjs';
import { stageCollectionForDiscovery } from '../../src/author/collection-layout.mjs';
import { isControlSignal } from '../../src/index.mjs';

export async function fixtureOptions(file, collectionId = 'test-collection', namespace = 'test-project') {
  let authorized = true;
  const approved = new Map(), calls = [], controls = { barrier: null, intentGap: null, reviewFindings: [], recordWrite: null };
  const requestContext = { namespace, principalId: 'fixture-user', sessionId: 'fixture-session', workspaceId: path.dirname(file), authorizedCollections: [collectionId], authorizationSnapshotRef: 'fixture-permissions-v1' };
  const hostProfile = { id:'fixture-host',digest:artifactDigest('fixture host profile') };
  const sourceText = `import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[action('work',{name:'Work',action:'inspect',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
  const authorHost = await createWorkflowAuthorHost({ namespace, storageFile: file, collectionIds: [collectionId], hostProfile,
    capacity: { maxPhysicalExecutions: 4, maxDrafts: 256, maxDraftBytes: 8388608, maxRetainedDraftBytes: 67108864, maxReceiptBytes: 67108864, maxTurnsPerDraft: 256 },
    execution: { tool: () => controls.recordWrite(), async request(input) {
      calls.push(input);
      if (input.prepared && controls.barrier) await controls.barrier;
      if (input.intent) return { effective: { intents: [{ id: 'inspect', goal: 'Inspect', children: [], constraints: [] }], constraints: [], relations: [],
        coverage: controls.intentGap ? 'partial' : 'complete', unresolved: controls.intentGap ? [controls.intentGap] : [] },
      turn: { changes: [], facts: {} }, issues: [], inferences: [] };
      const id = input.prepared.task.node.id;
      const proposal = { entryNodeId:'work', nodes:[{id:'work',kind:'action'},{id:'done',kind:'terminal'}],
        edges:[{from:'work',to:'done',kind:'control'}], coverage:[{intentId:'inspect',status:'covered',coveredBy:['work']}] };
      return { status: 'succeeded', events: [], result: id === 'proposal' ? { rawText: JSON.stringify(proposal) } :
        id === 'semantic-review' ? { passed: controls.reviewFindings.length === 0, findings: controls.reviewFindings } : { rawText: sourceText } };
    }, async createSession(ports) { return { intentRuntime: { async parse(intent) {
      if (controls.recordWrite) await ports.tool({ effect: 'fixture-record' },
        { sideEffect: 'write', toolName: 'record', operationKey: 'fixture-write' });
      return ports.request({ intent });
    } },
      runtime: { validateResult: () => [], runAgentTask: prepared => ports.request({ prepared }) } }; } },
    authorization: { authorize: async ({ requestContext: context }) => authorized && context.principalId !== 'denied',
      resolveApplicableSafetyPolicies: () => [],
      async observeReview({ task, result }) { return calls.some(call => call.prepared?.task.execution.requestId === task.execution.requestId) && result.result.passed ?
        { passed: true, subjectId: 'fixture-executor', executionId: task.execution.requestId } : null; },
      async verifyApproval({ approvalRef, candidateHash }) { return { approved: approved.get(approvalRef) === candidateHash, subjectId: 'fixture-user', approvalId: approvalRef }; }
    } });
  const store = openLocalSkillStore(file, ({ approvalRef }) => approvalRef === 'fixture-approved', () => true);
  if (!store.readCollection(collectionId)) {
    const plan = planNewCollection({ name: 'fixture-flows', source: { id: collectionId }, preserveId: true }, [], () => null);
    store.applyCollectionPlan(plan, 'fixture-approved');
    const candidate = prepareProfessionalSkill(plan.destination, { id: 'review', name: 'fixture-review', version: '1.0.0',
      description: 'Review a synthetic workflow', body: '# Review test output', resources: { 'references/check.md': 'Inspect the terminal.' } });
    await publishProfessionalSkill(candidate, { reviewRef: 'fixture-review', approvalRef: 'fixture-approved', previousHash: null }, store);
  }
  const bindings = {
    async resolveAuthoringInput({ inputRef, requestContext: context }) {
      if(!inputRef.startsWith('fixture-input-')) throw new Error('Unknown input reference');
      const draftId = inputRef.slice('fixture-input-'.length), draft = await authorHost.readDraft({ draftId }, context);
      return { draftId, expectedStateVersion: draft.stateVersion, turnId: 'fixture-turn', input: 'Inspect the synthetic result',
        choices: { executionMode: 'standard' }, target: { name: 'test-workflow' } };
    },
    async runWorkflow({ collectionId, skillId, candidateHash, executionRef }) {
      const snapshot = await stageCollectionForDiscovery(store,collectionId,path.join(path.dirname(file),'installed'));
      return runApprovedCollectionWorkflow(store,{collectionId,skillId,candidateHash,executionRef,
        skillDirectory:path.join(snapshot.directory,'skills','test-workflow')},
        {hostProfile,authorizeExecution:()=>executionRef === 'fixture-execution',resolveApplicableSafetyPolicies:()=>[],
          runtime:{isControlSignal,runAction:async()=>{}}});
    },
    limits: { pageSize: 1, maxResourceBytes: 4096 } };
  const optionsFor = context => ({ ...authorHost.createMcpOptions(context, bindings), store });
  const options = optionsFor(requestContext);
  return { options, optionsFor, authorHost, requestContext, calls, controls, approve: (reference, candidateHash) => approved.set(reference, candidateHash),
    close: async () => { await authorHost.close({ mode: 'cancel' }); store.close(); }, revoke: () => { authorized = false; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await fixtureOptions(process.argv[2]);
  if (process.argv[3] === 'write-without-result') {
    fixture.controls.recordWrite = () => appendFile(process.argv[2] + '.writes', 'written\n');
  }
  const server = await connectFlowkitStdio(fixture.options);
  server.server.onclose = () => { fixture.close(); };
}
