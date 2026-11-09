import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parse } from 'acorn';
import { printValue, localName } from '../../src/compiler/values.mjs';
import { compilationPaths } from '../../src/compiler/paths.mjs';
import { analyzeSource } from '../../src/compiler/analyze.mjs';
import { checkMermaidIds, renderMermaid } from '../../src/compiler/mermaid.mjs';

const analyze = nodes => analyzeSource(`import {defineWorkflow,node,action,parallel,verification,loop,human,terminal,condition} from '@devcodex-labs/flowkit/dsl';export default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[${nodes.join(',')}]});`,
  { filename:'format.workflow.js', skillCheck:false });
const end="terminal('done',{name:'Done',status:'succeeded'})";

test('prints nested own special keys, source property order, strings and negative zero as valid JS', () => {
  const value=JSON.parse('{"__proto__":{"2":{},"1":{},"default":"line\\n\\\""},"a/b~c":[null,true]}');
  value.minus=-0;
  const order=new Map([['',['__proto__','a/b~c','minus']],['/__proto__',['2','1','default']]]);
  const code=printValue(value,'',order);
  parse(`const value=${code}`,{ecmaVersion:2025});
  assert.ok(code.includes('["__proto__"]'));
  assert.ok(code.indexOf('"2"')<code.indexOf('"1"'));
  assert.ok(code.includes('"minus": -0'));
  assert.notEqual(localName(0,'a-1'),localName(1,'a1'));
  assert.match(localName(2,'class'),/^n2_/);
});

test('resolves encoded source-relative headers while rejecting sibling or descendant output roots', () => {
  const filename=path.resolve('fixtures/中文 空格/a#b.workflow.ts');
  const result=compilationPaths(filename,{outDir:path.resolve('fixtures')});
  assert.equal(result.source,'%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC/a%23b.workflow.ts');
  assert.equal(path.basename(result.codeFile),'a#b.compiled.mjs');
  assert.equal(path.basename(result.mermaidFile),'a#b.mmd');
  assert.throws(()=>compilationPaths(filename,{outDir:path.resolve('elsewhere')}),TypeError);
  assert.throws(()=>compilationPaths(filename,{outDir:path.join(path.dirname(filename),'child')}),TypeError);
});

test('detects PascalCase collisions without changing valid workflow ids', async () => {
  const result=await analyze(["action('a-1',{name:'A',action:'save',next:'a1'})","terminal('a1',{name:'B',status:'succeeded'})"]);
  assert.deepEqual(result.diagnostics,[]);
  assert.deepEqual(checkMermaidIds(result).map(d=>[d.code,d.nodeId]),[['FK_C090','a1']]);
});

test('draws parallel regions, condition labels, proper verification shapes and explicit exception edges', async () => {
  const result=await analyze(["parallel('p',{name:'P',branches:['a','v'],join:{strategy:'any',next:'c'}})",
    "action('a',{name:'A',action:'save'})","verification('v',{name:'V',verifier:'check'})",
    "condition('c',{name:'C',branches:[{when:\"value === 'a|b'\",next:'h'},{when:'true',next:'done'}]})",
    "human('h',{name:'H',onApprove:'done',onReject:'repair'})","action('repair',{name:'Repair',action:'fix',next:'h'})",end]);
  assert.deepEqual(result.diagnostics,[]);
  const text=renderMermaid(result);
  assert.ok(text.startsWith('flowchart TD\n'));
  assert.ok(text.includes('subgraph P["P · any"]'));
  assert.ok(text.includes('V{"V"}'));
  assert.ok(text.includes("#124;"));
  assert.ok(text.includes('控制信号 / 全部业务失败'));
  assert.ok(text.includes('-. "控制信号 / 全部业务失败" .->'));
  assert.ok(text.includes('H -- "批准" --> Done'));
  assert.ok(text.includes('Repair --> H'));
});

test('draws loop pass as an exit and exhaustion as dashed, without a fake pass backedge', async () => {
  const result=await analyze(["loop('l',{name:'L',maxIterations:1,body:'v',onSuccess:'done',onMaxExceeded:'done'})",
    "verification('v',{name:'V',verifier:'check',onSuccess:'l',onFailure:'repair'})",
    "action('repair',{name:'Repair',action:'fix',next:'v'})",end]);
  assert.deepEqual(result.diagnostics,[]);
  const text=renderMermaid(result);
  assert.ok(text.includes('V -- "成功" --> Done'));
  assert.ok(text.includes('V -. "超过次数（第1次失败不再修复）" .-> Done'));
  assert.ok(!text.includes('第1–0'));
  assert.ok(!text.includes('V --> L'));
});
