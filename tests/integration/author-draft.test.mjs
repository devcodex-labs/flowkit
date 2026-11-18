import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAuthorDraft, checkPlanCapabilities, startAuthorDraft } from '../../src/author/draft.mjs';
import { createWorkflowPlan } from '../../src/author/workflow-plan.mjs';
import { createWorkflowAuthor } from '../../src/author/author.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';

test('one sentence starts the draft and known project choices do not trigger questions', () => {
  const first = startAuthorDraft('帮我做一个登录交付流程', { project: 'team/repo' });
  assert.equal(first.status, 'draft');
  assert.deepEqual(first.choices, { project: 'team/repo', collectionName: 'flowkit-workflows', includeSource: false });
  assert.equal(first.questions.length, 1);
  assert.equal(first.questions[0].recommended, 'standard');
  assert.equal(first.questions[0].customAllowed, true);
  const configured = startAuthorDraft(first.goal, { executionMode: 'standard', collectionName: 'team-workflows', includeSource: true });
  assert.deepEqual(configured.questions, []);
  assert.equal(configured.choices.collectionName, 'team-workflows');
  assert.equal(configured.choices.includeSource, true);
  assert.throws(() => startAuthorDraft(' '), /goal is required/);
});

test('Intent bridge retains explicit baseline, effective constraints, unresolved changes, and sources', async () => {
  const draft = startAuthorDraft('帮我做一个登录交付流程');
  const source = { root: 'input', pointer: '' };
  const old = { id: 'keep-api', kind: 'prohibition', text: 'Do not change the API', scope: { type: 'global' } };
  const context = { project: 'team/repo' };
  const baseline = { intents: [], constraints: [old] };
  const intended = { effective: { intents: [{ id: 'workflow', goal: 'Deliver login', understanding: 'clear',
    constraints: [], children: [] }], constraints: [old], relations: [], unresolved: ['delivery-target'], coverage: 'partial' },
  turn: { facts: {}, changes: [{ effect: 'conditional', operation: 'withdraw', conditionId: 'condition',
    target: { kind: 'constraint', id: 'keep-api' }, sourceRefs: [source] }] },
  issues: [{ id: 'delivery-target' }], fieldResults: [], inferences: [{ target: 'mode', candidate: 'standard' }],
  evidence: [{ target: '/effective/constraints/0', sourceRefs: [source] }] };
  const result = await analyzeAuthorDraft(draft, { async parse(request) {
    assert.equal(request.input, draft.goal);
    assert.equal(request.baseline, baseline);
    assert.equal(request.context, context);
    assert.equal(request.output.evidence, true);
    return intended;
  } }, { context, baseline, baselineId: 'previous-turn' });
  assert.equal(result.intentRef.baselineId, 'previous-turn');
  assert.equal(result.goals[0].goal, 'Deliver login');
  assert.deepEqual(result.constraints.map(({ id, kind, confidence, sourceRefs }) => ({ id, kind, confidence, sourceRefs })),
    [{ id: 'keep-api', kind: 'must_not', confidence: 'inferred', sourceRefs: [source] }]);
  assert.deepEqual(result.changes, intended.turn.changes);
  assert.deepEqual(result.issues, intended.issues);
  assert.deepEqual(result.inferences, intended.inferences);
  assert.equal(result.coverage, 'partial');
  await assert.rejects(analyzeAuthorDraft(draft, {}, { baseline }), /must be supplied together/);
});

test('incomplete capability discovery stays unresolved', async () => {
  const ids = ['flowkit::compile'];
  const result = await checkPlanCapabilities({ async resolve(request) {
    assert.deepEqual(request.ids, ids);
    return { meta: { completeness: 'partial' }, unresolved: [{ id: 'flowkit::compiler' }], nodes: [] };
  } }, ids, {});
  assert.equal(result.supported, false);
  assert.deepEqual(result.unresolved, [{ id: 'flowkit::compiler' }]);
});

test('complete Graph responses still reject unknown, inapplicable or missing roots and inspect requires dependencies',async()=>{
  for(const status of ['unknown','partial','inapplicable',undefined]) {
    const result=await checkPlanCapabilities({async resolve(request){assert.deepEqual(request.relations,['requires']);
      return {meta:{completeness:'complete'},unresolved:[],nodes:[{capability:{id:'flowkit::compile'},applicability:{status}}]};}},['flowkit::compile'],{});
    assert.equal(result.supported,false);
  }
  const graph=nodes=>({async resolve(){return {meta:{completeness:'complete'},unresolved:[],nodes};}});
  assert.equal((await checkPlanCapabilities(graph([]),['flowkit::compile'],{})).supported,false);
  assert.equal((await checkPlanCapabilities(graph([{capability:{id:'flowkit::compile'},applicability:{status:'applicable'}}]),['flowkit::compile'],{})).supported,true);
});

test('WorkflowPlan blocks unresolved mode and P0-A gaps, and preserves a no-change revision', () => {
  const draft = startAuthorDraft('Prepare and approve a login delivery');
  const intent = { coverage: 'complete', issues: [], unresolved: [], goals: [{ id: 'login' }], constraints: [] };
  const proposal = { entryNodeId: 'approval', nodes: [{ id: 'approval', kind: 'human' }, { id: 'done', kind: 'terminal' }],
    edges: [{ from: 'approval', to: 'done', kind: 'control' }], coverage: [{ intentId: 'login', status: 'covered', coveredBy: ['approval'] }] };
  const ambiguous = createWorkflowPlan(draft, intent, proposal);
  assert.equal(ambiguous.status, 'draft');
  assert.equal(ambiguous.target.executionMode, undefined);
  const interactive = { ...draft, choices: { ...draft.choices, executionMode: 'interactive-p0-a' } };
  const blocked = createWorkflowPlan(interactive, intent, proposal, ambiguous);
  assert.equal(blocked.status, 'needs-clarification');
  assert.equal(blocked.unresolvedIssues[0].id, 'unsupported-approval');
  const standard = { ...draft, choices: { ...draft.choices, executionMode: 'standard' } };
  const ready = createWorkflowPlan(standard, intent, proposal, blocked);
  assert.equal(ready.status, 'ready-for-dsl');
  assert.equal(ready.revision, 3);
  assert.equal(createWorkflowPlan(standard, intent, proposal, ready), ready);
  const limited = createWorkflowPlan(standard, { ...intent, coverage: 'partial' }, proposal, ready);
  assert.equal(limited.status, 'needs-clarification');
});

test('Author reads only a selected Graph-pinned document and rejects revision or HTTPS content drift', async () => {
  const capabilityId = 'flowkit::compile-workflow';
  const url = 'https://example.invalid/docs/compile.md';
  const source = { type: 'url', url };
  const bytes = Buffer.from('Node-level semantics');
  const pin = { capabilityId, documentId: 'compile', revision: 'catalog-v1', contentHash: artifactDigest(bytes), url };
  const reads = [];
  const capabilityGraph = { async getCapabilities({ ids }) {
    assert.deepEqual(ids, [capabilityId]);
    return { meta: { revision: 'catalog-v1', completeness: 'complete' }, items: [{ capability: { id: capabilityId,
      documents: [{ id: 'compile', source }, { id: 'unrelated', source: { type: 'url', url: 'https://example.invalid/unrelated' } }] } }] };
  } };
  const author = createWorkflowAuthor({ capabilityGraph, async readDocumentUrl(requested) { reads.push(requested); return { url: requested, bytes }; } });
  await assert.rejects(author.readDocument({ ...pin, revision: 'catalog-v2' }), /revision differs/);
  await assert.rejects(author.readDocument({ ...pin, url: 'https://example.invalid/alternate' }), /authorize the exact/);
  assert.deepEqual(reads, []);
  assert.deepEqual(await author.readDocument(pin), { text: bytes.toString(), evidence: {
    capabilityId, documentId: pin.documentId, revision: pin.revision, contentHash: pin.contentHash, source } });
  await assert.rejects(author.readDocument({ ...pin, contentHash: artifactDigest('old content') }), /content differs/);
  assert.deepEqual(reads, [url, url]);
});
