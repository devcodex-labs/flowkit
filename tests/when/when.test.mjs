import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../../src/when/parser.mjs';
import { evalWhen } from '../../src/when/evaluate.mjs';

test('implements the documented grammar, comparison precedence and strict results', () => {
  const ctx = {state:{a:1,b:2,ready:true,empty:null,word:'中文',nested:{ok:true}}};
  for (const [source, expected] of [["!a === b",true], ['a < b && nested.ok',true],
    ['!!ready',true], ['false || true && false',false], ['!(a >= b)',true], ['a > -2.5',true],
    ["word === '中文'",true], ["'a' < 'b'",true], ['empty === null',true], ['a !== b',true],
    ['(a === 1) === true',true], ['true && (false || ready)',true], ['a <= b',true]]) {
    assert.equal(evalWhen(ctx,source),expected,source);
  }
});

test('reads own paths, preserves missing undefined and short circuits unvisited branches', () => {
  const state = Object.create({inherited:true});
  Object.defineProperty(state, 'bad', {get(){assert.fail('Unvisited getter');}});
  state.nil = null;
  for (const source of ['inherited === missing', 'nil.child === missing', 'true || bad', 'false && bad === true']) {
    assert.equal(evalWhen({state},source),source.startsWith('false')?false:true,source);
  }
  assert.equal(evalWhen({state:{own:{x:1}}}, 'own.x === 1'), true);
  assert.equal(evalWhen({state:{own:{}}}, 'own.toString === missing'), true);
});

test('reports syntax and forbidden structures with exact expression columns', () => {
  const examples = [['a()', 'FK_C033',2], ['a[0]', 'FK_C033',2], ['a = 1','FK_C033',3],
    ['`x`','FK_C033',1], ['globalThis.x','FK_C033',1], ['a.constructor','FK_C033',3],
    ['a.__proto__.x','FK_C033',3], ['a.prototype','FK_C033',3], ['this.x','FK_C033',1],
    ['true\n','FK_C034',5], ["'a\\b'",'FK_C034',3], ['true\u2028','FK_C034',5],
    ['a ===','FK_C032',6], ['(true','FK_C032',6], ["'x",'FK_C032',1], ['', 'FK_C032',1],
    ['a b','FK_C032',3], ['a < b < 3','FK_C032',7], ['a === !b','FK_C032',7],
    ['1e3 === 1000','FK_C032',2], ['true()','FK_C033',5], ['(true())','FK_C033',6],
    ['true && ((a)())','FK_C033',13], ['(false())','FK_C033',7], ['(null())','FK_C033',6],
    ['a.(b)','FK_C032',3], ['a.()','FK_C032',3], ['a.(true)','FK_C032',3]];
  for(const [source,code,column] of examples) assert.throws(()=>parseWhen(source), error=>error.code===code&&error.column===column,source);
  assert.throws(()=>parseWhen('9'.repeat(400)), {code:'FK_C032'});
});

test('rejects runtime boolean and relational type violations without coercion', () => {
  for(const source of ['1', 'missing', '!1', 'true && 1', 'false || 0', '1 < \'2\'', 'null > 0']) {
    assert.throws(()=>evalWhen({state:{}},source),{code:'FK_R002'},source);
  }
  assert.equal(evalWhen({state:{}}, 'missing === null'),false);
  assert.equal(evalWhen({state:{x:{}}}, 'x === x'),true);
  assert.throws(()=>evalWhen({state:{}},'a[0]'),{code:'FK_C033'});
  assert.throws(()=>parseWhen(null),TypeError);
});

test('parses and evaluates deep parentheses, unary prefixes and long logical chains without recursion overflow', () => {
  for(const source of ['('.repeat(5000)+'true'+')'.repeat(5000), '!'.repeat(10000)+'true', Array(10000).fill('true').join(' && ')]) {
    assert.equal(evalWhen({state:{}},source),true);
  }
});
