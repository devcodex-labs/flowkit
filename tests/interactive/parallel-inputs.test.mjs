import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource } from '../../src/compiler/analyze.mjs';
import { lowerInteractive } from '../../src/compiler/interactive/lower.mjs';

const terminal = (id, status = 'succeeded') => "terminal('" + id + "',{name:'" + id + "',status:'" + status + "'})";
const action = (id, fields) => "action('" + id + "',{name:'" + id + "',action:'" + id + "',effect:'read-only'," + fields + "})";
const parallel = (id, members, next, strategy = 'any') => "parallel('" + id + "',{name:'" + id +
  "',branchMode:'subflow',branches:" + JSON.stringify(members) + ",join:{strategy:'" + strategy + "',next:'" + next + "'}})";
const writer = (id, key, next) => "node('" + id + "',{name:'" + id + "',agent:'writer',inputs:[],output:{type:'object'," +
  "properties:{" + key + ":{type:'string'}},required:['" + key + "']},next:'" + next + "'})";
const agentReader = "node('consume',{name:'consume',agent:'reader',inputs:['electronic'],output:{type:'object'},next:'done'})";
const simple = (next = 'consume') => [
  parallel('race', ['left','right'], next),
  action('left', "reads:[],writes:['electronic'],next:'" + next + "'"),
  action('right', "reads:[],writes:['paper'],next:'" + next + "'")
];
async function compile(nodes, input) {
  const definition = "import {defineWorkflow,parallel,node,action,condition,terminal} from '@devcodex-labs/flowkit/dsl';\n" +
    "export default defineWorkflow({id:'parallel-input',name:'Parallel input',version:'1.0.0'," +
    (input ? 'contract:{input:' + JSON.stringify(input) + '},' : '') + 'nodes:[' + nodes.join(',\n') + ']});';
  const analysis = await analyzeSource(definition, {filename:'parallel-input.workflow.js',skillCheck:false}, {interactiveStage:'P2'});
  const result = lowerInteractive(analysis,{featureStage:'P2'});
  assert.deepEqual(result.diagnostics.filter(item=>item.severity==='error'&&item.code!=='FK_I_PARALLEL_INPUT'),[]);
  return result;
}
async function reject(nodes, nodeId, keys, input) {
  const result = await compile(nodes,input);
  assert.equal(result.ir,null);
  const [diagnostic] = result.diagnostics.filter(item=>item.code==='FK_I_PARALLEL_INPUT');
  assert.equal(diagnostic.nodeId,nodeId);
  for (const key of keys) assert.ok(diagnostic.message.includes(JSON.stringify(key)),diagnostic.message);
}
async function accept(nodes, input) {
  const result = await compile(nodes,input);
  assert.ok(result.ir,JSON.stringify(result.diagnostics));
}

test('P2 rejects whole-state, explicit Action and Agent inputs that can disappear at an any join', async () => {
  await reject([...simple(),action('consume',"next:'done'"),terminal('done')],'consume',['electronic','paper']);
  await reject([...simple(),action('consume',"reads:['electronic'],next:'done'"),terminal('done')],'consume',['electronic']);
  await reject([...simple(),agentReader,terminal('done')],'consume',['electronic']);
  await accept([...simple(),action('consume',"reads:[],next:'done'"),terminal('done')]);

  const properties={electronic:{type:'string'},paper:{type:'string'}};
  await accept([parallel('race',['left','right'],'consume'),
    writer('left','electronic','consume'),writer('right','paper','consume'),action('consume',"next:'done'"),terminal('done')],
  {type:'object',properties,required:['electronic','paper'],additionalProperties:false});
});

test('P2 accounts for local success and failure, guaranteed winners and first-match presence guards', async () => {
  await accept([parallel('race',['left','right'],'consume'),writer('left','receipt','consume'),writer('right','receipt','consume'),
    action('consume',"reads:['receipt'],next:'done'"),terminal('done')]);

  await reject([parallel('race',['left','right'],'consume'),action('left',"reads:[],writes:['electronic'],next:'left-failed'"),
    terminal('left-failed','failed'),writer('right','paper','consume'),action('consume',"next:'done'"),terminal('done')],
  'consume',['electronic']);

  const tests = guard => [...simple('route'),"condition('route',{name:'route',branches:[{when:\"" + guard +
      "\",next:'consume'},{when:'true',next:'done'}]})",action('consume',"reads:['electronic'],next:'done'"),terminal('done')];
  await accept(tests("electronic === 'ready'"));
  await accept(tests("electronic === 'ready' && manifestApproved"));
  await reject(tests("electronic !== 'ready'"),'consume',['electronic']);
  await accept([...simple('restore'),writer('restore','electronic','consume'),
    action('consume',"reads:['electronic'],next:'done'"),terminal('done')]);
  await reject([...simple('restore'),action('restore',"reads:[],writes:['electronic'],next:'consume'"),
    action('consume',"reads:['electronic'],next:'done'"),terminal('done')],'consume',['electronic']);
});

test('P2 carries race losses through nested scope projections without applying the inner implicit guard outside', async () => {
  const base = [parallel('outer',['race','temperature'],'outside','all_succeeded'),
    ...simple('inside'),action('temperature',"reads:[],writes:['temp'],next:'outside'")];
  await reject([...base,action('inside',"next:'outside'"),action('outside',"reads:[],next:'done'"),terminal('done')],
    'inside',['electronic','paper']);
  await reject([...base,action('inside',"reads:[],next:'outside'"),action('outside',"reads:['electronic'],next:'done'"),terminal('done')],
    'outside',['electronic']);
  await accept([...base,action('inside',"reads:[],next:'outside'"),action('outside',"next:'done'"),terminal('done')]);
});
