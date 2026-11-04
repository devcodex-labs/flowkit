import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourceSnapshot, createCompileContext } from '../../src/compiler/source.mjs';
import { extractWorkflow } from '../../src/compiler/extract.mjs';

const imports = "import {defineWorkflow as wf, node, action, verification, parallel, condition, loop, human, terminal as end} from '@devcodex/flowkit/dsl';\n";
const source = (nodes, extras = '') => `${imports}export default wf({id:'demo',version:'1.0.0',name:'示例',nodes:[${nodes}]${extras}});`;
const extract = (text, ext = 'js') => extractWorkflow(createSourceSnapshot(text, `fixtures/demo.workflow.${ext}`));

test('extracts aliased constructors without running the DSL and preserves own schema keys', () => {
  const result = extract(source("node('work',{name:'工作',agent:'writer',output:{type:'object',properties:{'__proto__':{type:'string'},'a/b~c':{default:-2}}},next:'done'}),end('done',{name:'结束',status:'succeeded'})"));
  assert.deepEqual(result.diagnostics, []);
  const { definition, constructors, locations } = result.literal;
  assert.equal(definition.nodes[0].type, 'agent');
  assert.equal(constructors.get('/nodes/0').kind, 'node');
  assert.equal(Object.hasOwn(definition.nodes[0].output.properties, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(definition.nodes[0].output.properties), Object.prototype);
  assert.equal(definition.nodes[0].output.properties['a/b~c'].default, -2);
  assert.ok(locations.has('/nodes/0/output/properties/a~1b~0c/default'));
});

test('strips erasable TypeScript while preserving BOM, CRLF, Unicode, raw hash and positions', () => {
  const text = '\uFEFF' + imports.replaceAll('\n', '\r\n') +
    "type Metadata = {x: string};\r\nexport default wf({\r\n  id:'demo',version:'1.0.0',name:'示例',nodes:[\r\n    end('done',{name:'结束',status:'succeeded' as const})\r\n  ]\r\n} satisfies Record<string, unknown>);";
  const bytes = Buffer.from(text);
  const snapshot = createSourceSnapshot(bytes, 'fixtures/demo.workflow.ts');
  bytes.fill(0);
  const result = extractWorkflow(snapshot);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(snapshot.sourceText, text);
  assert.equal(snapshot.sourceHash, createHash('sha256').update(Buffer.from(text)).digest('hex'));
  assert.deepEqual(result.literal.locations.get('/nodes/0/id'), { line: 5, column: 9 });
  assert.deepEqual(result.literal.keyLocations.get('/nodes/0/status'), { line: 5, column: 27 });
});

test('rejects executable and nonliteral syntax without executing side effects', () => {
  const bad = [
    source("end('done',{name:'End',status:value})"), source("end('done',{name:'End',status:fn()})"),
    source("end('done',{name:'End',...{status:'succeeded'}})"),
    source("end('done',{get name(){throw 1},status:'succeeded'})"),
    source("end('done',{['name']:'End',status:'succeeded'})"),
    source("end('done',{name:`End`,status:'succeeded'})"),
    source("end('done',{name:'End',status:undefined})"), source("end('done',{name:'End',status:1n})"),
    source("end('done',{name:'End',status:/x/})"), source("end('done',{name:'End',status:1e999})"),
    source("end('done',{name:'End',name:'Again',status:'succeeded'})"),
    source("end('done',{name:'End',status:'succeeded'})") + '\nglobalThis.__flowkitExecuted = true;',
    source("end('done',{name:'End',status:'succeeded'})").replace('export default', 'const x = 1; export default'),
    source("{id:'done',name:'End',type:'terminal',status:'succeeded'}"),
    source("end('done',{name:'End',status:'succeeded'})", ',extra:{nested:node(\'x\',{})}'),
    "import * as dsl from '@devcodex/flowkit/dsl'; export default dsl.defineWorkflow({});",
    "import dsl from '@devcodex/flowkit/dsl'; export default dsl({});",
    source("end('done',{name:'End',status:'succeeded'})").replace('@devcodex/flowkit/dsl', 'node:fs'),
    source("end('done',{name:'End',status:'succeeded'}),,"),
  ];
  for (const text of bad) {
    const result = extract(text);
    assert.equal(result.literal, null, text);
    assert.equal(result.diagnostics[0].code, 'FK_C007', text);
    assert.ok(result.diagnostics[0].line >= 1);
    assert.ok(result.diagnostics[0].column >= 1);
  }
  assert.equal(Object.hasOwn(globalThis, '__flowkitExecuted'), false);
});

test('reports syntax and unsupported TS as C007 with source positions', () => {
  const syntax = extract(imports + '\nexport default wf({nodes:[});');
  assert.equal(syntax.diagnostics[0].line, 3);
  const unsupported = extract(imports + '\n enum Mode { A }\n' + source(''), 'ts');
  assert.equal(unsupported.diagnostics[0].code, 'FK_C007');
  assert.equal(unsupported.diagnostics[0].line, 3);
  for (const declaration of ['namespace Mode { export const a = 1; }', 'class Mode { constructor(public a: number){} }',
    'enum Mode {\n  A,\n  B\n}', 'type Mode = { a: ; }']) {
    const issue = extract(imports + '\n' + declaration, 'ts').diagnostics[0];
    assert.equal(issue.code, 'FK_C007');
    assert.equal(issue.line, 3, declaration);
  }
  for (const declaration of ['    enum Mode { A }', '    namespace Mode { export const a = 1; }',
    '    class Mode {constructor(public x: number){}}', '    type Mode = { x: ; }', '\tenum Mode { A }',
    '  /*中文*/enum Mode { A }', '  class 中文 {constructor(public x: number){}}',
    ...['e\u0301', 'Ａ', '\u200d', '❤\ufe0f', '😀', '👩‍💻'].map(text => `  /*${text}*/enum Mode { A }`)]) {
    const issue = extract('\n\n' + declaration, 'ts').diagnostics[0];
    const token = declaration.includes('constructor') ? 'x:' : declaration.includes('type Mode') ? ';' :
      declaration.includes('enum') ? 'enum' : 'namespace';
    assert.equal(issue.line, 3);
    assert.equal(issue.column, declaration.indexOf(token) + 1, declaration);
  }
  const firstLine = extract('  /*中文*/enum Mode { A }', 'ts').diagnostics[0];
  assert.deepEqual({line:firstLine.line, column:firstLine.column}, {line:1, column:9});
  for (const prefix of ['', '\n\n']) {
    const bom = extract(prefix + '\uFEFFenum Mode { A }', 'ts').diagnostics[0];
    assert.deepEqual({line:bom.line, column:bom.column}, {line:prefix ? 3 : 1, column:2});
  }
});

test('records source property order even when JS enumerates numeric keys differently', () => {
  const result = extract(source("node('n',{name:'N',agent:'writer',output:{type:'object',properties:{'2':{},'1':{},'__proto__':{}}},next:'done'})"));
  assert.deepEqual(result.literal.propertyOrder.get('/nodes/0/output/properties'), ['2','1','__proto__']);
});

test('keeps mismatched type and constructor option names visible to validation', () => {
  const result = extract(source("end('done',{id:'other',type:'agent',name:'End',status:'succeeded'})"));
  assert.equal(result.literal.definition.nodes[0].id, 'done');
  assert.equal(result.literal.definition.nodes[0].type, 'agent');
  assert.equal(result.literal.constructors.get('/nodes/0').type, 'terminal');
  assert.ok(result.literal.constructors.get('/nodes/0').optionKeys.includes('id'));
});

test('checks source and option boundaries without invoking optional fetch', () => {
  assert.throws(() => createSourceSnapshot('', 'bad.ts'), TypeError);
  assert.throws(() => createSourceSnapshot(Buffer.from([0xff]), 'bad.workflow.ts'), TypeError);
  const snapshot = createSourceSnapshot(source(''), 'demo.workflow.js');
  for (const options of [null, [], { extra: true }, { trace: 'yes' }, { remoteSkillHosts: [4] }, { fetch: 1 }]) {
    assert.throws(() => createCompileContext(snapshot, options), TypeError);
  }
  const context = createCompileContext(snapshot, { skillCheck: false, fetch() { throw Error('called'); } });
  assert.equal(context.skillCheck, false);
  assert.equal(context.projectRoot, process.cwd());
  const inherited = createCompileContext(snapshot, Object.create({ trace: 'bad', skillsRoot: 4 }));
  assert.equal(inherited.trace, false);
  assert.equal(inherited.skillsRoot, 'skills');
  assert.throws(() => createCompileContext(snapshot, { remoteSkillHosts: Array(1) }), TypeError);
  assert.throws(() => createCompileContext(snapshot, Object.defineProperty({}, 'unknown', { value: true })), TypeError);
});
