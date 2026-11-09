import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../../src/compiler/analyze.mjs';

const imports="import {defineWorkflow,node,action,verification,parallel,condition,loop,human,terminal} from '@devcodex-labs/flowkit/dsl';";
const end="terminal('done',{name:'Done',status:'succeeded'})";
const agent=(id,next,inputs=[],properties={})=>`node('${id}',{name:'${id}',agent:'writer',inputs:${JSON.stringify(inputs)},output:{type:'object',properties:${JSON.stringify(properties)}},next:'${next}'})`;
const analyze=nodes=>analyzeSource(`${imports}\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[${nodes.join(',')}]});`,{filename:'data.workflow.js',skillCheck:false});
const codes=result=>result.diagnostics.map(d=>d.code);

test('warns only for declared outputs absent on all reaching paths; host initial keys stay valid',async()=>{
  const result=await analyze([agent('read','write',['later','initial']),agent('write','done',[],{later:{type:'string'}}),end]);
  assert.deepEqual(codes(result),['FK_C053']);
  assert.equal(result.diagnostics[0].severity,'warning');
  assert.equal(result.diagnostics[0].nodeId,'read');
  assert.deepEqual([...result.dataflow.inputs.get('read')],[]);
  assert.ok(result.dataflow.inputs.get('done').has('later'));
});

test('a write on some paths suppresses C053 while its placement after the reader does not',async()=>{
  const branch="condition('choose',{name:'Choose',branches:[{when:'flag',next:'write'},{when:'true',next:'read'}]})";
  const nodes=[branch,agent('write','read',[],{key:{}}),agent('read','done',['key']),end];
  const result=await analyze(nodes);
  assert.deepEqual(codes(result),[]);
  assert.ok(result.dataflow.inputs.get('read').has('key'));
  const allMissing=await analyze([agent('read','write',['key']),agent('write','done',[],{key:{}}),end]);
  assert.deepEqual(codes(allMissing),['FK_C053']);
});

test('parallel any uses conservative join union without granting sibling writes before execution',async()=>{
  const p="parallel('p',{name:'P',branches:['a','b'],join:{strategy:'any',next:'read'}})";
  const a="node('a',{name:'A',agent:'writer',output:{type:'object',properties:{x:{}}}})";
  const b="node('b',{name:'B',agent:'writer',inputs:['x'],output:{type:'object',properties:{y:{}}}})";
  const result=await analyze([p,a,b,agent('read','done',['x','y']),end]);
  assert.deepEqual(result.diagnostics.map(d=>[d.code,d.nodeId]),[['FK_C053','b']]);
  assert.ok(result.dataflow.inputs.get('read').has('x'));
  assert.ok(result.dataflow.inputs.get('read').has('y'));
});

test('loop fixed point carries prior-iteration writes and human decisions have declared own keys',async()=>{
  const result=await analyze(["loop('l',{name:'Loop',maxIterations:3,body:'v',onSuccess:'h',onMaxExceeded:'done'})",
    "verification('v',{name:'V',verifier:'test',onSuccess:'l',onFailure:'read'})",
    agent('read','write',['x']),agent('write','v',[],{x:{}}),
    "human('h',{name:'H',onApprove:'after',onReject:'repair'})",
    "action('repair',{name:'Repair',action:'save',next:'h'})",agent('after','done',['h']),end]);
  assert.deepEqual(codes(result),[]);
  assert.ok(result.dataflow.inputs.get('read').has('x'));
  assert.ok(result.dataflow.inputs.get('after').has('h'));
  assert.ok(result.graph.writeSets.get('h').has('h'));
});

test('uses exact own special keys and parallel verification ids as write declarations',async()=>{
  const properties=Object.fromEntries(['__proto__','constructor','toString'].map(key=>[key,{}]));
  const result=await analyze([agent('write','read',[],properties),agent('read','done',['__proto__','constructor','toString']),end]);
  assert.deepEqual(codes(result),[]);
  assert.deepEqual([...result.graph.writeSets.get('write')],['__proto__','constructor','toString']);
  const parallel=await analyze(["parallel('p',{name:'P',branches:['a','v'],join:{strategy:'all_succeeded',next:'read'}})",
    "action('a',{name:'A',action:'save'})","verification('v',{name:'V',verifier:'test'})",agent('read','done',['v']),end]);
  assert.deepEqual(codes(parallel),[]);
  assert.ok(parallel.dataflow.inputs.get('read').has('v'));
});

test('does not emit speculative dataflow warnings after a broken graph dependency',async()=>{
  const result=await analyze([agent('read','missing',['x']),agent('write','done',[],{x:{}}),end]);
  assert.deepEqual(codes(result),['FK_C015']);
  assert.equal(result.dataflow,null);
});
