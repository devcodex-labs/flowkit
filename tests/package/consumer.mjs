import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {generateKeyPairSync, sign} from 'node:crypto';
import * as api from '@devcodex-labs/flowkit';
import * as interactive from '@devcodex-labs/flowkit/interactive';
import * as dsl from '@devcodex-labs/flowkit/dsl';
import { createFlowkitMcpServer, createFlowkitHttpHandler } from '@devcodex-labs/flowkit/mcp';
import { createApiAgentAdapter, createIndependentAgentAdapter, configureCompilationCache,
  clearCompilationCache,compilationCacheStatus,releaseToolReceipts } from '@devcodex-labs/flowkit/host';
import pkg from '@devcodex-labs/flowkit/package.json' with { type: 'json' };
assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileArtifact', 'compileSource', 'evalWhen', 'isControlSignal', 'run', 'runArtifact']);
assert.equal(Object.keys(dsl).length, 9); assert.equal(pkg.name, '@devcodex-labs/flowkit');
const mcp = createFlowkitMcpServer({ namespace: 'installed-project', collectionIds: [], authorize: () => false });
assert.equal(typeof mcp.connect, 'function');
assert.equal(typeof createFlowkitHttpHandler(() => null), 'function');
await mcp.close();
const apiAgent = createApiAgentAdapter({ scope: 'installed', model: 'local-fixture', request: async () =>
  Response.json({ id: 'installed-result', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }) });
assert.equal((await apiAgent.runAgentTask({ task: { execution: { requestId: 'fixture' }, run: { runId: 'run' }, node: { id: 'node' } },
  descriptionResources: [], skills: [] })).result.ok, true);
const routed = createIndependentAgentAdapter({ scope: 'installed', select: async () => null, authorize: () => false });
assert.ok(configureCompilationCache({maxEntries:16}).maxModuleBytes>0);
assert.equal(clearCompilationCache().entries,0);
assert.equal(compilationCacheStatus().entries,0);
assert.deepEqual(releaseToolReceipts(new Map(),{scope:'installed',runId:'finished'}),{removed:0,remaining:0});
assert.equal((await routed.runAgentTask({ task: { workflow: { artifactHash: 'fixture' }, execution: {}, run: { runId: 'run' }, node: { id: 'node' } } })).status, 'failed');
const resolved = fileURLToPath(import.meta.resolve('@devcodex-labs/flowkit'));
assert.ok(resolved.startsWith(path.resolve('node_modules/@devcodex-labs/flowkit') + path.sep));
for (const name of ['@devcodex-labs/flowkit/dist/index.mjs', '@devcodex-labs/flowkit/cli', '@devcodex-labs/flowkit/runtime/run', '@devcodex-labs/flowkit/testing']) await assert.rejects(import(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const definition = dsl.defineWorkflow({ id: 'installed', version: '1.0.0', name: 'Installed', nodes: [dsl.terminal('done', { name: 'Done', status: 'succeeded' })] });
assert.ok(Object.isFrozen(definition.nodes[0]));
await writeFile('prepared.workflow.js', `
import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'prepared',version:'1.0.0',name:'Prepared',nodes:[
  node('work',{name:'Work',description:'Check installed package',output:{type:'object'},next:'done'}),
  terminal('done',{name:'Done',status:'succeeded'})
]});`);
const standard = await api.compileArtifact('prepared.workflow.js');
assert.deepEqual(standard.diagnostics, []);
await writeFile('workflow.js', standard.code);
await unlink('prepared.workflow.js');
const prepared = await api.runArtifact('workflow.js', standard.artifactHash, {
  isControlSignal: api.isControlSignal, validateResult: () => [],
  async runAgentTask(value) {
    assert.equal(value.task.task.description, 'Check installed package');
    return { status: 'succeeded', result: { standardInstalled: true }, events: [] };
  }
});
assert.equal(prepared.state.standardInstalled, true);
await mkdir('skills'); await writeFile('skills/a.md', 'Installed Skill.');
const source = `import {defineWorkflow,node,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'installed',version:'1.0.0',name:'Installed',nodes:[node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'save'}),action('save',{name:'Save',action:'save',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]} as const);\n`;
await writeFile('sample.workflow.ts', source);
const output = await api.compile('sample.workflow.ts', { trace: true, mermaid: false }); assert.deepEqual(output.diagnostics, []);
assert.equal((await api.compileSource(source, { filename: 'virtual.workflow.ts', mermaid: false })).diagnostics.length, 0);
const before = await stat('sample.workflow.ts.compiled.mjs'); assert.deepEqual(await api.check('sample.workflow.ts', { trace: true, mermaid: false }), []); assert.equal((await stat('sample.workflow.ts.compiled.mjs')).mtimeMs, before.mtimeMs);
for (const mode of ['source', 'aot', 'dump']) {
  const host = { isControlSignal: api.isControlSignal, evalWhen: api.evalWhen, runAgent: async step => { assert.equal(step.instruction, 'Installed Skill.'); return { answer: 42 }; }, validateResult: () => [], runAction: async (_id, _name, ctx) => { ctx.state.saved = true; } };
  const result = await api.run(mode === 'aot' ? 'sample.workflow.ts.compiled.mjs' : 'sample.workflow.ts', host, {}, { trace: true, ...(mode === 'dump' ? { dump: 'debug' } : {}) });
  assert.equal(result.terminal, 'done'); assert.equal(result.state.answer, 42); assert.equal(result.state.saved, true); assert.equal(Object.hasOwn(result, 'error'), false);
}
assert.equal(api.evalWhen({ runtime: {}, state: { ready: true } }, 'ready'), true); assert.equal(api.isControlSignal({ control: true }), true);
assert.equal(await readFile('sample.workflow.ts.compiled.mjs', 'utf8'), output.code);


assert.deepEqual(Object.keys(interactive),[
  'cancelInteractiveRun','compileInteractive','complete','createAgentReceiptStatement','createInteractiveAdminContext','createInteractiveCoordinator',
  'createInteractiveHostContext','createSqliteCheckpointStore','createSqliteInteractivePersistence',
  'createTrustedInteractiveHost','encodeAgentReceiptStatement','forkInteractiveRun','listInteractiveForkPoints',
  'loadInteractiveProgram','normalizeHostAgentReceipt','reserveInteractiveDispatch','resume','start',
]);
await writeFile('simple.workflow.js',
  "import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';\n"+
  "export default defineWorkflow({id:'isolated-interactive',version:'1.0.0',name:'Public M4',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});\n");
const compiledInteractive=await interactive.compileInteractive('simple.workflow.js',{
  output:'memory',featureStage:'P0-A',
});
const versioned=interactive.createSqliteInteractivePersistence('versioned.sqlite',{namespace:'installed'});
try {
  const auth=interactive.createInteractiveHostContext({
    namespace:'installed',subjectId:'test-host',authorize:()=>true,authorizeTask:()=>false,
  });
  const options={
    ...versioned,auth,startKey:'installed-versioned',policy:{
      id:'consumer',version:'1',bindingManifest:{},disclosePolicyId:'consumer',
      capabilityStage:'P0-A',canonicalizationVersion:'jcs-rfc8785-v1',
    },
    graphSnapshot:compiledInteractive.graphSnapshot,
  };
  const frame=await interactive.start('simple.workflow.js',{}, {private:'host-only'},options);
  assert.equal(frame.status,'succeeded');
  assert.equal(Object.hasOwn(frame,'state'),false);
  const original=await versioned.store.load(frame.runId);
  assert.equal(original.protocolVersion,1);
  const {artifactHash,graphDigest}=options.graphSnapshot;
  const ref={namespace:'installed',runId:frame.runId,artifactHash,graphDigest};
  const {points}=await interactive.listInteractiveForkPoints({ref,nodeId:'done'},options);
  assert.equal(points.length,1);
  const [{revision,entryRevision}]=points;
  const fork=await interactive.forkInteractiveRun({source:ref,revision,entryRevision,startKey:'installed-fork',redoWrites:false},{},options);
  assert.notEqual(fork.runId,frame.runId);
  assert.equal(fork.status,'succeeded');
  assert.deepEqual((await auth.readTerminalResult(fork.resultRef,options)).state,{private:'host-only'});
  assert.deepEqual(await versioned.store.load(frame.runId),original);
} finally {versioned.close();}
assert.ok(compiledInteractive.programIdentity?.artifactHash);
await writeFile('task-interactive.workflow.js',
  "import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';"+
  "export default defineWorkflow({id:'installed-task',version:'1.0.0',name:'Task',nodes:["+
  "node('work',{name:'Work',description:'Check package',output:{type:'object'},next:'done'}),"+
  "terminal('done',{name:'Done',status:'succeeded'})]});");
const taskProgram=await interactive.compileInteractive('task-interactive.workflow.js',{output:'memory',featureStage:'P0-A'});
assert.deepEqual(taskProgram.diagnostics,[]);
assert.ok(taskProgram.mermaid.startsWith('flowchart TD'));
await unlink('task-interactive.workflow.js');
const taskStore=interactive.createSqliteCheckpointStore('task-interactive.db',{namespace:'installed-task'});
try {
  const machine=interactive.createInteractiveCoordinator({store:taskStore,runtime:{validateResult:()=>[],authorizeAgentTask:()=>true}});
  const pending=await machine.start({programBytes:Buffer.from(taskProgram.code),programIdentity:taskProgram.programIdentity,startKey:'task'});
  assert.equal(pending.pending.preparedTask.task.protocolVersion,2);
  await machine.reserveDispatch({runId:pending.runId,requestId:pending.pending.requestId,operationId:'installed-extra'});
  const result=await machine.complete({runId:pending.runId,requestId:pending.pending.requestId,nodeId:'work',attempt:1,result:{ok:true}});
  assert.equal(result.status,'succeeded');
} finally {taskStore.close();}
const store=interactive.createSqliteCheckpointStore('interactive-demo.db',{namespace:'consumer'});
try {
  const machine=interactive.createInteractiveCoordinator({store,runtime:{}});
  const frame=await machine.start({
    programBytes:Buffer.from(compiledInteractive.code),
    programIdentity:compiledInteractive.programIdentity,
    startKey:'consumer-test',
    state:{installed:true},
  });
  assert.equal(frame.status,'succeeded');
  assert.deepEqual(frame.state,{installed:true});
  assert.equal((await machine.resume({runId:frame.runId})).revision,frame.revision);

  await writeFile('signed.workflow.js',
    "import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';\n"+
    "export default defineWorkflow({id:'trusted-consumer',version:'1.0.0',name:'Trusted',nodes:["+
    "node('worker',{name:'Worker',skill:'skills/a.md',inputs:['message'],"+
    "output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),"+
    "terminal('done',{name:'Done',status:'succeeded'})]});\n");
  const signed=await interactive.compileInteractive('signed.workflow.js',{
    output:'memory',featureStage:'P0-A',
  });
  assert.equal(signed.diagnostics.some(d=>d.severity==='error'),false);
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const now=1794400000000;
  const trusted=interactive.createTrustedInteractiveHost({
    store,runtime:{skillResolver:async()=> 'Safe instruction',
      validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['invalid']},
    trustedPublicKeys:{consumer:publicKey},
    trustedArtifacts:[signed.programIdentity.artifactHash],
    allowedInputKeys:['message'],
    disclosurePolicyId:'consumer-disclosure-v1',
    authorizeDisclosure:async()=>true,
    authorizeTerminalAccess:({action})=>action==='run:read'||action==='result:read',
    now:()=>now,
  });
  const pending=await trusted.start({
    programBytes:Buffer.from(signed.code),programIdentity:signed.programIdentity,
    startKey:'consumer-trusted',state:{message:'shareable',hidden:'private'},
  });
  assert.equal(pending.status,'waiting');
  const publicTask=await trusted.getPublicAgentTask({runId:pending.runId});
  assert.deepEqual(publicTask.input,{message:'shareable'});
  assert.equal(JSON.stringify(publicTask).includes('private'),false);
  const receipt={kind:'agent-result',runId:pending.runId,requestId:pending.pending.requestId,
    nodeId:pending.pending.nodeId,attempt:pending.pending.attempt,result:{answer:'verified'}};
  const statement=interactive.createAgentReceiptStatement({
    run:store.load(pending.runId),receipt,keyId:'consumer',proofId:'provider-result-1',
    issuedAt:now-1000,expiresAt:now+10000,
  });
  const signature=sign(null,interactive.encodeAgentReceiptStatement(statement),privateKey)
    .toString('base64url');
  const final=await trusted.accept({receipt,attestation:{statement,signature}});
  assert.equal(final.status,'succeeded');
  assert.deepEqual(final.state,{message:'shareable',hidden:'private',answer:'verified'});
  const publicTerminal=await trusted.getPublicTerminalFrame({runId:final.runId});
  assert.equal(Object.hasOwn(publicTerminal,'state'),false);
  assert.deepEqual(publicTerminal.pending,[]);
  const trustedResult=await trusted.readTrustedTerminalResult({resultRef:publicTerminal.resultRef});
  assert.deepEqual(trustedResult.state,final.state);
  assert.equal((await trusted.accept({receipt,attestation:{statement,signature}})).duplicate,true);

} finally {store.close();}
