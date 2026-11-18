import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, context, intent, proposal, source } from './author-host-fixture.mjs';
import { runArtifact, isControlSignal } from '../../src/index.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { compileArtifactDraft } from '../../src/compiler/api.mjs';

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
function replacePlan(f, change) {
  const request = f.options.execution.request;
  f.options.execution.request = async input => input.prepared?.task.node.id === 'proposal' ?
    (f.calls.push(input), agentResult({ rawText: JSON.stringify(change(structuredClone(proposal))) })) : request(input);
}

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
  assert.equal(reused.status, 'candidate-ready', JSON.stringify(reused.diagnostics));
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

test('I2 S06/S07/S56/S57/S58/S81: update pins an exact no-DSL baseline and preserves old approved Run bytes', async t => {
  const f = await setup(t); await f.register(); const first = await advance(f, await f.start());
  await save(f, await approve(f, first));
  assert.equal(first.candidate.files['source/workflow.dsl.js'], undefined);
  await assert.rejects(f.start({ requestId: 'ambiguous', operation: 'update', target: { name: 'inspect', version: '2.0.0' } }), /TargetRef/);
  const targetRef = { collectionId: 'team', skillId: first.target.skillId, baseArtifactHash: first.candidate.manifest.artifactHash, baseVersion: '1.0.0' };
  await assert.rejects(f.start({ requestId: 'wrong', operation: 'update', targetRef: { ...targetRef, baseArtifactHash: 'sha256:' + 'b'.repeat(64) } }), /baseline/);
  await assert.rejects(f.start({ requestId: 'same', operation: 'update', targetRef, target: { version: '1.0.0' } }), /unused version/);
  const update = await f.start({ requestId: 'update', operation: 'update', targetRef, target: { name: 'inspect', description: 'Updated', version: '2.0.0' } });
  const ready = await advance(f, update, { input: 'Inspect with the existing API retained' });
  assert.equal(ready.status, 'candidate-ready', JSON.stringify(ready.diagnostics)); assert.equal(ready.target.skillId, first.target.skillId);
  assert.equal(ready.previousHash, first.candidate.hash); assert.equal(ready.candidate.manifest.version, '2.0.0');
  const review = f.calls.filter(call => call.prepared?.task.node.id === 'semantic-review').at(-1).prepared.task.input;
  assert.deepEqual(Object.keys(review).sort(), ['authorizedRequest', 'effectiveIntent', 'intentChanges', 'baselineEvidence', 'currentPlan', 'candidate', 'candidateDiff', 'resourceSnapshot'].sort());
  assert.equal(review.baselineEvidence.workflow.manifest.artifactHash, first.candidate.manifest.artifactHash);
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
    replacePlan(f, plan => ({ ...plan, entryNodeId: 'approval', nodes: [{ id: 'approval', kind: 'human' }, { id: 'revise', kind: 'action' }, { id: 'done', kind: 'terminal' }], edges: [
      { from: 'approval', to: 'done', kind: 'control' }, { from: 'approval', to: 'revise', kind: 'control' }, { from: 'revise', to: 'approval', kind: 'control' }] }));
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
  const targetContext = { ...context, collectionIds: ['copy'] };
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

test('I2 S19/S75/S80: exact compiled any policy is required; supported P0-A Agent target stays in its selected mode', async t => {
  for (const variant of ['any-denied', 'any-approved', 'p0-a']) {
    const f = await setup(t); const any = variant.startsWith('any');
    const text = any ? `import {defineWorkflow,parallel,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'any',version:'1.0.0',name:'Any',nodes:[parallel('race',{name:'Race',branches:['one','two'],join:{strategy:'any',next:'done'}}),action('one',{name:'One',action:'one'}),action('two',{name:'Two',action:'two'}),terminal('done',{name:'Done',status:'succeeded'})]});` :
      `import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';export default defineWorkflow({id:'basic',version:'1.0.0',name:'Basic',nodes:[node('work',{name:'Work',description:'Inspect',output:{type:'object'},next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
    const file = path.join(f.dir, 'target.workflow.js'); await writeFile(file, text);
    const compiled = await compileArtifactDraft(file, { skillCheck: false });
    replacePlan(f, plan => ({ ...plan, entryNodeId: compiled.definition.nodes[0].id,
      nodes: compiled.definition.nodes.map(node => ({ id: node.id, kind: node.type })),
      edges: [...compiled.graph.referenceEdges, ...compiled.graph.executionEdges].map(({ from, to }) => ({ from, to, kind: 'control' })) }));
    const request = f.options.execution.request;
    f.options.execution.request = async input => input.prepared?.task.node.id === 'dsl-source' ?
      (f.calls.push(input), agentResult({ rawText: text })) : request(input);
    let policyChecks = 0;
    f.options.authorization.verifySafetyPolicy = async binding => { policyChecks++; assert.equal(binding.artifactHash, compiled.artifact.artifactHash); return variant === 'any-approved'; };
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
    turnId: input.turnId, decision: 'confirm-no-effect' }, context);
  assert.ok(settled.retryRef); assert.equal(settled.budget.used.requests, 3);
  const retryInput = { ...input, expectedStateVersion: settled.stateVersion, kind: 'retry', retryRef: settled.retryRef };
  const exhausted = await f.host.advanceTurn(retryInput, context);
  assert.equal(exhausted.status, 'needs-revision', JSON.stringify(exhausted.diagnostics)); assert.equal(f.calls.length, 5);
  const replay = await f.host.advanceTurn(retryInput, context); assert.equal(replay.status, exhausted.status); assert.equal(f.calls.length, 5);
  const after = await f.host.settleTurn({ draftId: draft.id, expectedStateVersion: (await current(f, draft)).stateVersion,
    turnId: input.turnId, decision: 'confirm-no-effect' }, context);
  assert.equal(after.budget.deadlineMs, settled.budget.deadlineMs); assert.equal(after.budget.used.requests, 5);
});
