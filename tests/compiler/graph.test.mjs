import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSource } from '../../src/compiler/analyze.mjs';
import { EXIT } from '../../src/compiler/graph-algorithms.mjs';

const imports = "import {defineWorkflow,node,action,verification,parallel,condition,loop,human,terminal} from '@devcodex-labs/flowkit/dsl';";
const end = (id='done') => `terminal('${id}',{name:'${id}',status:'succeeded'})`;
const action = (id,next,extra='') => `action('${id}',{name:'${id}',action:'save',next:'${next}'${extra}})`;
const analyze = nodes => analyzeSource(`${imports}\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[${nodes.join(',')}]});`,
  {filename:'graph.workflow.js',skillCheck:false});
const issues = async nodes => (await analyze(nodes)).diagnostics.map(d=>d.code);
const loop = ["loop('l',{name:'Loop',maxIterations:3,body:'v',onSuccess:'done',onMaxExceeded:'failed'})",
  "verification('v',{name:'Verify',verifier:'test',onSuccess:'l',onFailure:'repair'})", action('repair','v'), end(), end('failed')];

test('builds ordinary and cross-merge control graphs with dominators, postdominators and stable joins', async () => {
  const result = await analyze(["condition('a',{name:'A',branches:[{when:'flag',next:'b'},{when:'true',next:'c'}]})",
    action('b','done'), "condition('c',{name:'C',branches:[{when:'flag',next:'b'},{when:'true',next:'done'}]})", end()]);
  assert.deepEqual(result.diagnostics,[]);
  assert.deepEqual([...result.graph.dominators.get('b')],['a','b']);
  assert.equal(result.graph.forward.joins.get('a'),'done');
  assert.equal(result.graph.forward.immediatePostDominators.get('a'),'done');
  assert.equal(result.graph.forward.immediatePostDominators.get('b'),'done');
  assert.equal(result.graph.forward.immediatePostDominators.get('done'),EXIT);
  const order = result.graph.forward.topologicalOrder;
  for(const edge of result.graph.forward.edges) assert.ok(order.indexOf(edge.from)<order.indexOf(edge.to));
  assert.equal(result.conditions.size,4);
});

test('accepts a normal loop entrance, pass sentinel and repair return without mutating DSL', async () => {
  const result = await analyze([action('start','l'),...loop]);
  assert.deepEqual(result.diagnostics,[]);
  const graph=result.graph;
  assert.equal(graph.owners.get('repair'),'l');
  assert.equal(graph.regions.get('l').kind,'loop');
  assert.ok(graph.legalBackEdges.has(JSON.stringify(['repair','v','next','/next'])));
  assert.ok(graph.executionEdges.some(e=>e.from==='v'&&e.to==='done'&&e.role==='loop-pass'));
  assert.ok(graph.executionEdges.some(e=>e.from==='v'&&e.to==='failed'&&e.role==='loop-exhausted'));
  assert.equal(result.literal.definition.nodes[2].onSuccess,'l');
  assert.ok(graph.dominators.get('repair').has('v'));
  assert.deepEqual(graph.forward.ids,['start','l','done','failed',EXIT]);
  assert.ok(graph.regions.get('l').forward.topologicalOrder.includes('repair'));
});

test('accepts a condition repair DAG and a human rejection cycle', async () => {
  const conditional = [...loop];
  conditional[2]="condition('repair',{name:'Repair',branches:[{when:'ok',next:'a'},{when:'true',next:'b'}]})";
  conditional.push(action('a','v'),action('b','v'));
  assert.deepEqual(await issues(conditional),[]);
  const human=await analyze(["human('h',{name:'Human',onApprove:'done',onReject:'repair'})",action('repair','h'),end()]);
  assert.deepEqual(human.diagnostics,[]);
  assert.equal(human.graph.owners.get('repair'),'h');
  assert.ok(human.graph.legalBackEdges.has(JSON.stringify(['repair','h','next','/next'])));
  assert.deepEqual(human.graph.forward.ids,['h','done',EXIT]);
});

test('owns parallel members and models their completion without exposing member jumps', async () => {
  const result=await analyze(["parallel('p',{name:'Parallel',branches:['a','v'],join:{strategy:'any',next:'done'}})",
    "action('a',{name:'A',action:'save',writes:['x']})", "verification('v',{name:'V',verifier:'test'})", end()]);
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(result.graph.parallelOwners.get('v'),'p');
  assert.deepEqual([...result.graph.writeSets.get('v')],['v']);
  assert.ok(result.graph.executionEdges.some(e=>e.from==='v'&&e.to==='done'&&e.role==='parallel-return'));
  assert.equal(result.graph.forward.joins.get('p'),'done');
});

test('maps missing references, reachability and invalid cycles without diagnostic cascades', async () => {
  assert.deepEqual(await issues([action('a','missing'),end()]),['FK_C015']);
  assert.deepEqual(await issues([end(),end('unused')]),['FK_C017']);
  assert.ok((await issues([action('a','b'),action('b','a')])).includes('FK_C080'));
  assert.deepEqual(await issues([action('a','a')]),['FK_C080']);
});

test('reports parallel type, external references, duplicated ownership and declared write collisions', async () => {
  const p="parallel('p',{name:'P',branches:['a','b'],join:{strategy:'any',next:'done'}})";
  const a="action('a',{name:'A',action:'save',writes:['x']})";
  const b="action('b',{name:'B',action:'save',writes:['x']})";
  assert.ok((await issues([p,a,b,end()])).includes('FK_C026'));
  assert.ok((await issues([p,a,"terminal('b',{name:'B',status:'failed'})",end()])).includes('FK_C022'));
  assert.ok((await issues([p,a,b,end()].map(x=>x===p?p.replace("next:'done'","next:'a'"):x))).includes('FK_C024'));
  assert.ok((await issues([p.replace("['a','b']","['a','a']"),a,end()])).includes('FK_C024'));
  assert.ok((await issues(["human('h',{name:'H',onApprove:'done',onReject:'a'})",action('a','h',",writes:['h']"),end()])).includes('FK_C026'));
});

test('rejects malformed loop bodies and repair regions with the dedicated codes', async () => {
  const replace = (index,text) => loop.map((item,i)=>i===index?text:item);
  const cases=[
    ['FK_C041',replace(1,action('v','repair'))],
    ['FK_C042',replace(1,"verification('v',{name:'Verify',verifier:'test',onSuccess:'done',onFailure:'repair'})")],
    ['FK_C042',replace(2,action('repair','done'))],
    ['FK_C043',replace(2,"parallel('repair',{name:'Repair',branches:['a','b'],join:{strategy:'any',next:'v'}})").concat(
      "action('a',{name:'A',action:'save'})","action('b',{name:'B',action:'save'})")],
    ['FK_C045',replace(2,"loop('repair',{name:'Repair',maxIterations:2,body:'v',onSuccess:'done',onMaxExceeded:'failed'})")],
    ['FK_C046',replace(2,"human('repair',{name:'Repair',onApprove:'v',onReject:'repair'})")],
    ['FK_C047',replace(2,action('repair','l'))],
    ['FK_C044',[action('start','v'),...loop]],
  ];
  for(const [code,nodes] of cases) assert.ok((await issues(nodes)).includes(code),code);
});

test('rejects human nonreturning and forbidden repair chains', async () => {
  const human="human('h',{name:'H',onApprove:'done',onReject:'repair'})";
  assert.ok((await issues([human,action('repair','done'),end()])).includes('FK_C060'));
  assert.ok((await issues([human,"condition('repair',{name:'Repair',branches:[{when:'true',next:'h'}]})",end()])).includes('FK_C061'));
});

test('preserves legal human repair prefixes, alternate entries and the actual initial target', async () => {
  const human="human('h',{name:'H',onApprove:'done',onReject:'repair'})";
  for (const prefix of [[action('start','repair')], [],
    ["condition('start',{name:'Start',branches:[{when:'flag',next:'repair'},{when:'true',next:'h'}]})"]]) {
    const nodes=prefix.length?[...prefix,human,action('repair','h'),end()]:[action('repair','h'),human,end()];
    const result=await analyze(nodes);
    assert.deepEqual(result.diagnostics,[]);
    const region=result.graph.regions.get('h');
    assert.ok(region.entryTargets.has('repair'));
    assert.equal(region.entryForwards.get('repair').entry,'repair');
    const forward=region.entryForwards.get('repair');
    assert.ok(forward.topologicalOrder.indexOf('repair')<forward.topologicalOrder.indexOf('h'));
    assert.equal(result.graph.forward.entryTarget,prefix.length?'start':'repair');
    if(prefix.length) assert.ok(result.graph.forward.edges.some(e=>e.targetNode==='repair'&&e.to==='h'));
  }
});

test('does not exempt normal approval or loop exit cycles through a legitimate repair return', async () => {
  for (const nodes of [
    ["human('h',{name:'H',onApprove:'h',onReject:'h'})"],
    ["human('h',{name:'H',onApprove:'repair',onReject:'repair'})",action('repair','h')],
    loop.map((text,index)=>index===0?text.replace("onSuccess:'done'","onSuccess:'repair'"):text),
    loop.map((text,index)=>index===0?text.replace("onMaxExceeded:'failed'","onMaxExceeded:'repair'"):text),
    [action('start','repair'),"human('h',{name:'H',onApprove:'start',onReject:'repair'})",action('repair','h')],
  ]) assert.ok((await issues(nodes)).includes('FK_C080'));
});

test('preserves action implicit failure edges to an ordinary verification', async () => {
  const result=await analyze([action('a','v'),"verification('v',{name:'V',verifier:'check',onSuccess:'done',onFailure:'failed'})",end(),end('failed')]);
  assert.deepEqual(result.diagnostics,[]);
  assert.ok(result.graph.executionEdges.some(e=>e.from==='a'&&e.to==='failed'&&e.role==='action-failure'));
  assert.ok(!result.graph.dominators.get('failed').has('v'));
});

test('checks when grammar independently while retaining original source locations', async () => {
  const result=await analyze(["condition('c',{name:'C',branches:[{when:'fn()',next:'done'},{when:'true',next:'done'}]})",end()]);
  const issue=result.diagnostics.find(d=>d.code==='FK_C033');
  assert.ok(issue.message.includes('expression column 3'));
  assert.deepEqual({line:issue.line,column:issue.column},result.literal.locations.get('/nodes/0/branches/0/when'));
  const broken=await analyze(["action('a',{name:'A',action:'save'})"]);
  assert.equal(broken.graph,null);
  assert.deepEqual(broken.diagnostics.map(d=>d.code),['FK_C016']);
});

test('handles 500 nodes and reversed declaration chains without recursion or quadratic diagnostic noise', async () => {
  const chain=[...Array.from({length:499},(_,i)=>action(`n-${i}`,i===498?'done':`n-${i+1}`)),end()];
  for(const nodes of [chain,[chain[0],...chain.slice(1).reverse()]]) {
    const result=await analyze(nodes);
    assert.deepEqual(result.diagnostics,[]);
    assert.equal(result.graph.dominators.get('done').size,500);
    assert.equal(result.graph.forward.topologicalOrder.length,501);
  }
});

test('handles a 500-node loop region with 497 repair actions', async () => {
  const nodes=["loop('l',{name:'L',maxIterations:3,body:'v',onSuccess:'done',onMaxExceeded:'done'})",
    "verification('v',{name:'V',verifier:'check',onSuccess:'l',onFailure:'r-0'})",
    ...Array.from({length:497},(_,i)=>action(`r-${i}`,i===496?'v':`r-${i+1}`)),end()];
  const result=await analyze(nodes);
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(result.graph.regions.get('l').forward.topologicalOrder.length,500);
});
