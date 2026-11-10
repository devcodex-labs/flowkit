import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../../src/compiler/analyze.mjs';
import { gateInteractiveFeatures } from '../../src/compiler/interactive/feature-gate.mjs';
import { lowerInteractive } from '../../src/compiler/interactive/lower.mjs';

const imports = "import {defineWorkflow,node,action,verification,condition,terminal} from '@devcodex-labs/flowkit/dsl';";
const workflow = nodes => imports + '\nexport default defineWorkflow({id:"m1-demo",version:"1.0.0",name:"M1",nodes:[' + nodes.join(',') + ']});';
const done = "terminal('done',{name:'Done',status:'succeeded'})";
const failed = "terminal('failed',{name:'Failed',status:'failed'})";
const condition = "condition('gate',{name:'Gate',branches:[{when:'ready',next:'worker'},{when:'true',next:'failed'}]})";
const worker = "node('worker',{name:'Worker',agent:'writer',inputs:['request'],output:{type:'object',properties:{result:{type:'string'}}},next:'done'})";
const analyze = (text, suffix = 'js') => analyzeSource(text, {
  filename: 'virtual.workflow.' + suffix, projectRoot: process.cwd(), skillCheck: false,
});

test('M1 uses the real Standard analyzer for JS and TS, preserving diagnostics', async () => {
  const source = workflow([condition, worker, done, failed]);
  const analysis = await analyze(source);
  assert.equal(analysis.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(analysis.diagnostics));
  assert.ok(analysis.graph);
  assert.ok(analysis.conditions.get('/nodes/0/branches/0/when'));
  assert.ok(analysis.dataflow.inputs instanceof Map);
  const result = lowerInteractive(analysis);
  assert.ok(result.ir);
  assert.deepEqual(result.diagnostics, analysis.diagnostics);
  assert.equal(result.ir.workflowId, 'm1-demo');
  assert.equal(result.ir.nodes.worker.metadata.retries, 2);
  assert.deepEqual(result.ir.nodes.worker.metadata.inputs, ['request']);
  const typed = source.replace("status:'succeeded'", "status:'succeeded' as const");
  const tsResult = await analyze(typed, 'ts');
  assert.equal(tsResult.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(tsResult.diagnostics));
  assert.equal(lowerInteractive(tsResult).ir.nodes.done.kind, 'terminal');
});

test('a valid Standard Action or Verification is rejected by the P0-A gate', async () => {
  const actionText = workflow([
    "action('write',{name:'Write',action:'publish',writes:['result'],next:'done'})", done,
  ]);
  const actionAnalysis = await analyze(actionText);
  assert.equal(actionAnalysis.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(actionAnalysis.diagnostics));
  const actionGate = lowerInteractive(actionAnalysis);
  assert.equal(actionGate.ir, null);
  assert.ok(actionGate.diagnostics.some(d => d.code === 'FK_I_UNSUPPORTED_NODE' && d.nodeId === 'write'));
  const verificationAnalysis = await analyze(workflow([
    "verification('verify',{name:'Verify',verifier:'check',onSuccess:'done',onFailure:'failed'})",
    done, failed,
  ]));
  assert.equal(verificationAnalysis.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(verificationAnalysis.diagnostics));
  assert.equal(lowerInteractive(verificationAnalysis).ir, null);
});

test('P0-A explicitly rejects Agent verify; it must never silently skip the callback', async () => {
  const text = workflow([worker.replace("next:'done'", "verify:'safety',next:'done'"), done]);
  const a = await analyze(text);
  assert.equal(a.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(a.diagnostics));
  const { ir, diagnostics } = lowerInteractive(a);
  assert.equal(ir, null);
  assert.ok(diagnostics.some(d => d.code === 'FK_I_UNSUPPORTED_BINDING'));
});

test('featureStage is bounded by the built-in implemented stage, not caller options', async () => {
  const a = await analyze(workflow([done]));
  assert.equal(gateInteractiveFeatures(a).ok, true);
  for (const stage of ['P0-B', 'P1']) {
    const result = lowerInteractive(a, { featureStage: stage });
    assert.equal(result.ir, null);
    assert.ok(result.diagnostics.some(d => d.code === 'FK_I_UNSUPPORTED_STAGE'));
  }
  assert.equal(lowerInteractive(a, { featureStage: 'P2' }).diagnostics
    .some(d => d.code === 'FK_I_INVALID_STAGE'), true);
});

test('invalid Standard Graph is rejected before lowering; original FK_C diagnostics survive', async () => {
  const a = await analyze(workflow([
    "node('worker',{name:'Worker',agent:'writer',output:{type:'object'},next:'missing'})", done,
  ]));
  assert.ok(a.diagnostics.some(d => d.code === 'FK_C015'));
  const result = lowerInteractive(a);
  assert.equal(result.ir, null);
  assert.deepEqual(result.diagnostics, a.diagnostics);
});

test('pure Condition/Terminal does not require any Agent runtime binding', async () => {
  const a = await analyze(workflow([
    "condition('gate',{name:'Gate',branches:[{when:'ready',next:'done'},{when:'true',next:'failed'}]})",
    done, failed,
  ]));
  assert.equal(a.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(a.diagnostics));
  const result = lowerInteractive(a);
  assert.ok(result.ir);
  assert.equal(Object.values(result.ir.nodes).some(n => n.kind === 'agent'), false);
});
