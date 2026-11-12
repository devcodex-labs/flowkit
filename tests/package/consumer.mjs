import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {generateKeyPairSync, sign} from 'node:crypto';
import * as api from '@devcodex-labs/flowkit';
import * as interactive from '@devcodex-labs/flowkit/interactive';
import * as dsl from '@devcodex-labs/flowkit/dsl';
import pkg from '@devcodex-labs/flowkit/package.json' with { type: 'json' };
assert.deepEqual(Object.keys(api), ['check', 'compile', 'compileSource', 'evalWhen', 'isControlSignal', 'run']);
assert.equal(Object.keys(dsl).length, 9); assert.equal(pkg.name, '@devcodex-labs/flowkit');
const resolved = fileURLToPath(import.meta.resolve('@devcodex-labs/flowkit'));
assert.ok(resolved.startsWith(path.resolve('node_modules/@devcodex-labs/flowkit') + path.sep));
for (const name of ['@devcodex-labs/flowkit/dist/index.mjs', '@devcodex-labs/flowkit/cli', '@devcodex-labs/flowkit/runtime/run', '@devcodex-labs/flowkit/testing']) await assert.rejects(import(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const definition = dsl.defineWorkflow({ id: 'installed', version: '1.0.0', name: 'Installed', nodes: [dsl.terminal('done', { name: 'Done', status: 'succeeded' })] });
assert.ok(Object.isFrozen(definition.nodes[0]));
await mkdir('skills'); await writeFile('skills/a.md', 'Installed Skill.');
const source = `import {defineWorkflow,node,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'installed',version:'1.0.0',name:'Installed',nodes:[node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},next:'save'}),action('save',{name:'Save',action:'save',next:'done'}),terminal('done',{name:'Done',status:'succeeded'})]} as const);\n`;
await writeFile('sample.workflow.ts', source);
const output = await api.compile('sample.workflow.ts', { trace: true, mermaid: false }); assert.deepEqual(output.diagnostics, []);
assert.equal((await api.compileSource(source, { filename: 'virtual.workflow.ts', mermaid: false })).diagnostics.length, 0);
const before = await stat('sample.compiled.mjs'); assert.deepEqual(await api.check('sample.workflow.ts', { trace: true, mermaid: false }), []); assert.equal((await stat('sample.compiled.mjs')).mtimeMs, before.mtimeMs);
for (const mode of ['source', 'aot', 'dump']) {
  const host = { isControlSignal: api.isControlSignal, evalWhen: api.evalWhen, runAgent: async step => { assert.equal(step.instruction, 'Installed Skill.'); return { answer: 42 }; }, validateResult: () => [], runAction: async (_id, _name, ctx) => { ctx.state.saved = true; } };
  const result = await api.run(mode === 'aot' ? 'sample.compiled.mjs' : 'sample.workflow.ts', host, {}, { trace: true, ...(mode === 'dump' ? { dump: 'debug' } : {}) });
  assert.equal(result.terminal, 'done'); assert.equal(result.state.answer, 42); assert.equal(result.state.saved, true); assert.equal(Object.hasOwn(result, 'error'), false);
}
assert.equal(api.evalWhen({ runtime: {}, state: { ready: true } }, 'ready'), true); assert.equal(api.isControlSignal({ control: true }), true);
assert.equal(await readFile('sample.compiled.mjs', 'utf8'), output.code);


assert.deepEqual(Object.keys(interactive),[
  'compileInteractive','complete','createAgentReceiptStatement','createInteractiveCoordinator',
  'createInteractiveHostContext','createSqliteCheckpointStore','createSqliteInteractivePersistence',
  'createTrustedInteractiveHost','encodeAgentReceiptStatement',
  'loadInteractiveProgram','normalizeHostAgentReceipt','resume','start',
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
  const frame=await interactive.start('simple.workflow.js',{}, {private:'host-only'},{
    ...versioned,auth,startKey:'installed-versioned',policy:{
      id:'consumer',version:'1',bindingManifest:{},disclosePolicyId:'consumer',
      capabilityStage:'P0-A',canonicalizationVersion:'jcs-rfc8785-v1',
    },
  });
  assert.equal(frame.status,'succeeded');
  assert.equal(Object.hasOwn(frame,'state'),false);
  assert.equal((await versioned.store.load(frame.runId)).transitionIdVersion,1);
} finally {versioned.close();}
assert.ok(compiledInteractive.programIdentity?.artifactHash);
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
