import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkflowAuthor } from '../../src/author/author.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { planNewCollection } from '../../src/author/collections.mjs';
import { prepareProfessionalSkill, publishProfessionalSkill } from '../../src/author/professional-skills.mjs';
import { connectFlowkitStdio } from '../../src/mcp.mjs';
import { createWorkflowPlan } from '../../src/author/workflow-plan.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { runApprovedCollectionWorkflow } from '../../src/author/approved-run.mjs';
import { stageCollectionForDiscovery } from '../../src/author/collection-layout.mjs';
import { isControlSignal } from '../../src/index.mjs';

export async function fixtureOptions(file, collectionId = 'test-collection') {
  const store = openLocalSkillStore(file, ({ approvalRef }) => approvalRef === 'fixture-approved', () => true);
  if (!store.readCollection(collectionId)) {
    const plan = planNewCollection({ name: 'fixture-flows', source: { id: collectionId }, preserveId: true }, [], () => null);
    store.applyCollectionPlan(plan, 'fixture-approved');
    const candidate = prepareProfessionalSkill(plan.destination, { id: 'review', name: 'fixture-review', version: '1.0.0',
      description: 'Review a synthetic workflow', body: '# Review test output', resources: { 'references/check.md': 'Inspect the terminal.' } });
    await publishProfessionalSkill(candidate, { reviewRef: 'fixture-review', approvalRef: 'fixture-approved', previousHash: null }, store);
  }
  let authorized = true;
  const author = createWorkflowAuthor({ publicationHost: store });
  const sourceFile = path.join(path.dirname(file), 'sample.workflow.js');
  await writeFile(sourceFile, `import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[
action('work',{name:'Work',action:'inspect',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`);
  const draft = author.start('Inspect the synthetic result', { executionMode: 'standard' });
  const plan = createWorkflowPlan(draft, { intentRef: { effectiveIntentHash: artifactDigest('fixture intent') },
    coverage: 'complete', issues: [], unresolved: [], goals: [{id:'inspect'}], constraints: [] }, {
    entryNodeId:'work', nodes:[{id:'work',kind:'action'},{id:'done',kind:'terminal'}],
    edges:[{from:'work',to:'done',kind:'control'}], coverage:[{intentId:'inspect',status:'covered',coveredBy:['work']}] });
  const hostProfile = { id:'fixture-host',digest:artifactDigest('fixture host profile') };
  const options = { namespace: 'test-project', collectionIds: [collectionId], store,
    author, authorize: () => authorized,
    async resolveCompileInput({ inputRef }) {
      if(inputRef !== 'fixture-input') throw new Error('Unknown input reference');
      return {plan, options:{file:sourceFile,collectionId,skillId:'workflow',name:'test-workflow',description:'Inspect a fixture',version:'1.0.0',hostProfile,buildId:'fixture-build'}};
    },
    async runWorkflow({ collectionId, skillId, candidateHash, executionRef }) {
      const snapshot = await stageCollectionForDiscovery(store,collectionId,path.join(path.dirname(file),'installed'));
      return runApprovedCollectionWorkflow(store,{collectionId,skillId,candidateHash,executionRef,
        skillDirectory:path.join(snapshot.directory,'skills','test-workflow')},
        {hostProfile,authorizeExecution:()=>executionRef === 'fixture-execution',runtime:{isControlSignal,runAction:async()=>{}}});
    },
    pendingCandidates: new Map(), limits: { pageSize: 1, maxResourceBytes: 1024 } };
  return { options, close: () => store.close(), revoke: () => { authorized = false; } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await fixtureOptions(process.argv[2]);
  const server = await connectFlowkitStdio(fixture.options);
  server.server.onclose = () => { fixture.close(); };
}
