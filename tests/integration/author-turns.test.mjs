import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, context, intent, proposal, executableProposal, source } from './author-host-fixture.mjs';
import { runArtifact, isControlSignal } from '../../src/index.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { compileArtifactDraft } from '../../src/compiler/api.mjs';
import { createWorkflowAuthorHost } from '../../dist/host.mjs';

async function setup(t, overrides) {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-author-turns-'));
  const f = await fixture(path.join(dir, 'author.sqlite'), overrides);
  t.after(async () => { await f.host.close({ mode: 'cancel' }); await rm(dir, { recursive: true, force: true }); });
  return { ...f, dir };
}
const current = (f, draft) => f.host.readDraft({ draftId: draft.id }, context);
async function advance(f, draft, extra = {}) {
  const now = await current(f, draft);
  return f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: now.stateVersion, turnId: 'turn-' + f.calls.length,
    input: 'Inspect', ...extra }, context);
}
async function approve(f, ready, ref = 'approved') {
  f.approvals.set(ref, ready.candidate.hash);
  return f.host.recordApproval({ draftId: ready.id, expectedStateVersion: (await current(f, ready)).stateVersion,
    candidateHash: ready.candidate.hash, previousHash: ready.previousHash, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: ref }, context);
}
async function save(f, approved, id = 'save') {
  return f.host.publish({ draftId: approved.id, expectedStateVersion: approved.stateVersion, publicationId: id,
    candidateHash: approved.candidate.hash, previousHash: approved.previousHash, reviewRef: approved.reviewReceipt.reviewRef,
    approvalRef: approved.approvalReceipt.approvalRef }, context);
}
function agentResult(result) { return { status: 'succeeded', events: [], result }; }

test('R-03 S03: unresolved publication offers a draft recommendation and custom input before planning', async t => {
  const f = await setup(t, { defaults: {} });
  await f.register();
  const raw = f.options.execution.request;
  f.options.execution.request = async input => {
    const result = await raw(input);
    if (input.stage === 'intent' && input.request.input.startsWith('Prepare')) {
      result.effective.coverage = 'partial';
      result.effective.unresolved = ['publication-destination'];
      result.issues = [{ id: 'publication-destination' }];
    }
    return result;
  };
  const draft = await f.start({ goal: 'Prepare a delivery workflow' });
  assert.equal(draft.questions[0].id, 'execution-mode');
  const pending = await advance(f, draft, { input: draft.goal, choices: { executionMode: 'standard' } });
  assert.equal(pending.status, 'needs-clarification');
  assert.equal(pending.choices.executionMode, 'standard');
  assert.equal(pending.candidate, null);
  assert.deepEqual(f.calls.map(call => call.stage), ['intent']);
  assert.deepEqual(pending.questions.map(question => question.id), ['intent:publication-destination']);
  const [question] = pending.questions;
  assert.deepEqual(question.options.map(({ value }) => value), ['keep-draft', 'provide-details']);
  assert.equal(question.recommended, 'keep-draft');
  assert.equal(question.customAllowed, true);
  const ready = await advance(f, pending, { input: 'Deliver the result to our approved internal review queue' });
  assert.equal(ready.status, 'candidate-ready');
  assert.deepEqual(ready.questions, []);
  assert.equal(ready.savedReceipt, undefined);
  assert.equal(f.host.createMcpOptions().store.readActive('team', ready.target.skillId), null);
});

function replacePlan(f, change, controlScope) {
  const request = f.options.execution.request;
  f.options.execution.request = async input => {
    if (input.stage === 'intent' && controlScope) {
      const parsed = await request(input);
      parsed.effective.constraints.push({id: 'explicit-controls', kind: 'requirement', text: controlScope, scope: {}});
      return parsed;
    }
    if (input.prepared?.task.node.id !== 'proposal') return request(input);
    f.calls.push(input);
    const result = change(structuredClone(proposal));
    if (controlScope) result.coverage.push({intentId:'explicit-controls',status:'covered',coveredBy:[result.entryNodeId]});
    return agentResult({ rawText: JSON.stringify(result) });
  };
}

test('I4 S05/S25/S88/S90/S91/S92: mode changes invalidate approval, new turns get fresh deadlines and independent review needs observed distinct identities', async t => {
  const f = await setup(t); const ready = await advance(f, await f.start()); const approved = await approve(f, ready);
  const first = f.host.createMcpOptions().store.authorTransaction(state => state.turns(ready.id)[0]);
  await new Promise(resolve => setTimeout(resolve, 5));
  const changed = await advance(f, approved, { choices: { executionMode: 'interactive-p0-a' } });
  assert.equal(changed.approvalReceipt, null); assert.equal(changed.reviewReceipt, null); assert.notEqual(changed.status, 'approved');
  const records = f.host.createMcpOptions().store.authorTransaction(state => state.turns(ready.id));
  assert.ok(records.find(item => item.turnId !== first.turnId).budget.deadlineMs > first.budget.deadlineMs);
  await assert.rejects(f.host.recordApproval({ draftId: ready.id, expectedStateVersion: approved.stateVersion,
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'approved' }, context));
  for (const identity of ['missing', 'same', 'same-session', 'same-workspace', 'distinct']) {
    const g = await setup(t); g.options.authorization.reviewPolicy = 'independent-subject';
    g.options.authorization.observeReview = async ({ task }) => ({ passed: true, executionId: task.execution.requestId,
      subjectId: identity === 'same' ? 'author' : 'reviewer', ...(identity !== 'missing' ? { authorSubjectId: 'author' } : {}),
      authorSessionId: 'author-session', sessionId: identity === 'same-session' ? 'author-session' : 'review-session',
      authorWorkspaceId: 'author-workspace', workspaceId: identity === 'same-workspace' ? 'author-workspace' : 'review-workspace' });
    const result = await advance(g, await g.start());
    assert.equal(result.status === 'candidate-ready', identity === 'distinct');
  }
});

test('I4 S142: bounded Human repair, a real DSL repair and any-write policy coexist with an exact compiled Artifact', async t => {
  const f = await setup(t);
  const text = `import {defineWorkflow,parallel,action,human,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'combined',version:'1.0.0',name:'Combined',nodes:[
parallel('race',{name:'Race',branches:['one','two'],join:{strategy:'any',next:'approve'}}),
action('one',{name:'One',action:'one'}),action('two',{name:'Two',action:'two'}),
human('approve',{name:'Approve',onApprove:'done',onReject:'revise',maxRevisions:1}),
action('revise',{name:'Revise',action:'revise',next:'approve'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
  const file = path.join(f.dir, 'combined.workflow.js'); await writeFile(file, text);
  const compiled = await compileArtifactDraft(file, { skillCheck: false }); assert.ok(compiled.artifact);
  replacePlan(f, plan => ({ ...plan, entryNodeId: 'race', coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['race'] }],
    nodes: compiled.definition.nodes.map(node => ({ id: node.id, kind: node.type })),
    edges: [...compiled.graph.referenceEdges, ...compiled.graph.executionEdges].map(({ from, to }) => ({ from, to, kind: 'control' })) }),
  'Run the selected parallel policy, then request approval with at most one revision.');
  const request = f.options.execution.request;
  f.options.execution.request = async input => ['dsl-source', 'dsl-repair'].includes(input.prepared?.task.node.id) ?
    (f.calls.push(input), agentResult({ rawText: input.prepared.task.node.id === 'dsl-source' ? 'broken' : text })) : request(input);
  f.options.authorization.verifySafetyPolicy = async binding => binding.artifactHash === compiled.artifact.artifactHash && binding.policyRef === 'exact-combined';
  f.options.authorization.resolveApplicableSafetyPolicies = () => [{ nodeId: 'race', policyRef: 'exact-combined' }];
  const result = await advance(f, await f.start(), { safetyPolicies: [{ nodeId: 'race', policyRef: 'exact-combined' }] });
  assert.equal(result.status, 'candidate-ready', JSON.stringify(result.diagnostics));
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'dsl-repair').length, 1);
  assert.equal(result.candidate.manifest.workflowDefinition.nodes.find(node => node.id === 'approve').maxRevisions, 1);
});

test('I2 S01/S02/S54/S55: unknown mode offers recommendation; explicit known choices take precedence without repeated questions', async t => {
  const f = await setup(t, { defaults: {} });
  const draft = await f.start(); assert.equal(draft.questions[0].recommended, 'standard');
  const unclear = await advance(f, draft); assert.equal(unclear.status, 'needs-clarification'); assert.equal(f.calls.length, 1);
  const ready = await advance(f, unclear, { choices: { executionMode: 'standard', includeSource: true } });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(ready.choices.executionMode, 'standard'); assert.ok(ready.candidate.files['source/workflow.dsl.js']); assert.deepEqual(ready.questions, []);
  await assert.rejects(advance(f, ready, { choices: { executionMode: 'unknown' } }), /Choose Standard/);
});

test('I2 S04/S09/S66: read-only explanation and unchanged Plan reuse preserve bytes, builtAt, content revision and precise approval', async t => {
  const f = await setup(t); const ready = await advance(f, await f.start());
  assert.equal(ready.stateVersion, (await current(f, ready)).stateVersion);
  const approved = await approve(f, ready); const before = await current(f, ready); const calls = f.calls.length;
  assert.deepEqual(await current(f, before), before); assert.equal(f.calls.length, calls);
  const reused = await advance(f, before);
  assert.equal(reused.status, 'approved', JSON.stringify(reused.diagnostics));
  assert.equal(reused.candidate.hash, ready.candidate.hash); assert.equal(reused.candidate.manifest.builtAt, ready.candidate.manifest.builtAt);
  assert.equal(reused.contentRevision, ready.contentRevision); assert.equal(reused.contentHash, ready.contentHash);
  assert.equal(reused.approvalReceipt.approvalRef, approved.approvalReceipt.approvalRef);
  assert.deepEqual(f.calls.slice(calls).find(call => call.stage === 'intent').request.baseline, intent.effective);
  assert.deepEqual(f.calls.slice(calls).map(call => call.stage === 'intent' ? 'intent' : call.prepared.task.node.id), ['intent', 'proposal']);
});

test('I2 review-only observes a fresh semantic task without parsing, proposing, generating or recompiling', async t => {
  const f = await setup(t); const ready = await advance(f, await f.start()); await approve(f, ready);
  const calls = f.calls.length;
  const reviewed = await advance(f, ready, { kind: 'review-only', input: 'Review this exact candidate again' });
  assert.equal(reviewed.status, 'candidate-ready', JSON.stringify(reviewed.diagnostics));
  assert.equal(reviewed.candidate.hash, ready.candidate.hash); assert.equal(reviewed.contentRevision, ready.contentRevision);
  assert.notEqual(reviewed.reviewReceipt.reviewRef, ready.reviewReceipt.reviewRef); assert.equal(reviewed.approvalReceipt, null);
  assert.deepEqual(f.calls.slice(calls).map(call => call.prepared.task.node.id), ['semantic-review']);
});

test('A rejected semantic review exposes findings and actions bound to the exact candidate', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  let reject = true;
  f.options.execution.request = input => {
    if (reject && input.prepared?.task.node.id === 'semantic-review') {
      f.calls.push(input);
      return agentResult({ passed: false, findings: [{ message: 'Review the declared failure control.',
        nodeIds: ['work', '_FlowkitException', 'work'], rule: 'Keep the preview local.' }] });
    }
    return request(input);
  };
  const pending = await advance(f, await f.start());
  assert.equal(pending.status, 'needs-revision');
  assert(!pending.reviewReceipt && !pending.approvalReceipt);
  assert.deepEqual(pending.diagnostics.map(({ code, candidateHash, nextAction }) => [code, candidateHash, nextAction]),
    [['FKA_REVIEW_NOT_QUALIFIED', pending.candidate.hash, 'review-only']]);
  assert.deepEqual((await current(f, pending)).diagnostics, pending.diagnostics);
  const rejection = pending.reviewRejection;
  assert.equal(rejection.candidateHash, pending.candidate.hash);
  assert.deepEqual(rejection.findings, [{ message: 'Review the declared failure control.', nodeIds: ['work'], rule: 'Keep the preview local.' }]);
  assert.deepEqual(rejection.actions.map(({ kind, candidateHash }) => [kind, candidateHash]),
    [['review-only', pending.candidate.hash], ['authoring', pending.candidate.hash]]);
  const selected = await f.host.reviewCandidate({ draftId: pending.id, candidateHash: pending.candidate.hash,
    previousHash: pending.previousHash }, context);
  assert.deepEqual(selected.rejection, rejection);
  const before = f.calls.length;
  await assert.rejects(() => advance(f, pending, { kind: 'review-only', candidateHash: artifactDigest('stale') }), /exact current candidate/);
  assert.equal(f.calls.length, before);
  reject = false;
  const calls = f.calls.length;
  const result = await advance(f, pending, { ...rejection.actions[0], input: 'Review the same candidate.' });
  assert.equal(result.status, 'candidate-ready');
  assert.equal(result.candidate.hash, pending.candidate.hash);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.reviewRejection, undefined);
  assert.equal(result.approvalReceipt, null);
  assert.deepEqual(f.calls.slice(calls).map(call => call.prepared.task.node.id), ['semantic-review']);
  await assert.rejects(() => advance(f, result, { ...rejection.actions[1], input: 'Use the old rejection.' }),
    /rejected review is no longer current/);
});

test('Revising a rejected candidate preserves authorized dialogue and treats the findings as evidence', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const goal = 'Prepare an inventory reconciliation';
  const answer = 'When emergency is true only inspect. Never write inventory.';
  const revision = 'Fix the reported emergency route and keep my previous decisions.';
  const finding = 'Check whether the emergency path has an extra action.';
  let phase = 'initial';
  f.options.execution.request = async input => {
    if (input.prepared?.task.node.id === 'semantic-review' && phase !== 'revise') {
      f.calls.push(input);
      return agentResult({ passed: false, findings: [finding] });
    }
    if (input.stage === 'intent' && phase === 'revise') {
      assert.equal(input.request.baseline, undefined);
      assert.equal(input.request.context.currentDraft.draftId, draft.id);
      assert(input.request.input.includes(goal) && input.request.input.includes(answer) && input.request.input.includes(revision));
      assert(!input.request.input.includes(finding) && !input.request.input.includes('review evidence only'));
    }
    if (input.prepared?.task.node.id === 'proposal' && phase === 'revise') {
      f.calls.push(input);
      const plan = structuredClone(executableProposal);
      plan.nodes[0].options.action = 'inspect-emergency';
      return agentResult({ rawText: JSON.stringify(plan) });
    }
    const result = await request(input);
    if (input.stage === 'intent' && phase === 'initial') {
      result.effective.coverage = 'partial';
      result.effective.unresolved = ['publication-destination'];
    }
    return result;
  };
  const draft = await f.start({ goal });
  const pending = await advance(f, draft, { input: goal });
  phase = 'answer';
  const rejected = await advance(f, pending, { input: answer, contextSnapshot: { binding: 'read-only' } });
  assert.equal(rejected.status, 'needs-revision');
  assert.deepEqual(rejected.reviewRejection.findings, [{ message: finding, nodeIds: [] }]);
  const retained = await advance(f, rejected, { ...rejected.reviewRejection.actions[0], input: 'review evidence only' });
  assert.equal(retained.candidate.hash, rejected.candidate.hash);
  phase = 'revise';
  const ready = await advance(f, retained, { ...retained.reviewRejection.actions[1], input: revision });
  assert.equal(ready.id, draft.id);
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.notEqual(ready.candidate.hash, retained.candidate.hash);
  assert.equal(ready.plan.sourceHash, ready.candidate.manifest.sourceHash);
  assert.equal(ready.reviewRejection, undefined);
  assert.equal(ready.approvalReceipt, null);
  const reviewed = f.calls.filter(call => call.prepared?.task.node.id === 'semantic-review').at(-1).prepared.task.input;
  assert.deepEqual(reviewed.authorizedRequest.draftInputs, [goal, answer, revision]);
  assert.deepEqual(reviewed.authorizedRequest.contextSnapshot, { binding: 'read-only' });
  assert.deepEqual(reviewed.baselineEvidence.reviewRejection,
    { candidateHash: retained.candidate.hash, findings: retained.reviewRejection.findings });
});

test('I2 S06/S07/S56/S57/S58/S81: update pins an exact no-DSL baseline and preserves old approved Run bytes', async t => {
  const f = await setup(t, { useNodeOptionsForNewDrafts: true }); await f.register(); const first = await advance(f, await f.start());
  await save(f, await approve(f, first));
  assert.equal(first.candidate.files['source/workflow.dsl.js'], undefined);
  await assert.rejects(f.start({ requestId: 'ambiguous', operation: 'update', target: { name: 'inspect', version: '2.0.0' } }), /TargetRef/);
  const targetRef = { collectionId: 'team', skillId: first.target.skillId, baseArtifactHash: first.candidate.manifest.artifactHash, baseVersion: '1.0.0' };
  await assert.rejects(f.start({ requestId: 'wrong', operation: 'update', targetRef: { ...targetRef, baseArtifactHash: 'sha256:' + 'b'.repeat(64) } }), /baseline/);
  await assert.rejects(f.start({ requestId: 'same', operation: 'update', targetRef, target: { version: '1.0.0' } }), /unused version/);
  const update = await f.start({ requestId: 'update', operation: 'update', targetRef, target: { name: 'inspect', description: 'Updated', version: '2.0.0' } });
  const beforeUpdate = f.calls.length;
  const ready = await advance(f, update, { input: 'Inspect with the existing API retained' });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics)); assert.equal(ready.target.skillId, first.target.skillId);
  assert.equal(ready.previousHash, first.candidate.hash); assert.equal(ready.candidate.manifest.version, '2.0.0');
  const updateNodes = f.calls.slice(beforeUpdate).flatMap(call => call.prepared?.task.node.id ?? []);
  assert.ok(updateNodes.includes('proposal'));
  assert.ok(!updateNodes.includes('dsl-source'));
  const review = f.calls.filter(call => call.prepared?.task.node.id === 'semantic-review').at(-1).prepared.task.input;
  assert.deepEqual(Object.keys(review).sort(), ['authorizedRequest', 'effectiveIntent', 'intentChanges', 'baselineEvidence', 'currentPlan', 'reviewTarget', 'candidateDiff', 'resourceSnapshot'].sort());
  assert.deepEqual(review.reviewTarget, { hash: ready.candidate.hash, mode: ready.candidate.manifest.mode,
    artifactHash: ready.candidate.manifest.artifactHash, contract: null });
  assert.equal(review.baselineEvidence.workflow.manifest.artifactHash, first.candidate.manifest.artifactHash);
  assert.equal(Object.hasOwn(review.baselineEvidence.workflow.manifest, 'graphSnapshotJson'), false);
  assert.equal(Object.hasOwn(review.baselineEvidence.workflow, 'files'), false);
  assert.match(review.authorizedRequest.input, /API retained/);
  await save(f, await approve(f, ready, 'approved-update'), 'save-update');
  const old = f.host.createMcpOptions().store.readVersion('team', first.target.skillId, first.candidate.hash);
  assert.deepEqual(old.files, first.candidate.files);
  const file = path.join(f.dir, 'workflow.js'); await writeFile(file, old.files['workflow.js']);
  let inspected = 0;
  assert.equal((await runArtifact(file, old.manifest.artifactHash, { isControlSignal, runAction: async () => { inspected++; } })).status, 'succeeded');
  assert.equal(inspected, 1);
});

test('I2 S11/S12/S14/S69/S72/S73: final Plan resolves new requires closure, requires exact approved pins and leaves optional gaps optional', async t => {
  for (const variant of ['unknown', 'missing-root', 'required-skill', 'wrong-pin', 'optional']) {
    const f = await setup(t, { capabilityGraph: { async getCapabilities() { return { meta: { completeness: 'complete', revision: '1' }, items: [] }; },
      async resolve() { return { meta: { completeness: 'complete' }, unresolved: [], nodes: variant === 'missing-root' ? [] :
        [{ capability: { id: 'new-capability' }, applicability: { status: variant === 'unknown' ? 'unknown' : 'applicable' } }] }; } },
      resolveProfessionalSkill: async () => variant === 'wrong-pin' ? { id: 'skill', version: '2.0.0', digest: 'sha256:' + 'b'.repeat(64), approved: true } : null });
    replacePlan(f, plan => ({ ...plan, capabilityRequirements: ['new-capability'], resourceRequirements: variant.includes('skill') || variant === 'wrong-pin' || variant === 'optional' ?
      [{ kind: 'professional-skill', nodeId: 'work', id: 'skill', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64), required: variant !== 'optional' }] : [] }));
    const result = await advance(f, await f.start());
    assert.equal(result.status, variant === 'optional' ? 'candidate-ready' : 'needs-clarification', variant + JSON.stringify(result.diagnostics));
    if (variant !== 'optional') assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'dsl-source').length, 0);
  }
});

test('I2 S24: confirming an exact Plan uses the confirmed proposal and never asks a model to invent another Plan', async t => {
  const f = await setup(t);
  replacePlan(f, plan => ({ ...plan, assumptions: [{ id: 'chosen', statement: 'Use the proposed delivery target', requiresConfirmation: true }] }));
  const pending = await advance(f, await f.start()); assert.equal(pending.status, 'needs-clarification');
  const count = f.calls.filter(call => call.prepared?.task.node.id === 'proposal').length;
  const ready = await advance(f, pending, { confirmedPlanHash: pending.plan.planHash });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'proposal').length, count);
});

test('I2 S48/S65: semantic review receives changed current request even when stale model intent and Plan agree', async t => {
  const f = await setup(t); const ready = await advance(f, await f.start());
  const request = f.options.execution.request;
  f.options.execution.request = async input => {
    if (input.prepared?.task.node.id === 'semantic-review') {
      f.calls.push(input);
      assert.match(input.prepared.task.input.authorizedRequest.input, /Do not publish/);
      return agentResult({ passed: false, findings: ['Current no-publication requirement omitted from the stale Plan'] });
    }
    return request(input);
  };
  const rejected = await advance(f, ready, { input: 'Explain this workflow, and Do not publish' });
  assert.equal(rejected.status, 'needs-revision'); assert.equal(rejected.reviewReceipt, null); assert.equal(rejected.approvalReceipt, null);
});

test('I2 S18/S20: missing finite Human policy and unsupported P0-A are decisions, not syntax-repair attempts', async t => {
  for (const mode of ['standard', 'interactive-p0-a']) {
    const f = await setup(t);
    replacePlan(f, plan => ({ ...plan, entryNodeId: 'approval', coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['approval'] }],
      nodes: [{ id: 'approval', kind: 'human' }, { id: 'revise', kind: 'action' }, { id: 'done', kind: 'terminal' }], edges: [
      { from: 'approval', to: 'done', kind: 'control' }, { from: 'approval', to: 'revise', kind: 'control' }, { from: 'revise', to: 'approval', kind: 'control' }] }),
    'Ask for approval and allow revision; its maximum is not yet supplied.');
    const request = f.options.execution.request;
    f.options.execution.request = async input => input.prepared?.task.node.id === 'dsl-source' ? (f.calls.push(input), agentResult({ rawText:
      `import {defineWorkflow,human,action,terminal} from '@devcodex-labs/flowkit/dsl';export default defineWorkflow({id:'human',version:'1.0.0',name:'Human',nodes:[human('approval',{name:'Approve',onApprove:'done',onReject:'revise'}),action('revise',{name:'Revise',action:'revise',next:'approval'}),terminal('done',{name:'Done',status:'succeeded'})]});` })) : request(input);
    const result = await advance(f, await f.start(), { choices: { executionMode: mode } });
    assert.equal(result.status, 'needs-clarification', JSON.stringify(result.diagnostics)); assert.ok(result.questions.length);
    assert.equal(f.calls.filter(call => call.prepared?.task.node.id.endsWith('-repair')).length, 0);
  }
});

test('I2 S53: getter, cycle and non-JSON input are rejected before executing getters or model requests', async t => {
  const f = await setup(t); let invoked = 0;
  const getter = { collectionId: 'team', requestId: 'get', get goal() { invoked++; return 'Inspect'; } };
  await assert.rejects(f.host.start(getter, context), /getters/); assert.equal(invoked, 0);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(f.host.start(cycle, context), /JSON/); assert.equal(f.calls.length, 0);
});

test('I2 S50/S61: copy import uses trusted approved source, new IDs, exact files and fresh review without DSL', async t => {
  const sourceHost = await setup(t); await sourceHost.register();
  const original = await advance(sourceHost, await sourceHost.start()); await save(sourceHost, await approve(sourceHost, original));
  const target = await setup(t, { collectionIds: ['copy'], resolveImportSource: async () => ({ candidate: original.candidate, sourceRef: 'approved-source' }) });
  target.options.authorization.verifyImport = async binding =>
    sourceHost.host.createMcpOptions().store.readActive('team', original.target.skillId)?.hash === binding.sourceHash && binding.collectionId === 'copy';
  const targetContext = { ...context, authorizedCollections: ['copy'] };
  const imported = await target.host.start({ collectionId: 'copy', requestId: 'import', goal: 'Import approved inspection', operation: 'import',
    importSource: { mode: 'new-collection', sourceRef: 'approved-source' } }, targetContext);
  assert.equal(imported.status, 'needs-review'); assert.equal(target.calls.length, 0);
  assert.notEqual(imported.target.skillId, original.target.skillId); assert.equal(imported.candidate.manifest.collectionId, 'copy');
  assert.deepEqual(imported.candidate.files, original.candidate.files); assert.notEqual(imported.candidate.hash, original.candidate.hash);
  const reviewed = await target.host.advanceTurn({ draftId: imported.id, expectedStateVersion: imported.stateVersion, turnId: 'review-import',
    kind: 'review-only', input: 'Review source approval and copied candidate' }, targetContext);
  assert.equal(reviewed.status, 'candidate-ready', JSON.stringify(reviewed.diagnostics));
  assert.deepEqual(target.calls.map(call => call.prepared.task.node.id), ['semantic-review']);
  target.options.authorization.verifyImport = async () => false;
  await assert.rejects(target.host.start({ collectionId: 'copy', requestId: 'denied-import', goal: 'Import', operation: 'import',
    importSource: { mode: 'new-collection', sourceRef: 'denied' } }, targetContext), /verify the source approval/);
});

test('I2 S13/S71: same document revision with changed bytes between selection and prepare invalidates qualification', async t => {
  const bytes = Buffer.from('actual selected document'); let changed = false;
  const pin = { kind: 'document', capabilityId: 'new-capability', documentId: 'guide', revision: '1',
    contentHash: artifactDigest(bytes), url: 'https://fixture.invalid/guide' };
  const f = await setup(t, { capabilityGraph: { async getCapabilities() { return { meta: { revision: '1', completeness: 'complete' },
    items: [{ capability: { id: 'new-capability', documents: [{ id: 'guide', source: { type: 'url', url: pin.url } }] } }] }; },
    async resolve() { return { meta: { completeness: 'complete' }, unresolved: [], nodes: [{ capability: { id: 'new-capability' }, applicability: { status: 'applicable' } }] }; } },
    readDocumentUrl: async () => ({ url: pin.url, bytes: changed ? Buffer.from('changed under same revision') : bytes }) });
  replacePlan(f, plan => ({ ...plan, capabilityRequirements: ['new-capability'], resourceRequirements: [pin] }));
  const request = f.options.execution.request;
  f.options.execution.request = async input => { const result = await request(input); if (input.prepared?.task.node.id === 'dsl-source') changed = true; return result; };
  const result = await advance(f, await f.start());
  assert.equal(result.status, 'needs-clarification', JSON.stringify(result.diagnostics)); assert.ok(!result.reviewReceipt);
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id.endsWith('-repair')).length, 0);
});

test('I5 S141: a no-DSL update binds the old baseline, new explicit constraint and newly required document before review', async t => {
  const bytes = Buffer.from('Preserve the existing public API.');
  const pin = { kind: 'document', capabilityId: 'api-policy', documentId: 'guide', revision: '1', contentHash: artifactDigest(bytes), url: 'https://fixture.invalid/api-policy' };
  const f = await setup(t, { capabilityGraph: {
    async getCapabilities() { return { meta: { revision: '1', completeness: 'complete' }, items: [{ capability: { id: 'api-policy', documents: [{ id: 'guide', source: { type: 'url', url: pin.url } }] } }] }; },
    async resolve() { return { meta: { completeness: 'complete' }, unresolved: [], nodes: [{ capability: { id: 'api-policy' }, applicability: { status: 'applicable' } }] }; }
  }, readDocumentUrl: async () => ({ url: pin.url, bytes }) });
  await f.register(); const original = await advance(f, await f.start()); await save(f, await approve(f, original));
  const next = await f.start({ requestId: 'update', operation: 'update', targetRef: { collectionId: 'team', skillId: original.target.skillId,
    baseArtifactHash: original.candidate.manifest.artifactHash, baseVersion: original.target.version },
    target: { name: 'inspect', description: 'Preserve API', version: '1.0.1' } });
  replacePlan(f, plan => ({ ...plan, capabilityRequirements: ['api-policy'], resourceRequirements: [pin],
    coverage: [...plan.coverage, { intentId: 'keep-api', status: 'covered', coveredBy: ['work'] }] }));
  const raw = f.options.execution.request;
  f.options.execution.request = async input => {
    if (input.stage !== 'intent') return raw(input);
    f.calls.push(input); const changed = structuredClone(intent);
    changed.effective.constraints.push({ id: 'keep-api', kind: 'prohibition', text: 'Do not remove the existing API', scope: {} }); return changed;
  };
  const ready = await advance(f, next, { input: 'Update inspection and do not remove the existing API' });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics)); assert.equal(ready.approvalReceipt, null);
  const review = f.calls.filter(call => call.prepared?.task.node.id === 'semantic-review').at(-1).prepared.task.input;
  assert.equal(review.baselineEvidence.workflow.manifest.artifactHash, original.candidate.manifest.artifactHash);
  assert.equal(review.effectiveIntent.constraints[0].statement, 'Do not remove the existing API');
  assert.match(review.authorizedRequest.input, /do not remove/); assert.ok(review.resourceSnapshot.documents.length);
});

test('I2 S15/S16/S83: one Plan repair plus one DSL repair share exactly two dispatches and yield a real compiled candidate', async t => {
  const f = await setup(t); const request = f.options.execution.request;
  f.options.execution.request = async input => {
    const id = input.prepared?.task.node.id;
    if (id === 'proposal' || id === 'dsl-source') { f.calls.push(input); return agentResult({ rawText: 'invalid raw text' }); }
    return request(input);
  };
  const result = await advance(f, await f.start());
  assert.equal(result.status, 'candidate-ready', JSON.stringify(result.diagnostics));
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'dsl-source', 'dsl-repair', 'semantic-review']);
});

test('Plan repair receives a specific diagnostic when the proposal omits a terminal', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  f.options.execution.request = async input => {
    const task = input.prepared?.task;
    if (task?.node.id === 'proposal') {
      const result = await request(input);
      const proposal = JSON.parse(result.result.rawText);
      return agentResult({ rawText: JSON.stringify({ ...proposal,
        nodes: proposal.nodes.filter(node => node.kind !== 'terminal'), edges: [] }) });
    }
    if (task?.node.id === 'plan-repair') {
      assert.match(task.input.planDiagnostics[0].message, /needs a terminal node/);
    }
    return request(input);
  };
  const result = await advance(f, await f.start());
  assert.equal(result.status, 'candidate-ready', JSON.stringify(result.diagnostics));
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'plan-repair').length, 1);
});

test('P2 Plan repair receives both workflow-level and node-level compiler diagnostics', async t => {
  const f = await setup(t, { useNodeOptionsForNewDrafts: true });
  const request = f.options.execution.request;
  const validPlan = structuredClone(executableProposal);
  validPlan.nodes[0].options.effect = 'read-only';
  const invalidPlan = structuredClone(validPlan);
  invalidPlan.contract = { input: { type: 'object', properties: { code: { type: 'string', pattern: '^[0-9]+$' } } } };
  invalidPlan.nodes[1].options.output = {};

  let diagnostics;
  f.options.execution.request = async input => {
    const task = input.prepared?.task;
    if (task?.node.id === 'proposal' || task?.node.id === 'plan-repair') {
      f.calls.push(input);
      if (task.node.id === 'plan-repair') diagnostics = task.input.planDiagnostics;
      return agentResult({ rawText: JSON.stringify(task.node.id === 'proposal' ? invalidPlan : validPlan) });
    }
    return request(input);
  };

  const ready = await advance(f, await f.start(), { choices: { executionMode: 'interactive-p2' } });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(ready.candidate.manifest.implementedStage, 'P2');
  assert.deepEqual(diagnostics, [
    { code: 'FK_C008', message: 'Unsupported workflow schema keyword: pattern' },
    { code: 'FK_C018', message: 'Unknown terminal field: output', nodeId: 'done' }
  ]);
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'semantic-review']);
});

test('P2 Author repairs race inputs before the first semantic candidate review', async t => {
  const f = await setup(t, { useNodeOptionsForNewDrafts: true });
  const request = f.options.execution.request;
  const action = (id, options) => ({ id, kind: 'action', name: id, options: { action: id, effect: 'read-only', ...options } });
  const plan = { entryNodeId: 'race', edges: [],
    coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['race'] }],
    nodes: [
      { id: 'race', kind: 'parallel', name: 'Race',
        options: { branchMode: 'subflow', branches: ['left', 'right'], join: { strategy: 'any', next: 'summary' } } },
      action('left', { reads: [], writes: ['electronic'], next: 'summary' }),
      action('right', { reads: [], writes: ['paper'], next: 'summary' }),
      action('summary', { next: 'done' }),
      { id: 'done', kind: 'terminal', name: 'Done', options: { status: 'succeeded' } }
    ] };
  f.options.execution.request = async input => {
    const task = input.prepared?.task;
    if (!['proposal', 'plan-repair'].includes(task?.node.id)) return request(input);
    f.calls.push(input);
    const answer = structuredClone(plan);
    if (task.node.id === 'plan-repair') {
      const [diagnostic] = task.input.planDiagnostics;
      assert.equal(diagnostic.code, 'FK_I_PARALLEL_INPUT');
      assert.equal(diagnostic.nodeId, 'summary');
      assert.match(diagnostic.message, /electronic.*paper/);
      answer.nodes.find(node => node.id === 'summary').options.reads = [];
    }
    return agentResult({ rawText: JSON.stringify(answer) });
  };
  const ready = await advance(f, await f.start(), { choices: { executionMode: 'interactive-p2' } });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.deepEqual(ready.candidate.manifest.workflowDefinition.nodes.find(node => node.id === 'summary').reads, []);
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'semantic-review']);
});

test('P2 derives subflow controls from bundled node options and validates supplementary edges', async t => {
  const f = await setup(t, { useNodeOptionsForNewDrafts: true });
  const request = f.options.execution.request;
  const guide = await readFile(new URL('../../src/author/flowkit-workflow-author/SKILL.md', import.meta.url), 'utf8');
  const example = JSON.parse(guide.split('### Interactive subflows')[1].split('```json')[1].split('```')[0]);
  const optional = { from: 'input', to: 'copy', kind: 'data' };
  const raw = { ...example, coverage: [{ intentId: 'goal', status: 'covered', coveredBy: ['checks'] }],
    edges: [{ from: 'checks', to: 'input' }, { from: 'review', to: 'copy', kind: 'branch' }, optional] };
  f.options.execution.request = async input => {
    const task = input.prepared?.task;
    if (task?.node.id === 'proposal') {
      assert.equal(task.input.authorizedRequest.planSource, 'node-options');
      f.calls.push(input);
      return agentResult({ rawText: JSON.stringify({ ...raw,
        edges: [...raw.edges, { from: 'input', to: 'missing', kind: 'resource' }] }) });
    }
    if (task?.node.id === 'plan-repair') {
      assert.match(task.input.planDiagnostics[0].message, /must connect existing node IDs using from and to/);
      f.calls.push(input);
      return agentResult({ rawText: JSON.stringify(raw) });
    }
    assert.ok(!['dsl-source', 'dsl-repair'].includes(task?.node.id));
    return request(input);
  };
  const ready = await advance(f, await f.start(), { choices: { executionMode: 'interactive-p2' } });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(ready.candidate.manifest.implementedStage, 'P2');
  assert.deepEqual(ready.plan.edges.filter(edge => edge.kind !== 'control'), [optional]);
  assert.ok(ready.plan.edges.some(edge => edge.from === 'review' && edge.to === 'copy' && edge.kind === 'control'));
  assert.ok(ready.diff.compilerEvidence.parallel.every(group => group.branchMode === 'subflow' &&
    group.branchBoundary === 'continuation-or-local-terminal'));
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'semantic-review']);
});

test('P0-B semantic review sees the emitted Action failure route in addition to the declared verification', async t => {
  const f = await setup(t, { useNodeOptionsForNewDrafts: true });
  replacePlan(f, () => ({
    ...executableProposal,
    nodes: [
      { id: 'work', kind: 'action', name: 'Work', options: { action: 'inspect', effect: 'read-only', next: 'check' } },
      { id: 'check', kind: 'verification', name: 'Check', options: { verifier: 'inspect-result', onSuccess: 'done', onFailure: 'failed' } },
      executableProposal.nodes[1],
      { id: 'failed', kind: 'terminal', name: 'Failed', options: { status: 'failed' } }
    ]
  }));
  const ready = await advance(f, await f.start(), { choices: { executionMode: 'interactive-p0-b' } });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  const calls = f.calls.filter(call => call.prepared?.task.node.id === 'semantic-review');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].prepared.task.input.candidateDiff.compilerEvidence.actionRoutes,
    [{ from: 'work', to: 'failed', role: 'action-failure' }]);
  assert.equal(Object.hasOwn(ready.diff.compilerEvidence, 'actionRoutes'), false);
});

test('Repair exhaustion returns the last compiler error after two Plan repairs', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  let repairs = 0;
  f.options.execution.request = async input => {
    const id = input.prepared?.task.node.id;
    if (id === 'proposal' || (id === 'plan-repair' && ++repairs === 1)) {
      f.calls.push(input);
      return agentResult({ rawText: JSON.stringify({ ...proposal, edges: [{ from: 'work', to: 'done' }] }) });
    }
    if (id === 'dsl-source') {
      f.calls.push(input);
      return agentResult({ rawText: source.replace("next:'done'", "next:'missing'") });
    }
    return request(input);
  };
  const result = await advance(f, await f.start());
  assert.equal(result.status, 'needs-revision');
  assert.equal(result.diagnostics[0].code, 'FKA_REPAIR_EXHAUSTED');
  assert.ok(result.diagnostics.some(item => item.code === 'FK_C015' && item.message.includes('missing')));
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'plan-repair', 'dsl-source']);
});

test('Known constraints with invalid coverage and a stale DSL graph repair within the existing shared budget', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const requirement = { id: 'no-publish', kind: 'prohibition', text: 'Keep the result local', scope: {} };
  const coverage = { intentId: requirement.id, status: 'covered', coveredBy: ['work'] };
  f.options.execution.request = async input => {
    if (input.stage === 'intent') {
      const parsed = await request(input);
      parsed.effective.constraints.push(requirement);
      assert.deepEqual(input.request.output, { evidence: true, suggestions: false });
      return parsed;
    }
    const task = input.prepared.task;
    if (task.node.id === 'proposal' || task.node.id === 'plan-repair') {
      f.calls.push(input);
      if (task.node.id === 'plan-repair') {
        assert.equal(task.input.planDiagnostics[0].intentId, requirement.id);
        assert.equal(task.input.planDiagnostics[0].message, requirement.text);
        assert.equal(JSON.parse(task.input.rawText).coverage.at(-1).coveredBy[0], 'missing-node');
      }
      const item = task.node.id === 'proposal' ? { ...coverage, coveredBy: ['missing-node'] } : coverage;
      return agentResult({ rawText: JSON.stringify({ ...proposal, coverage: [...proposal.coverage, item] }) });
    }
    if (task.node.id === 'dsl-source') {
      f.calls.push(input);
      return agentResult({ rawText: source.replace("action('work'", "action('wrong'") });
    }
    if (task.node.id === 'dsl-repair') {
      assert.equal(task.input.compileDiagnostics[0].code, 'FKA_PLAN_MISMATCH');
      assert.match(task.input.rawText, /action\('wrong'/);
    }
    return request(input);
  };
  const ready = await advance(f, await f.start());
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id),
    ['proposal', 'plan-repair', 'dsl-source', 'dsl-repair', 'semantic-review']);
  assert.equal(ready.candidate.manifest.workflowDefinition.nodes[0].id, 'work');
});

test('A one-sentence draft asks only the unresolved business decision and continues on the same draft', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  let answered = false;
  f.options.execution.request = async input => {
    if (input.stage === 'intent' && answered) {
      assert.equal(input.request.baseline, undefined, 'A provisional model snapshot is not a user baseline');
      assert.match(input.request.input, /Initial workflow request:\nReconcile inventory\n\nUser clarification 1:\nPut discrepancies in a local preview/);
      assert.deepEqual(input.request.context.currentDraft, { draftId: draft.id, operation: 'create', goal: 'Reconcile inventory' });
    }
    const task = input.prepared?.task;
    if (answered && task?.node.id === 'proposal') {
      assert.equal(task.input.authorizedRequest.planSource, 'node-options');
      assert.deepEqual(task.input.authorizedRequest.draftInputs, ['Reconcile inventory', 'Put discrepancies in a local preview']);
      f.calls.push(input);
      const broken = structuredClone(executableProposal);
      delete broken.nodes[0].options.next;
      return agentResult({ rawText: JSON.stringify(broken) });
    }
    if (answered && task?.node.id === 'plan-repair') {
      assert(task.input.planDiagnostics.some(item => item.code === 'FK_C016' && item.nodeId === 'work'));
    }
    if (input.stage !== 'agent' || input.prepared.task.node.id !== 'proposal' || answered) return request(input);
    f.calls.push(input);
    return agentResult({ rawText: JSON.stringify({ ...proposal, unresolvedIssues: [{
      id: 'difference-policy', kind: 'ambiguity', blocking: true, description: 'Where should discrepancies go?',
      recommended: 'preview', options: [{ value: 'preview', label: 'Local preview', reason: 'Avoid any write' },
        { value: 'manual', label: 'Manual review', reason: 'Let the owner decide' }]
    }] }) });
  };
  const draft = await f.start({ goal: 'Reconcile inventory' });
  const waiting = await advance(f, draft, { input: draft.goal });
  assert.equal(waiting.status, 'needs-clarification');
  assert.equal(waiting.candidate, null);
  assert.deepEqual(waiting.questions.map(q => [q.id, q.recommended, q.customAllowed]), [['difference-policy', 'preview', true]]);
  assert.deepEqual(f.calls.filter(call => call.stage === 'agent').map(call => call.prepared.task.node.id), ['proposal']);
  answered = true;
  const ready = await advance(f, waiting, { input: 'Put discrepancies in a local preview' });
  assert.equal(ready.id, draft.id);
  assert.equal(ready.choices.executionMode, 'standard');
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.equal(ready.approvalReceipt, null);
  assert.equal(ready.plan.sourceHash, ready.candidate.manifest.sourceHash);
  assert.deepEqual(ready.plan.edges, [{ from: 'work', to: 'done', kind: 'control' }]);
  assert.deepEqual(f.calls.slice(2).map(call => call.stage === 'intent' ? 'intent' : call.prepared.task.node.id),
    ['intent', 'proposal', 'plan-repair', 'semantic-review']);
});

test('A clarification with invalid Intent output resumes after restart using both authorized turns', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const goal = 'Reconcile inventory';
  const answer = 'Preview differences locally. Do not change inventory.';
  const contextSnapshot = { binding: 'local-preview' };
  let failures = 2;
  const attempts = [];
  f.options.execution.request = async input => {
    if (input.stage !== 'intent') return request(input);
    attempts.push(input.request);
    if (input.request.input === goal) {
      const result = await request(input);
      result.effective.coverage = 'partial';
      result.effective.unresolved = ['publication-destination'];
      return result;
    }
    if (failures > 0) {
      failures--;
      f.calls.push(input);
      throw Object.assign(new Error('Provider output referenced a missing field'), { code: 'MODEL_OUTPUT_INVALID' });
    }
    return request(input);
  };
  const draft = await f.start({ goal });
  const waiting = await advance(f, draft, { input: goal, turnId: 'z-initial' });
  assert.equal(waiting.status, 'needs-clarification');
  const pending = await advance(f, waiting, { input: answer, contextSnapshot, turnId: 'a-answer' });
  assert.equal(pending.status, 'needs-revision', JSON.stringify({ diagnostics: pending.diagnostics, dispatches: attempts.length }));
  assert.equal(pending.diagnostics[0].code, 'MODEL_OUTPUT_INVALID');
  assert.equal(pending.candidate, null);
  assert.deepEqual(pending.questions, []);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[1], attempts[2]);
  assert.equal(attempts[1].baseline, undefined);
  await f.host.close({ mode: 'cancel' });
  const reopened = await createWorkflowAuthorHost(f.options);
  try {
    const now = await reopened.readDraft({ draftId: draft.id }, context);
    const ready = await reopened.advanceTurn({ draftId: draft.id, expectedStateVersion: now.stateVersion,
      turnId: 'resume', input: 'Continue with my saved answer.' }, context);
    const observed = attempts.at(-1);
    assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
    assert.equal(ready.id, draft.id);
    assert.equal(ready.choices.executionMode, 'standard');
    assert.equal(ready.candidate.manifest.sourceHash, ready.plan.sourceHash);
    assert.equal(observed.baseline, undefined);
    assert.deepEqual(observed.context.suppliedContext, contextSnapshot);
    assert.equal(observed.context.currentDraft.draftId, draft.id);
    assert(observed.input.includes(goal) && observed.input.includes(answer));
    assert(!ready.approvalReceipt);
  } finally { await reopened.close({ mode: 'cancel' }); }
});

test('Malformed Plan output can exhaust repair and accept the exact same answer in a later turn', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const goal = 'Reconcile inventory';
  const answer = 'Only preview inventory differences.';
  let broken = true;
  f.options.execution.request = async input => {
    if (input.stage === 'intent' && input.request.input === goal) {
      const result = await request(input);
      result.effective.coverage = 'partial';
      result.effective.unresolved = ['publication-destination'];
      return result;
    }
    if (broken && ['proposal', 'plan-repair'].includes(input.prepared?.task.node.id)) {
      f.calls.push(input);
      return agentResult({ rawText: JSON.stringify({ ...executableProposal, assumptions: ['Known Host fact'] }) });
    }
    return request(input);
  };
  const draft = await f.start({ goal });
  const waiting = await advance(f, draft, { input: goal });
  const pending = await advance(f, waiting, { input: answer });
  assert.equal(pending.status, 'needs-revision');
  assert.match(pending.diagnostics[0].message, /Plan assumptions must declare/);
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'plan-repair').length, 2);
  assert.deepEqual(pending.questions, []);
  broken = false;
  const ready = await advance(f, pending, { input: answer });
  assert.equal(ready.status, 'candidate-ready');
  assert.equal(ready.id, draft.id);
  const intentCall = f.calls.filter(call => call.stage === 'intent').at(-1);
  assert.equal(intentCall.request.baseline, undefined);
  assert.equal(intentCall.request.input, `Initial workflow request:\n${goal}\n\nUser clarification 1:\n${answer}`);
});

test('Clarification rechecks unsupported assertions and asks for a grounded missing decision', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const goal = 'Reconcile inventory';
  const answer = 'Preview the result. Inventory must remain read-only.';
  let pass = 0;
  f.options.execution.request = async input => {
    if (input.stage !== 'intent') return request(input);
    const result = await request(input);
    if (input.request.input === goal) {
      result.effective.coverage = 'partial';
      result.effective.unresolved = ['publication-destination'];
    } else if (++pass === 1) {
      result.issues = [{ id: 'context-note', category: 'context', message: 'There is no existing workflow to modify.' }];
      result.effective.unresolved = [result.issues[0].message];
      result.effective.coverage = 'partial';
    } else if (pass === 2) {
      const refs = [{ root: 'input', pointer: '' }];
      result.issues = [{ id: 'missing-units', category: 'missing', message: 'Units are unresolved.', sourceRefs: refs,
        candidates: [{ id: 'items', description: 'Count individual items', sourceRefs: refs },
          { id: 'boxes', description: 'Count sealed boxes', sourceRefs: refs }],
        questions: [{ question: 'Which unit should the workflow compare?', optionIds: ['items', 'boxes'] }] }];
      result.effective.unresolved = [result.issues[0].message];
      result.effective.coverage = 'partial';
    }
    return result;
  };
  const draft = await f.start({ goal });
  const waiting = await advance(f, draft, { input: goal });
  const missing = await advance(f, waiting, { input: answer });
  assert.equal(pass, 2);
  assert.equal(missing.status, 'needs-clarification');
  assert.deepEqual(missing.questions.map(question => [question.id, question.question]),
    [['intent:missing-units', 'Which unit should the workflow compare?']]);
  assert(missing.questions[0].options.some(option => option.value === 'items'));
  const ready = await advance(f, missing, { input: 'items' });
  assert.equal(ready.status, 'candidate-ready');
  assert.equal(ready.id, draft.id);
});

test('An already-answered or unsupported Plan assumption is repaired without asking again', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const goal = 'Reconcile inventory';
  const decision = { id: 'result-destination', kind: 'ambiguity', blocking: true, description: 'Where should results go?',
    options: [{ value: 'preview', label: 'Local preview', reason: 'Keep results on this device.' },
      { value: 'review', label: 'Internal review queue', reason: 'Send to the authorized team.' }], recommended: 'preview' };
  let proposals = 0;
  f.options.execution.request = input => {
    const task = input.prepared?.task;
    if (task?.node.id === 'proposal') {
      const plan = ++proposals === 1 ? { ...proposal, unresolvedIssues: [decision] } :
        { ...executableProposal, assumptions: [{ id: 'host-knows', statement: 'Host provides preview.', requiresConfirmation: true }],
          unresolvedIssues: [decision] };
      f.calls.push(input);
      return agentResult({ rawText: JSON.stringify(plan) });
    }
    if (task?.node.id === 'plan-repair') {
      assert.equal(task.input.planDiagnostics[0].code, 'FKA_PLAN_DECISION_UNVERIFIED');
      assert.deepEqual(task.input.authorizedRequest.draftInputs, [goal, 'preview']);
    }
    return request(input);
  };
  const draft = await f.start({ goal });
  const waiting = await advance(f, draft, { input: goal });
  assert.equal(waiting.questions[0].recommended, 'preview');
  const ready = await advance(f, waiting, { input: 'preview' });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics));
  assert.deepEqual(ready.questions, []);
  assert.equal(f.calls.filter(call => call.prepared?.task.node.id === 'plan-repair').length, 1);
});

test('Clarifying a creation with a caller-supplied Intent baseline keeps the amendment contract', async t => {
  const f = await setup(t);
  const request = f.options.execution.request;
  const provisional = { ...structuredClone(intent), effective: { ...intent.effective, coverage: 'partial', unresolved: ['delivery'] } };
  let calls = 0;
  f.options.execution.request = async input => {
    const result = await request(input);
    if (input.stage !== 'intent') return result;
    if (++calls === 1) {
      assert.deepEqual(input.request.baseline, intent.effective);
      return provisional;
    }
    assert.deepEqual(input.request.baseline, provisional.effective);
    assert.equal(input.request.input, 'Deliver to the approved local preview');
    assert.equal(input.request.context?.currentDraft, undefined);
    return result;
  };
  const draft = await f.start();
  const waiting = await advance(f, draft, { baseline: intent.effective, baselineId: 'supplied-by-host' });
  assert.equal(waiting.status, 'needs-clarification');
  const ready = await advance(f, waiting, { input: 'Deliver to the approved local preview' });
  assert.equal(ready.id, draft.id);
  assert.equal(ready.status, 'candidate-ready');
  assert.equal(ready.plan.sourceHash, undefined);
});

test('I2 S19/S75/S80: exact compiled any policy is required; supported P0-A Agent target stays in its selected mode', async t => {
  for (const variant of ['any-denied', 'any-approved', 'p0-a']) {
    const f = await setup(t); const any = variant.startsWith('any');
    const text = any ? `import {defineWorkflow,parallel,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'any',version:'1.0.0',name:'Any',nodes:[parallel('race',{name:'Race',branches:['one','two'],join:{strategy:'any',next:'done'}}),action('one',{name:'One',action:'one'}),action('two',{name:'Two',action:'two'}),terminal('done',{name:'Done',status:'succeeded'})]});` :
      `import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';export default defineWorkflow({id:'basic',version:'1.0.0',name:'Basic',nodes:[node('work',{name:'Work',description:'Inspect',output:{type:'object'},next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
    const file = path.join(f.dir, 'target.workflow.js'); await writeFile(file, text);
    const compiled = await compileArtifactDraft(file, { skillCheck: false });
    replacePlan(f, plan => ({ ...plan, entryNodeId: compiled.definition.nodes[0].id,
      coverage: [{ intentId: 'goal', status: 'covered', coveredBy: [compiled.definition.nodes[0].id] }],
      nodes: compiled.definition.nodes.map(node => ({ id: node.id, kind: node.type })),
      edges: [...compiled.graph.referenceEdges, ...compiled.graph.executionEdges].map(({ from, to }) => ({ from, to, kind: 'control' })) }),
    any ? 'Use parallel.any with the exact Host policy.' : undefined);
    const request = f.options.execution.request;
    f.options.execution.request = async input => input.prepared?.task.node.id === 'dsl-source' ?
      (f.calls.push(input), agentResult({ rawText: text })) : request(input);
    let policyChecks = 0;
    f.options.authorization.verifySafetyPolicy = async binding => { policyChecks++; assert.equal(binding.artifactHash, compiled.artifact.artifactHash); return variant === 'any-approved'; };
    f.options.authorization.resolveApplicableSafetyPolicies = () => any ? [{ nodeId: 'race', policyRef: 'exact-policy' }] : [];
    const result = await advance(f, await f.start(), { choices: { executionMode: any ? 'standard' : 'interactive-p0-a' },
      safetyPolicies: any ? [{ nodeId: 'race', policyRef: 'exact-policy' }] : [] });
    assert.equal(result.status, variant === 'any-denied' ? 'needs-clarification' : 'candidate-ready', variant + JSON.stringify(result.diagnostics));
    assert.equal(policyChecks, any ? 1 : 0);
    if (!any) assert.equal(result.candidate.manifest.mode, 'interactive-p0-a');
  }
});

test('I2 S35/S45: trusted no-effect retry consumes one reference and inherits the original total request budget and deadline', async t => {
  const f = await setup(t, { budgetPolicy: { maxRequests: 5 } }); const raw = f.options.execution.request;
  let cut = true;
  f.options.execution.request = async input => {
    if (cut && input.prepared?.task.node.id === 'dsl-source') { cut = false; f.calls.push(input); throw new Error('controlled no-effect transport failure'); }
    return raw(input);
  };
  const draft = await f.start();
  const input = { draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'original', input: 'Inspect' };
  const failed = await f.host.advanceTurn(input, context); assert.equal(failed.status, 'failed');
  const settled = await f.host.settleTurn({ draftId: draft.id, expectedStateVersion: failed.stateVersion,
    turnId: input.turnId, decision: 'confirm-no-effect', evidenceRef: 'controlled-no-effect' }, context);
  assert.ok(settled.retryRef); assert.equal(settled.budget.used.requests, 3);
  const retryInput = { ...input, expectedStateVersion: settled.stateVersion, kind: 'retry', retryRef: settled.retryRef };
  const exhausted = await f.host.advanceTurn(retryInput, context);
  assert.equal(exhausted.status, 'needs-revision', JSON.stringify(exhausted.diagnostics)); assert.equal(f.calls.length, 5);
  const replay = await f.host.advanceTurn(retryInput, context); assert.equal(replay.status, exhausted.status); assert.equal(f.calls.length, 5);
  const after = await f.host.settleTurn({ draftId: draft.id, expectedStateVersion: (await current(f, draft)).stateVersion,
    turnId: input.turnId, decision: 'confirm-no-effect', evidenceRef: 'controlled-exhausted' }, context);
  assert.equal(after.budget.deadlineMs, settled.budget.deadlineMs); assert.equal(after.budget.used.requests, 5);
});
