import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../../src/compiler/analyze.mjs';
import { lowerInteractive } from '../../src/compiler/interactive/lower.mjs';
import { validateInteractiveIR, interactiveBlockId } from '../../src/compiler/interactive/validate-ir.mjs';
import { evaluateWhenAst } from '../../src/when/evaluate.mjs';

const imports = "import {defineWorkflow,node,condition,terminal} from '@devcodex-labs/flowkit/dsl';";
const declarations = [
  "condition('gate',{name:'Gate',branches:[{when:'ready && review.approved',next:'worker'},{when:'true',next:'failed'}]})",
  "node('worker',{name:'Worker',agent:'writer',inputs:['missing'],output:{type:'object',properties:{answer:{type:'string'}}},retries:2,overview:true,next:'done'})",
  "terminal('done',{name:'Done',status:'succeeded'})",
  "terminal('failed',{name:'Failed',status:'failed'})",
];
const source = (nodes = declarations) => imports
  + '\nexport default defineWorkflow({id:"ir-test",version:"1.0.0",name:"IR",nodes:['
  + nodes.join(',') + ']});';
const analyze = text => analyzeSource(text, {
  filename: 'ir.workflow.js', projectRoot: process.cwd(), skillCheck: false,
});
const make = async () => lowerInteractive(await analyze(source())).ir;

test('stable IR from original Graph, Dataflow and when AST includes all P0-A phases', async () => {
  const first = await make();
  const second = await make();
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(validateInteractiveIR(first).ok, true);
  assert.equal(first.entryBlockId, 'gate::enter');
  assert.equal(first.blocks.length, 13);
  assert.ok(Object.isFrozen(first.blocks));
  assert.ok(Object.isFrozen(first.nodes.worker.metadata));
  const graph = first.graphEdges;
  assert.ok(graph.some(e => e.from === 'gate' && e.to === 'worker'));
  assert.ok(graph.some(e => e.from === 'worker' && e.to === 'done'));
  assert.ok(first.dataflow.worker);
  assert.deepEqual(first.nodes.worker.metadata.inputs, ['missing']);
  assert.equal(first.frameRules.length, 1);
  assert.equal(first.frameRules[0].pushBlockId, 'worker::enter');
  assert.equal(first.frameRules[0].popBlockId, 'worker::route');
  assert.ok(first.frameRules[0].fields.includes('overviewStep'));
  assert.equal(first.nodes.worker.metadata.retries, 2);
  assert.equal(first.nodes.worker.metadata.overview, true);
  const c = first.blocks.find(b => b.id === 'gate::route');
  assert.deepEqual(c.legalTargets, ['worker::enter', 'failed::enter']);
  assert.ok(c.proposalKinds.includes('raise-error')); // missing bool -> FK_R002
  const awaiting = first.blocks.find(b => b.id === 'worker::awaiting');
  assert.deepEqual(awaiting.proposalKinds, []);
  assert.equal(awaiting.acceptTarget, 'worker::validate');
  assert.ok(first.blocks.find(b => b.id === 'worker::validate').legalTargets.includes('worker::prepare'));
});

test('original parseWhen AST retains own-path booleans and short-circuit behavior', async () => {
  const ir = await make();
  const ast = ir.nodes.gate.metadata.branches[0].ast;
  assert.equal(evaluateWhenAst(ast, { ready: true, review: { approved: true } }), true);
  assert.equal(evaluateWhenAst(ast, { ready: false }), false);
  assert.throws(() => evaluateWhenAst(ast, {}), error => error.code === 'FK_R002');
});

test('IR validator rejects injected edges, events, duplicate blocks and missing phases', async () => {
  const original = await make();
  const mutated = () => JSON.parse(JSON.stringify(original));
  const badEdge = mutated();
  badEdge.blocks.find(b => b.id === 'gate::route').legalTargets[0] = 'wrong::enter';
  assert.equal(validateInteractiveIR(badEdge).ok, false);
  const badEvent = mutated();
  badEvent.blocks.find(b => b.id === 'worker::awaiting').eventKinds.push('external-cancel');
  assert.equal(validateInteractiveIR(badEvent).ok, false);
  const duplicate = mutated();
  duplicate.blocks.push(duplicate.blocks[0]);
  assert.equal(validateInteractiveIR(duplicate).ok, false);
  const absent = mutated();
  absent.blocks = absent.blocks.filter(b => b.id !== 'worker::commit');
  assert.equal(validateInteractiveIR(absent).ok, false);
  const changedTarget = mutated();
  changedTarget.nodes.worker.metadata.next = 'unknown';
  assert.equal(validateInteractiveIR(changedTarget).ok, false);
  const badFrame = mutated();
  badFrame.frameRules[0].popBlockId = 'unknown::route';
  assert.equal(validateInteractiveIR(badFrame).ok, false);
  const changedPhase = mutated();
  changedPhase.blocks.find(b => b.id === 'worker::validate').phase = 'awaiting';
  assert.equal(validateInteractiveIR(changedPhase).ok, false);
  const missingBranches = mutated();
  missingBranches.nodes.gate.metadata.branches = null;
  assert.equal(validateInteractiveIR(missingBranches).ok, false);
});

test('source-byte change changes source identity, without changing node block IDs', async () => {
  const base = await make();
  const adjusted = lowerInteractive(await analyze(source() + '\n// harmless source comment')).ir;
  assert.ok(adjusted);
  assert.notEqual(base.sourceHash, adjusted.sourceHash);
  assert.equal(base.entryBlockId, adjusted.entryBlockId);
  assert.equal(interactiveBlockId('worker', 'validate'), 'worker::validate');
});

test('only explicit own properties are preserved in Agent schema metadata', async () => {
  const ownSchema = source([
    "node('worker',{name:'Worker',agent:'writer',output:{type:'object',properties:{'__proto__':{type:'string'},normal:{type:'number'}}},next:'done'})",
    declarations[2],
  ]);
  const analysis = await analyze(ownSchema);
  assert.equal(analysis.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(analysis.diagnostics));
  const ir = lowerInteractive(analysis).ir;
  assert.ok(ir);
  assert.equal(Object.hasOwn(ir.nodes.worker.metadata.output.properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(ir.nodes.worker.metadata.output.properties), Object.prototype);
});
