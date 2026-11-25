import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, context, executableProposal } from './author-host-fixture.mjs';
import { authorDocumentWork, splitAuthorMaterials } from '../../src/author/document-work.mjs';
import { budgetPolicy, createTurnPorts, newTurnBudget } from '../../src/author/host-budget.mjs';
import { createApiAgentAdapter } from '../../src/host/api-agent.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { executionContracts, pinExecutionContracts } from '../../src/author/execution-contracts.mjs';
import { materializePlan } from '../../src/author/workflow-plan.mjs';
import { publicDelivery, newExportKey, readPortableExport, exportTrust } from '../../scripts/local-mcp-artifacts.mjs';
import { readWorkflowPageData } from '../../scripts/workflow-viewer.mjs';

async function setup(t, overrides) {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowkit-author-host-'));
  const result = await fixture(path.join(directory, 'author.sqlite'), overrides);
  t.after(async () => { await result.host.close({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }); });
  return { ...result, directory };
}
async function candidate(f) {
  const draft = await f.start();
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'turn', input: 'Inspect' }, context);
}

test('Author pins trusted callbacks, exports exact node notes and closes omitted nested output objects', async t => {
  const implementationDigest = artifactDigest('isolated inspect implementation');
  const hostExecutionContracts = [{ id:'inspect', version:'fixture-1', kind:'action', effect:'read-only',
    reads:[], writes:['report'], roles:['operator'], implementationDigest, rules:['Result contains the recorded outcome.'] }];
  const proposal = structuredClone(executableProposal);
  proposal.nodes[0].description = 'Inspect the recorded outcome and write a typed report.';
  proposal.nodes[0].requiredRole = { id:'operator', label:'Operator' };
  Object.assign(proposal.nodes[0].options, { writes:['report'] });
  proposal.nodes[1].description = 'The report is ready for the caller.';
  proposal.contract = { output:{ type:'object', properties:{ report:{ type:'array', items:{
    type:'object', properties:{ ready:{type:'boolean'} }, required:['ready']
  } } }, required:['report'] } };
  const f = await setup(t,{ useNodeOptionsForNewDrafts:true, hostExecutionContracts, proposal });
  await f.register();
  const draft = await f.start();
  const { candidate, status, diagnostics } = await f.host.advanceTurn({ draftId:draft.id, expectedStateVersion:draft.stateVersion,
    turnId:'compile-notes', input:'Inspect and return the typed report' }, context);
  assert.equal(status,'candidate-ready',JSON.stringify(diagnostics));
  assert.equal(candidate.manifest.workflowDefinition.contract.output.properties.report.items.additionalProperties,false);
  assert.equal(candidate.manifest.nodeExecutionContracts[0].id,'inspect');
  const review = f.calls.find(call=>call.prepared?.task.node.id==='semantic-review');
  assert.equal(review.prepared.task.input.candidateDiff.compilerEvidence.hostExecutionContracts.pins[0].digest,
    candidate.manifest.nodeExecutionContracts[0].digest);
  const key=newExportKey(), files=publicDelivery(candidate,key);
  const graph=readWorkflowPageData(files['workflow.html']);
  assert.deepEqual(graph.layout.nodes.map(node=>node.description),proposal.nodes.map(node=>node.description));
  assert.equal(readPortableExport(files,exportTrust([key.publicKey])).candidate.hash,candidate.hash);
  const { runApprovedCollectionWorkflow } = await import('../../dist/host.mjs');
  const store = { readVersion:()=>candidate };
  const target={ collectionId:'team',skillId:candidate.manifest.skillId,candidateHash:candidate.hash,
    skillDirectory:f.directory,executionRef:'check-exact-implementation' };
  await writeFile(path.join(f.directory,'workflow.js'),candidate.files['workflow.js']);
  let dispatched=0;
  const host={hostProfile:candidate.manifest.hostProfile,authorizeExecution:()=>true,runtime:{
    isControlSignal:()=>false,
    runAction(id,label,ctx){assert.equal(id,'inspect');dispatched++;ctx.state.report=[{ready:true}];}
  }};
  await assert.rejects(runApprovedCollectionWorkflow(store,target,host,{}),/execution contracts differ/);
  await assert.rejects(runApprovedCollectionWorkflow(store,target,{...host,
    hostExecutionContracts:[{...hostExecutionContracts[0],implementationDigest:artifactDigest('drifted implementation')}]},{}),/execution contracts differ/);
  const ran=await runApprovedCollectionWorkflow(store,target,{...host,hostExecutionContracts},{});
  assert.equal(ran.status,'succeeded');
  assert.equal(dispatched,1);
});

test('compiled action dispatch must match trusted result cases, including branch order and unknown state', async () => {
  const action = (id, options) => ({ id, kind:'action', name:id, options:{ action:id, ...options } });
  const plan = { entryNodeId:'persist', nodes:[
    action('persist',{ writes:['outcome'], next:'choose' }),
    { id:'choose', kind:'condition', name:'Choose', options:{ branches:[
      { when:"outcome === 'closed'", next:'notify' }, { when:'true', next:'failed' }
    ] } },
    action('notify',{ next:'done', writes:[] }),
    { id:'done',kind:'terminal',name:'Done',options:{status:'succeeded'} },
    { id:'failed',kind:'terminal',name:'Failed',options:{status:'failed'} }
  ] };
  plan.contract={input:{type:'object',properties:{other:{type:'string'}},required:['other'],additionalProperties:false}};
  const draft={target:{name:'outcome-test',version:'1.0.0'},choices:{executionMode:'standard'}};
  const compilerOptions={filename:'outcome-test.workflow.js'};
  const contract = (id, writes) => ({ id, kind:'action', version:'1', implementationDigest:artifactDigest(id),
    effect:'write', reads:[], writes, rules:['Isolated test callback.'] });
  const persist={ ...contract('persist',['outcome']), resultRoutes:{ key:'outcome', cases:[
    { value:'closed', next:{ kind:'action',id:'notify' } },
    { value:'invalid', next:{ kind:'terminal',status:'failed' } }
  ] } };
  const catalog=executionContracts([persist,contract('notify',[])]);
  const { definition }=await materializePlan(draft,plan,compilerOptions);
  assert.ok(definition);
  assert.equal(pinExecutionContracts(definition,catalog)[0].digest,catalog[0].digest);
  const verifyWrongRoute = async branches => {
    const proposal=structuredClone(plan);
    proposal.nodes[1].options.branches=branches;
    const result=await materializePlan(draft,proposal,compilerOptions);
    assert.ok(result.definition,JSON.stringify(result.diagnostics));
    assert.throws(()=>pinExecutionContracts(result.definition,catalog),
      { code:'FKA_EXECUTION_CONTRACT',nodeId:'persist',message:/closed.*Action notify/ });
  };
  await verifyWrongRoute([{when:"outcome === 'complete'",next:'notify'},{when:'true',next:'failed'}]);
  await verifyWrongRoute([{when:"outcome !== 'invalid'",next:'failed'},
    {when:"outcome === 'closed'",next:'notify'},{when:'true',next:'failed'}]);
  await verifyWrongRoute([{when:"other === 'allow' && outcome === 'closed'",next:'notify'},{when:'true',next:'failed'}]);
  const duplicate=structuredClone(persist);
  duplicate.resultRoutes.cases.push(duplicate.resultRoutes.cases[0]);
  assert.throws(()=>executionContracts([duplicate]),{code:'FKA_EXECUTION_CONTRACT'});
});

test('long-document fallback retries malformed assumptions, completes omitted coverage and preserves gaps', async () => {
  const calls=[];
  const work=authorDocumentWork({context:{materials:[{id:'spec',title:'Contract',content:'Constraint text.\n'.repeat(1600)}]},
    request:{input:'Outline the workflow'},readStep:()=>null,saveStep(){},
    async runModel(kind,_instruction,input) {
      calls.push(kind);
      if (kind==='outline') return { value:{entryNodeId:'done',nodes:[{id:'done',kind:'terminal',name:'Done',purpose:'Finish'}],
        assumptions:input.previousError?[{id:'fixture',statement:'Use an isolated fixture',requiresConfirmation:false}]:['Use an isolated fixture'],
        coverage:[{intentId:'goal',status:'covered',coveredBy:['done']}]},execution:{} };
      if (kind==='coverage') {
        assert.deepEqual(input.requirements.map(item=>item.id),['known','missing']);
        return {value:{coverage:[{intentId:'known',status:'covered',coveredBy:['done']},
          {intentId:'missing',status:'gap',coveredBy:[]}]},execution:{}};
      }
      assert.equal(kind,'fragment');
      return {value:{nodes:[{id:'done',options:{status:'succeeded'}}]},execution:{}};
    }
  });
  const plan=await work.plan({authorizedRequest:{input:'Outline the workflow'},effectiveIntent:{
    goals:[{id:'goal',goal:'Finish'}],constraints:[{id:'known',statement:'Finish'},{id:'missing',statement:'Missing capability'}]
  }},'Build the plan');
  assert.deepEqual(calls,['outline','outline','coverage','fragment']);
  assert.equal(plan.assumptions[0].requiresConfirmation,false);
  assert.deepEqual(plan.coverage.map(({intentId,status})=>[intentId,status]),
    [['goal','covered'],['known','covered'],['missing','gap']]);
});

test('a guarded provider failure survives adapter handling without authorizing bypassed execution', async () => {
  const failure=Object.assign(new Error('Provider rejected the request'),{code:'PROVIDER_REQUEST_FAILED'});
  const turn={status:'running',executionToken:'owned',budget:newTurnBudget(budgetPolicy())};
  const ports=createTurnPorts({changeTurn(operation){return operation(turn);},signal:new AbortController().signal,
    requestContext:{principalId:'author',workspaceId:'local'},execution:{async request(){throw failure;}},
    track(){},beforeDispatch(){}});
  await assert.rejects(ports.observeModel(async()=>{
    await assert.rejects(ports.request({task:'draft'}),error=>error===failure);
    return {status:'failed'};
  }),error=>error===failure);
  await assert.rejects(ports.observeModel(async()=>({status:'succeeded'})),{code:'author-unobserved'});
});

test('preflight and outstanding adapter abort keep their phase and are never accepted as model success', async () => {
  const outer = new AbortController(), taskSignal = new AbortController();
  const turn = { status: 'running', executionToken: 'owned', budget: newTurnBudget(budgetPolicy()) };
  let received, finish, physical;
  const ports = createTurnPorts({ changeTurn(operation) { return operation(turn); }, signal: outer.signal,
    requestContext: { principalId: 'author', workspaceId: 'local' }, track(promise) { physical = promise; promise.catch(() => {}); },
    beforeDispatch() {}, execution: { request(_body, { signal }) {
      received = signal;
      return new Promise(resolve => {
        finish = resolve;
        taskSignal.abort();
      });
    } } });
  const adapter = createApiAgentAdapter({ scope: 'fixture', model: 'fixture', request: ports.request, supportsTools: false });
  const task = deadlineMs => ({ task: { execution: { requestId: 'fixture', deadlineMs } }, descriptionResources: [], skills: [] });
  await assert.rejects(ports.observeModel(() => adapter.runAgentTask(task(Date.now() - 1)), 'preflight'),
    { code: 'FKA_MODEL_REQUEST_NOT_COMPLETED', message: /preflight: before guarded request \(adapter: deadline-exceeded\)/ });
  assert.equal(turn.budget.used.requests, 0);
  await assert.rejects(ports.observeModel(() => adapter.runAgentTask(task(Date.now() + 10000), { signal: taskSignal.signal }), 'in-flight'),
    { code: 'FKA_MODEL_REQUEST_NOT_COMPLETED', message: /in-flight: request not completed \(adapter: cancelled\)/ });
  assert.equal(received.aborted, true);
  assert.equal(outer.signal.aborted, false);
  const [reservation] = Object.values(turn.budget.reservations);
  assert.equal(reservation.status, 'unknown');
  finish(Response.json({ status: 'completed' }));
  await physical;
  assert.equal(reservation.status, 'late-completed');
});

test('section inventory preserves original UTF-8 bytes across repeated headings, tables and fenced examples', () => {
  const lines = '# 契约\r\n## 相同标题\r\n' + '| 名称 | 要求 |\r\n|---|---|\r\n' + '| 验收 | 通过后交接 |\r\n'.repeat(450) +
    '~~~md\r\n' + '# 这个行不是章节\r\n'.repeat(800) + '~~~\r\n## 相同标题\r\n最后一行';
  const original = Buffer.from(lines);
  const { sources, sections } = splitAuthorMaterials({ materials: [{ id: 'terms', title: 'Terms', content: lines }] });
  assert.equal(sources[0].byteLength, original.length);
  assert.equal(sections[0].from, 0);
  assert.equal(sections.at(-1).to, original.length);
  for (const [index, section] of sections.entries()) {
    assert.equal(section.from, sections[index - 1]?.to ?? 0);
    assert.equal(section.text, original.subarray(section.from, section.to).toString());
    assert.ok(!section.headingPath.includes('这个行不是章节'));
  }
  assert.ok(sections.some(item => item.continued?.tableHeader));
  assert.ok(sections.some(item => item.continued?.codeFence));
});

test('document work is admitted early, persists verified sections and fences an omitted chapter or missing source', async t => {
  let rejectChapter = true;
  const f = await setup(t, { useNodeOptionsForNewDrafts: true, documentPlanFallback: true, documentTask(kind, input) {
    if (kind === 'document-extract') return { sectionId: input.id, classification: 'mixed', rules: ['Inspect each section'], links: [] };
    if (kind === 'document-merge') return { rules: ['Inspect and validate results across all sections'], links: ['chapter 1 → chapter 3'] };
    if (kind === 'document-outline') return { ...executableProposal, nodes: executableProposal.nodes.map(({ id, kind, name }) =>
      ({ id, kind, name, purpose: name })) };
    if (kind === 'document-fragment') return { nodes: executableProposal.nodes.map(({ id, options }) => ({ id, options })) };
    assert.equal(kind, 'document-review');
    const passed = !rejectChapter || input.source.id !== 'part-2';
    return { sectionId: input.source.id, candidateHash: input.candidateHash, passed, nodeIds: ['work'],
      findings: passed ? [] : [{ message: 'Missing independently reviewed section rule', nodeIds: ['work'] }] };
  } });
  await f.register();
  const draft = await f.start();
  const snapshot = { materials: [{ id: 'contract', title: 'Contract',
    content: '# Chapter 1\n' + 'A real contract statement.\n'.repeat(320) + '## Chapter 2\n' +
      'A connected external acceptance rule.\n'.repeat(320) + '## Chapter 3\n' + 'Validate results.\n'.repeat(320) }] };
  const turn = { draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'document', input: 'Inspect', contextSnapshot: snapshot };
  const queued = await f.host.createMcpOptions(context).queueAuthoringTurn(turn, context);
  assert.equal(queued.status, 'running');
  let rejected;
  for (let index = 0; index < 300; index++) {
    rejected = await f.host.readDraft({ draftId: draft.id }, context);
    if (rejected.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(rejected.status, 'needs-revision', JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.reviewReceipt, null);
  assert.equal(rejected.documentProgress.extracted, rejected.documentProgress.sections);
  assert.ok(rejected.reviewRejection?.findings.some(item => item.rule === 'document:part-2'), JSON.stringify(rejected.diagnostics));
  assert.equal((await f.host.createMcpOptions(context).queueAuthoringTurn(turn, context)).status, 'needs-revision');
  const rejectedHash = rejected.candidate.hash;
  const missing = await f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: rejected.stateVersion,
    turnId: 'missing', kind: 'review-only', input: 'Review', candidateHash: rejectedHash }, context);
  assert.equal(missing.status, 'needs-revision');
  assert.match(JSON.stringify(missing.diagnostics), /reauthorize/i);
  await f.host.close();
  const { createWorkflowAuthorHost } = await import('../../dist/host.mjs');
  const reopened = await createWorkflowAuthorHost(f.options);
  try {
    rejectChapter = false;
    const reads = f.calls.filter(item => item.prepared?.task.node.id === 'document-extract').length;
    const ready = await reopened.advanceTurn({ ...turn, expectedStateVersion: missing.stateVersion,
      turnId: 'reopened', input: 'Inspect the confirmed document' }, context);
    assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
    assert.equal(f.calls.filter(item => item.prepared?.task.node.id === 'document-extract').length, reads);
    assert.equal(ready.reviewReceipt.document.sections.length, ready.documentProgress.sections);
    assert.ok(ready.reviewReceipt.document.sections.every(item => item.passed && item.execution.requestId));
  } finally { await reopened.close(); }
});

test('I1 installed core performs actual parse/Plan/compile/review and atomically saves exact approved three-file candidate', async t => {
  const f = await setup(t); await f.register();
  const start = await f.start(); assert.equal(f.calls.length, 0);
  const input = { draftId: start.id, expectedStateVersion: start.stateVersion, turnId: 'turn', input: 'Inspect' };
  const ready = await f.host.advanceTurn(input, context);
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.deepEqual(Object.keys(ready.candidate.files), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  assert.equal(ready.reviewReceipt.qualified, true);
  const calls = f.calls.length;
  const replay = await f.host.advanceTurn(input, context); assert.deepEqual(replay, ready); assert.equal(f.calls.length, calls);
  await assert.rejects(f.host.advanceTurn({ ...input, contextSnapshot: { changed: true } }, context), /different bound material/);
  const review = await f.host.reviewCandidate({ draftId: ready.id, candidateHash: ready.candidate.hash, previousHash: null }, context);
  assert.equal(review.receipt.reviewRef, ready.reviewReceipt.reviewRef);
  const approval = { draftId: ready.id, expectedStateVersion: (await f.host.readDraft({ draftId: ready.id }, context)).stateVersion,
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: review.receipt.reviewRef, approvalRef: 'user-approved' };
  await assert.rejects(f.host.recordApproval(approval, context), /explicit user approval/);
  f.approvals.set(approval.approvalRef, ready.candidate.hash);
  const approved = await f.host.recordApproval(approval, context);
  const publication = { ...approval, expectedStateVersion: approved.stateVersion, publicationId: 'save-1' };
  await assert.rejects(f.host.publish({ ...publication, candidateHash: 'wrong' }, context), /exact review/);
  const saved = await f.host.publish(publication, context); assert.equal(saved.status, 'saved'); assert.equal(saved.discovery, 'pending');
  assert.equal(saved.collectionSnapshot, undefined);
  const replaySave = await f.host.publish(publication, context); assert.equal(replaySave.currentActive, ready.candidate.hash);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'), { readOnly: true });
  try {
    const durable = JSON.parse(db.prepare('SELECT payload FROM fk_author_drafts WHERE draft_id=?').get(ready.id).payload);
    assert.equal(durable.savedReceipt.candidateHash, ready.candidate.hash);
    assert.equal(durable.savedReceipt.collectionSnapshot.skills[0].hash, ready.candidate.hash);
    assert.equal(db.prepare('SELECT count(*) AS total FROM fk_author_versions').get().total, 1);
    const turn = JSON.parse(db.prepare('SELECT payload FROM fk_author_turns').get().payload);
    assert.equal(turn.budget.used.requests, 4); assert.equal(turn.budget.repairs.length, 0);
  } finally { db.close(); }
});

test('I1 rejects wrong namespace, unowned file and opaque unobserved execution without modifying foreign bytes', async t => {
  const f = await setup(t);
  const draft = await f.start();
  await assert.rejects(f.host.readDraft({ draftId: draft.id }, { ...context, namespace: 'other' }), /namespace/);
  const { createWorkflowAuthorHost } = await import('../../dist/host.mjs');
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, namespace: 'other' }), /namespace or schema differs/);
  const foreign = path.join(f.directory, 'foreign.sqlite');
  const db = new DatabaseSync(foreign); db.exec('CREATE TABLE users (id INTEGER)'); db.close();
  const before = await readFile(foreign);
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, storageFile: foreign }), /no such table|namespace|schema/);
  assert.deepEqual(await readFile(foreign), before);
  const invalid = path.join(f.directory, 'not-a-database'); await writeFile(invalid, 'user material');
  await assert.rejects(createWorkflowAuthorHost({ ...f.options, storageFile: invalid }), /database/);
  assert.equal((await readFile(invalid)).toString(), 'user material');
});

test('I1 finite per-turn request budget stops before extra model dispatch', async t => {
  const f = await setup(t, { budgetPolicy: { maxRequests: 1 } });
  const ready = await candidate(f);
  assert.equal(ready.status, 'needs-revision'); assert.equal(f.calls.length, 1); assert.equal(ready.candidate, undefined);
  assert.match(JSON.stringify(ready.diagnostics), /budget/);
});

test('I1 opaque Intent, invalid TaskV2 envelope, unqualified review and shared technical repair limits never publish', async t => {
  for (const failure of ['opaque', 'envelope', 'review', 'repair']) {
    const f = await setup(t);
    if (failure === 'opaque') f.options.execution.createSession = async () => ({ intentRuntime: { parse: async () => ({}) }, runtime: { runAgentTask: async () => ({}), validateResult: () => [] } });
    if (failure === 'envelope') {
      const request = f.options.execution.request;
      f.options.execution.request = async input => input.stage === 'agent' ? { status: 'succeeded', result: { rawText: '{}' } } : request(input);
    }
    if (failure === 'review') f.options.authorization.observeReview = async () => null;
    if (failure === 'repair') {
      const request = f.options.execution.request;
      f.options.execution.request = async input => input.prepared?.task.node.id !== 'semantic-review' && input.stage === 'agent' ?
        (f.calls.push(input), { status: 'succeeded', result: { rawText: 'broken' }, events: [] }) : request(input);
    }
    const result = await candidate(f);
    assert.notEqual(result.status, 'candidate-ready', failure);
    assert.ok(!result.reviewReceipt, failure);
    const current = await f.host.readDraft({ draftId: result.id }, context);
    await assert.rejects(f.host.publish({ draftId: result.id, expectedStateVersion: current.stateVersion,
      candidateHash: result.candidate?.hash ?? 'missing', previousHash: null, reviewRef: 'fake', approvalRef: 'fake', publicationId: 'fake' }, context), /exact review/);
    if (failure === 'repair') assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'plan-repair').length, 2);
  }
});

test('I1 a real SQLite fault after formal version writes rolls back active, version and draft receipt together', async t => {
  const f = await setup(t); await f.register();
  const ready = await candidate(f);
  f.approvals.set('user', ready.candidate.hash);
  const identity = { draftId: ready.id, candidateHash: ready.candidate.hash, previousHash: null,
    reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'user' };
  const approved = await f.host.recordApproval({ ...identity, expectedStateVersion: (await f.host.readDraft({ draftId: ready.id }, context)).stateVersion }, context);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'));
  try {
    db.exec("CREATE TRIGGER cut_saved BEFORE UPDATE ON fk_author_drafts WHEN NEW.status='saved' BEGIN SELECT RAISE(ABORT, 'cut-after-version'); END;");
    const input = { ...identity, expectedStateVersion: approved.stateVersion, publicationId: 'atomic' };
    await assert.rejects(f.host.publish(input, context), /cut-after-version/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_versions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_active').get().n, 0);
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).savedReceipt, undefined);
    db.exec('DROP TRIGGER cut_saved');
    assert.equal((await f.host.publish(input, context)).status, 'saved');
  } finally { db.close(); }
});

test('I3 precise Host approval registration and publication share a single rollback boundary', async t => {
  const f = await setup(t); await f.register(); const ready = await candidate(f);
  const input = { draftId: ready.id, expectedStateVersion: ready.stateVersion, publicationId: 'atomic-approval',
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'user' };
  f.approvals.set('user', ready.candidate.hash);
  const db = new DatabaseSync(path.join(f.directory, 'author.sqlite'));
  try {
    db.exec("CREATE TRIGGER cut_approval_save BEFORE UPDATE ON fk_author_drafts WHEN NEW.status='saved' BEGIN SELECT RAISE(ABORT, 'cut-approved-save'); END;");
    await assert.rejects(f.host.publish(input, context), /cut-approved-save/);
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).approvalReceipt, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fk_author_versions').get().n, 0);
    db.exec('DROP TRIGGER cut_approval_save');
    assert.equal((await f.host.publish(input, context)).status, 'saved');
    assert.equal((await f.host.readDraft({ draftId: ready.id }, context)).approvalReceipt.approvalRef, 'user');
  } finally { db.close(); }
});

test('I3 owner-specific authorization covers read, cancel, settle, discard and every model/Graph/document port', async t => {
  const f = await setup(t); const draft = await f.start();
  const other = { ...context, principalId: 'other' };
  let allowed = true;
  f.options.authorization.authorize = async ({ ownerScope, requestContext }) => allowed && (!ownerScope || ownerScope.principalId === requestContext.principalId);
  for (const name of ['readDraft', 'cancelTurn', 'settleTurn', 'discard']) {
    await assert.rejects(f.host[name]({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'none', candidateHash: null }, other), /denied/);
  }
  const raw = f.options.execution.request;
  f.options.execution.request = async input => { const result = await raw(input); allowed = false; return result; };
  await assert.rejects(f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'revoke', input: 'Inspect' }, context), /denied/);
  assert.equal(f.calls.length, 1);
});
