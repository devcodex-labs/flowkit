import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSnapshot, createCompileContext, sortDiagnostics } from '../../src/compiler/source.mjs';
import { extractWorkflow } from '../../src/compiler/extract.mjs';
import { isSemVer, validateFields } from '../../src/compiler/validate.mjs';
import { ERROR_CATALOG } from '../../src/shared/contracts.mjs';

const header = "import {defineWorkflow,node,action,verification,parallel,condition,loop,human,terminal} from '@devcodex-labs/flowkit/dsl';\n";
const terminal = "terminal('done',{name:'Done',status:'succeeded'})";
const definition = (nodes = terminal, fields = "id:'demo',version:'1.0.0',name:'Demo'") =>
  `${header}export default defineWorkflow({${fields},nodes:[${nodes}]});`;
const analyze = async source => {
  const snapshot = createSourceSnapshot(source, 'demo.workflow.js');
  const context = createCompileContext(snapshot, { skillCheck: false });
  const {literal, diagnostics} = extractWorkflow(snapshot);
  if(literal) diagnostics.push(...validateFields(literal, context));
  return {snapshot, diagnostics:sortDiagnostics(diagnostics)};
};
const codes = async source => (await analyze(source)).diagnostics.map(d => d.code);

test('accepts all eight node kinds and context-sensitive parallel member successors', async () => {
  const nodes = [
    "node('work',{name:'Work',agent:'writer',output:{type:'object',properties:{'__proto__':{type:'string'}}},inputs:['__proto__','constructor','toString'],retries:0,overview:true,verify:'check',next:'p'})",
    "parallel('p',{name:'Parallel',branches:['a','v','b'],join:{strategy:'any',next:'c'}})",
    "action('a',{name:'Action',action:'save',writes:['__proto__']})",
    "verification('v',{name:'Verify member',verifier:'test'})",
    "node('b',{name:'Agent member',skill:'skills/writer.md',output:{type:'object'}})",
    "condition('c',{name:'Condition',branches:[{when:'true',next:'l'}]})",
    "loop('l',{name:'Loop',maxIterations:100,body:'verify',onSuccess:'h',onMaxExceeded:'done'})",
    "verification('verify',{name:'Verify',verifier:'test',onSuccess:'l',onFailure:'repair'})",
    "action('repair',{name:'Repair',action:'repair',next:'verify'})",
    "human('h',{name:'Human',onApprove:'done',onReject:'repair'})", terminal,
  ];
  assert.deepEqual(await codes(definition(nodes.join(','))), []);
});

test('SemVer follows official core, prerelease and build rules without numeric rounding', () => {
  for (const value of ['0.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92',
    '1.0.0+20130313144700', '1.0.0-beta+exp.sha.5114f85', '1.0.0+001', '999999999999999999999999.0.0', '1.0.0--']) {
    assert.equal(isSemVer(value), true, value);
  }
  for (const value of [null, 1, '', 'v1.0.0', '1.0', '01.0.0', '1.00.0', '1.0.01', '1.0.0-01', '1.0.0-a..b',
    '1.0.0+', '1.0.0-a_1', '1.0.0\n', '1.0.0 a', '1.0.0-α', '1.0.0+001.']) assert.equal(isSemVer(value), false, String(value));
});

test('maps field failures to existing diagnostic codes with stable source positions', async () => {
  const fixtures = [
    ['FK_C001', definition(terminal, "id:'Bad',version:'1.0.0',name:'Demo'")],
    ['FK_C002', definition(terminal, "id:'demo',version:'1.01.0',name:'Demo'")],
    ['FK_C003', definition(terminal, "id:'demo',version:'1.0.0',name:'bad*/'")],
    ['FK_C004', definition('')],
    ['FK_C005', definition(Array.from({length:501}, (_,i)=>`terminal('n-${i}',{name:'End ${i}',status:'succeeded'})`).join(','))],
    ['FK_C006', definition(terminal, "id:'demo',version:'1.0.0',name:'Demo',budget:1")],
    ['FK_C010', definition("terminal('Bad',{name:'End',status:'succeeded'})")],
    ['FK_C011', definition(`${terminal},terminal('done',{name:'Other',status:'succeeded'})`)],
    ['FK_C012', definition("terminal('done',{name:'bad\\\\name',status:'succeeded'})")],
    ['FK_C013', definition(`${terminal},terminal('other',{name:'Done',status:'succeeded'})`)],
    ['FK_C014', definition("terminal('done',{name:'Done',type:'agent',status:'succeeded'})")],
    ['FK_C016', definition("action('save',{name:'Save',action:'save'})")],
    ['FK_C018', definition("terminal('done',{id:'other',name:'Done',status:'succeeded'})")],
    ['FK_C019', definition("action('save',{name:'Save',action:'save',writes:null,next:'done'})")],
    ['FK_C020', definition("parallel('p',{name:'P',branches:['a'],join:{strategy:'any',next:'done'}})")],
    ['FK_C021', definition("parallel('p',{name:'P',branches:['a','v'],join:{strategy:'any',next:'done'}}),action('a',{name:'A',action:'a',next:'done'})")],
    ['FK_C023', definition("parallel('p',{name:'P',branches:['a','v'],join:{strategy:'all',next:'done'}})")],
    ['FK_C025', definition("parallel('p',{name:'P',branches:['a','v'],join:{strategy:'any',next:'done'}}),verification('v',{name:'V',verifier:'v',onSuccess:'done'})")],
    ['FK_C030', definition("condition('c',{name:'C',branches:[]})")],
    ['FK_C031', definition("condition('c',{name:'C',branches:[{when:'false',next:'done'}]})")],
    ['FK_C034', definition("condition('c',{name:'C',branches:[{when:'true\\n',next:'done'}]})")],
    ['FK_C040', definition("loop('l',{name:'L',maxIterations:0,body:'v',onSuccess:'done',onMaxExceeded:'done'})")],
    ['FK_C050', definition("node('n',{name:'N',output:{type:'object'},next:'done'})")],
    ['FK_C054', definition("node('n',{name:'N',agent:'writer',output:{type:'array'},next:'done'})")],
    ['FK_C055', definition("node('n',{name:'N',agent:'writer',output:{type:'object'},retries:11,next:'done'})")],
    ['FK_C056', definition("action('a',{name:'A',action:'a',writes:['x','x',''],next:'done'})")],
    ['FK_C070', definition("terminal('done',{name:'Done',status:'ok'})")],
    ['FK_C007', definition("action('a',{name:'A',action:null,next:'done'})")],
  ];
  for (const [expected, text] of fixtures) {
    const result = await analyze(text);
    assert.ok(result.diagnostics.some(d => d.code === expected), `${expected}: ${JSON.stringify(result.diagnostics)}`);
    assert.deepEqual(result.diagnostics, (await analyze(text)).diagnostics);
    for (const d of result.diagnostics) {
      assert.equal(d.severity, ERROR_CATALOG[d.code].severity);
      assert.ok(d.line >= 1 && d.column >= 1);
      assert.match(d.file, /demo\.workflow\.js$/);
    }
  }
});

test('enforces field boundaries, nested exact fields, optional nulls and missing successors', async () => {
  const badNodes = [
    "node('n',{name:'N',agent:'writer',output:{type:'object',properties:null},next:'done'})",
    "node('n',{name:'N',agent:'writer',output:{type:'object'},overview:null,next:'done'})",
    "node('n',{name:'N',agent:'writer',output:{type:'object'},verify:null,next:'done'})",
    "node('n',{name:'N',agent:'writer',output:{type:'object'},inputs:[1],next:'done'})",
    "node('n',{name:'N',agent:'writer',output:{type:'object'},retries:0.5,next:'done'})",
    "parallel('p',{name:'P',branches:['a','b'],join:{strategy:'any',next:'done',extra:1}})",
    "condition('c',{name:'C',branches:[{when:'true',next:'done',extra:1}]})",
    "human('h',{name:'H',onApprove:'done'})",
    "verification('v',{name:'V',verifier:'v',onSuccess:'done'})",
  ];
  for (const node of badNodes) assert.ok((await codes(definition(node))).length, node);
  const exact = await analyze(definition("terminal('done',{name:'Done',unknown:1,status:'succeeded'})"));
  const issue = exact.diagnostics.find(d => d.code === 'FK_C018');
  assert.equal(issue.line, 2);
  assert.equal(issue.column, exact.snapshot.sourceText.split('\n')[1].indexOf('unknown') + 1);
  assert.equal(issue.nodeId, 'done');
  const fiveHundred = Array.from({length:500}, (_,i)=>`terminal('n-${i}',{name:'End ${i}',status:'succeeded'})`).join(',');
  assert.deepEqual(await codes(definition(fiveHundred)), []);
});

test('field validation stays independent from graph references and when grammar', async () => {
  assert.deepEqual(await codes(definition("action('a',{name:'A',action:'save',next:'missing'})")), []);
  assert.deepEqual(await codes(definition("condition('c',{name:'C',branches:[{when:'unsupported()',next:'a'},{when:'true',next:'a'}]})")), []);
});
