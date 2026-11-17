import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {generateKeyPairSync,sign} from 'node:crypto';
import {compileInteractive,createInteractiveCoordinator,createSqliteCheckpointStore,
  createSqliteInteractivePersistence,createInteractiveHostContext,createTrustedInteractiveHost,
  createAgentReceiptStatement,encodeAgentReceiptStatement,start,resume,complete} from '../../src/interactive/index.mjs';
import {prepareStandardSkill,publishStandardSkill} from '../../src/author/standard-artifact.mjs';
import {artifactDigest} from '../../src/shared/artifact-identity.mjs';
import {createIndependentAgentAdapter,createApiAgentAdapter} from '../../src/host.mjs';

const source=`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'recover-task',name:'Recover task',version:'1.0.0',nodes:[
node('worker',{name:'Worker',description:'Inspect the declared message',
descriptionRefs:[{uri:'notes.md',role:'instruction'}],requiredSkills:[{id:'inspect',version:'1.0.0'}],
inputs:['message','missing'],output:{type:'object',properties:{answer:{type:'string'}}},retries:2,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})]});`;
const skillDigest=artifactDigest('fixed skill');
const hostProfile={schemaVersion:1,executionModes:['interactive-p0-a'],capabilities:{skillResourceLoading:'supported'}};
async function fixture(t,{maxDispatches=3,deadlineMs=Date.now()+60000}={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-task-recovery-'));
  const file=path.join(dir,'task.workflow.js');
  await writeFile(file,source);await writeFile(path.join(dir,'notes.md'),'original instruction');
  const compiled=await compileInteractive(file,{output:'memory',featureStage:'P0-A',projectRoot:dir});
  assert.deepEqual(compiled.diagnostics,[]);
  const database=path.join(dir,'run.sqlite');
  let store=createSqliteCheckpointStore(database,{namespace:'tasks'});
  let allowed=true,preparations=0,digest=skillDigest;
  const runtime={validateResult:(_schema,value)=>typeof value.answer==='string'?[]:['answer is required'],
    prepareAgentTask:async(task,context)=>{preparations++;return {protocolVersion:2,task,
      descriptionResources:context.descriptionResources,skills:[{logicalId:'inspect',resolvedVersion:'1.0.0',digest}]};},
    authorizeAgentTask:prepared=>allowed && prepared.skills[0].digest===skillDigest};
  const policy={taskPolicy:{projectRoot:dir,hostProfile,maxDispatches,deadlineMs}};
  const api=()=>createInteractiveCoordinator({store,runtime,policy});
  const opening={programBytes:Buffer.from(compiled.code),programIdentity:compiled.programIdentity,
    startKey:'once',runId:'original-run',state:{message:'hello',secret:'do not disclose'}};
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  return {dir,file,database,compiled,runtime,policy,api,opening,get store(){return store;},
    restart(){store.close();store=createSqliteCheckpointStore(database,{namespace:'tasks'});},
    allow(value){allowed=value;},digest(value){digest=value;},preparations:()=>preparations};
}
const receipt=(frame,result)=>({runId:frame.runId,requestId:frame.pending.requestId,nodeId:'worker',attempt:frame.pending.attempt,result});

test('Task V2 restores exact Pending, Run, resources, input and budget from SQLite after source removal',async t=>{
  const f=await fixture(t);const waiting=await f.api().start(f.opening);
  assert.equal(waiting.status,'waiting');const before=f.store.load(waiting.runId).taskContext;
  assert.equal(before.dispatches,1);assert.equal(before.deadlineMs,f.policy.taskPolicy.deadlineMs);
  assert.deepEqual(waiting.pending.preparedTask.task.input,{message:'hello'});
  assert.deepEqual(waiting.pending.preparedTask.task.missing,['missing']);
  assert.equal(waiting.pending.preparedTask.descriptionResources[0].content,'original instruction');
  assert.ok(!JSON.stringify(waiting.pending).includes('do not disclose'));
  await unlink(f.file);await writeFile(path.join(f.dir,'notes.md'),'changed latest instruction');f.restart();
  assert.deepEqual(await f.api().resume({runId:waiting.runId}),waiting);
  assert.deepEqual(f.store.load(waiting.runId).taskContext,before);assert.equal(f.preparations(),1);
  const invalid=await f.api().complete(receipt(waiting,{}));
  assert.equal(invalid.status,'waiting');assert.equal(invalid.pending.attempt,2);
  assert.notEqual(invalid.pending.requestId,waiting.pending.requestId);
  assert.equal(invalid.pending.preparedTask.resourceManifest.manifestHash,waiting.pending.preparedTask.resourceManifest.manifestHash);
  assert.equal(invalid.pending.preparedTask.descriptionResources[0].content,'original instruction');
  assert.equal(f.store.load(waiting.runId).taskContext.dispatches,2);
  const submission=receipt(invalid,{answer:'done'});
  assert.equal((await f.api().complete(submission)).status,'succeeded');
  assert.equal((await f.api().complete(submission)).duplicate,true);
  await assert.rejects(f.api().complete({...submission,result:{answer:'different'}}),{code:'FK_I_RECEIPT_CONFLICT'});
});

test('revocation, policy changes and resource drift reject before disclosure or new result commit',async t=>{
  const f=await fixture(t);const waiting=await f.api().start(f.opening);f.allow(false);f.restart();
  for (const method of ['resume','load']) await assert.rejects(f.api()[method]({runId:waiting.runId}),{code:'FK_I_HOST_DENIED'});
  await assert.rejects(f.api().complete(receipt(waiting,{answer:'forbidden'})),{code:'FK_I_HOST_DENIED'});
  assert.equal(f.store.load(waiting.runId).receiptCount,0);f.allow(true);
  await assert.rejects(createInteractiveCoordinator({store:f.store,runtime:f.runtime,policy:{...f.policy,version:'changed'}})
    .resume({runId:waiting.runId}),{code:'FK_I_POLICY_MISMATCH'});
  f.digest(artifactDigest('new latest skill'));
  assert.equal((await f.api().complete(receipt(waiting,{}))).status,'errored');
  assert.equal(f.store.load(waiting.runId).taskContext.dispatches,1);
});

test('restored dispatch budgets never reset and unknown side effects never auto-retry',async t=>{
  const f=await fixture(t,{maxDispatches:1});const waiting=await f.api().start(f.opening);f.restart();
  assert.equal((await f.api().complete(receipt(waiting,{}))).status,'errored');
  assert.equal(f.store.load(waiting.runId).taskContext.dispatches,1);
  const g=await fixture(t);const pending=await g.api().start(g.opening);
  const {result:_,...identity}=receipt(pending,null);
  const stopped=await g.api().complete({...identity,kind:'agent-call-failed',
    failure:{message:'write response lost',code:'network',retryable:true,sideEffectStatus:'unknown'}});
  assert.equal(stopped.status,'errored');assert.equal(g.preparations(),1);
});

test('P0-A Author ships real three-file artifacts and diagrams remain static across independent Runs and restore',async t=>{
  const f=await fixture(t);
  const options={file:f.file,collectionId:'team',skillId:'inspect',name:'inspect',description:'Inspect task',version:'1.0.0',
    hostProfile:{id:'local',digest:artifactDigest('profile')},buildId:'b7',executionMode:'interactive-p0-a',
    professionalSkills:[{nodeId:'worker',id:'inspect',version:'1.0.0',digest:skillDigest}]};
  const {candidate}=await prepareStandardSkill(options);
  assert.deepEqual(Object.keys(candidate.files),['SKILL.md','workflow.js','workflow.mmd']);
  assert.equal(candidate.files['workflow.js'],f.compiled.code);assert.equal(candidate.files['workflow.mmd'],f.compiled.mermaid);
  assert.equal(candidate.manifest.mode,'interactive-p0-a');assert.doesNotMatch(candidate.files['SKILL.md'],/flowkit-workflow-author/);
  let approved=null;const host={async publishAtomically({candidate:value}){approved=value;return value.hash;}};
  const refs={reviewRef:'reviewed',approvalRef:'approved',previousHash:null};await publishStandardSkill(candidate,refs,host);
  await assert.rejects(publishStandardSkill({...candidate,files:{...candidate.files,'workflow.js':'broken'}},refs,host));
  assert.equal(approved.hash,candidate.hash);await writeFile(f.file,'invalid source');
  assert.equal((await prepareStandardSkill(options)).candidate,null);await unlink(f.file);
  for (const [name,body] of Object.entries(candidate.files)) await writeFile(path.join(f.dir,name),body);
  const diagramBefore=artifactDigest(await readFile(path.join(f.dir,'workflow.mmd')));
  for (const runId of ['run-one','run-two']) {
    const pending=await f.api().start({...f.opening,programBytes:await readFile(path.join(f.dir,'workflow.js')),
      startKey:runId,runId,state:{message:runId}});
    const routed=createIndependentAgentAdapter({scope:'tasks',authorize:()=>true,select:({artifactHash,runId,nodeId})=>({
      artifactHash,runId,nodeId,subjectId:'subject-'+runId,sessionId:'session-'+runId,workspaceRef:'work-'+runId,
      permissionRef:'permission-'+runId,runAgentTask:async prepared=>({status:'succeeded',events:[],result:{answer:prepared.task.input.message}})})});
    const output=await routed.runAgentTask(pending.pending.preparedTask);
    assert.equal((await f.api().complete(receipt(pending,output.result))).status,'succeeded');
    routed.releaseRun(candidate.manifest.artifactHash,runId);
    assert.equal((await f.api().resume({runId})).status,'succeeded');
  }
  assert.equal(artifactDigest(await readFile(path.join(f.dir,'workflow.mmd'))),diagramBefore);
  assert.ok(!candidate.files['workflow.mmd'].includes('run-one'));
});

test('Versioned Host exposes pinned Prepared Task with approved callback versions',async t=>{
  const f=await fixture(t);const p=createSqliteInteractivePersistence(path.join(f.dir,'versioned.sqlite'),{namespace:'tasks'});
  try {
  const runtime={},bindingManifest={};
  for (const key of ['validateResult','prepareAgentTask','authorizeAgentTask']) {
    const binding={id:key,version:'1',mode:key==='validateResult'?'pure-local':'trusted-read'};
    bindingManifest[key]=binding;runtime[key]={...binding,implementation:f.runtime[key]};
  }
  const options={...p,policy:{...f.policy,id:'b7',version:'1',bindingManifest,disclosePolicyId:'disclosure',
    capabilityStage:'P0-A',canonicalizationVersion:'jcs-rfc8785-v1'},startKey:'versioned',
    auth:createInteractiveHostContext({namespace:'tasks',subjectId:'local',authorize:()=>true,authorizeTask:()=>true})};
  const ref=await p.programRegistry.putImmutable(Buffer.from(f.compiled.code),f.compiled.programIdentity);
  const waiting=await start(ref,runtime,{message:'versioned'},options);
  assert.equal(waiting.pending[0].task.preparedTask.task.protocolVersion,2);
  assert.deepEqual(await resume(waiting.runId,runtime,options),waiting);
  assert.equal((await complete({kind:'agent',runId:waiting.runId,requestId:waiting.pending[0].requestId,
    outcome:'succeeded',result:{answer:'yes'}},runtime,options)).status,'succeeded');
  } finally {p.close();}
});

test('Trusted Host signs Task V2 receipts and rechecks authorization before model disclosure',async t=>{
  const f=await fixture(t);const keys=generateKeyPairSync('ed25519');
  const host=createTrustedInteractiveHost({store:f.store,runtime:f.runtime,policy:f.policy,
    trustedPublicKeys:{local:keys.publicKey},trustedArtifacts:[f.compiled.programIdentity.artifactHash],
    allowedInputKeys:['message','missing'],disclosurePolicyId:'allow-task',authorizeDisclosure:()=>true});
  const waiting=await host.start(f.opening);
  const task=await host.getPublicAgentTask({runId:waiting.runId});
  assert.equal(task.preparedTask.task.run.runId,waiting.runId);
  f.allow(false);await assert.rejects(host.getPublicAgentTask({runId:waiting.runId}),{code:'FK_I_HOST_DENIED'});f.allow(true);
  const value=receipt(waiting,{answer:'signed'});value.kind='agent-result';
  const issuedAt=Date.now();
  const statement=createAgentReceiptStatement({run:f.store.load(waiting.runId),receipt:value,keyId:'local',
    proofId:'proof-b7',issuedAt,expiresAt:issuedAt+60000});
  const attestation={statement,signature:sign(null,encodeAgentReceiptStatement(statement),keys.privateKey).toString('base64url')};
  assert.equal((await host.accept({receipt:value,attestation})).status,'succeeded');
});

test('original absolute deadline remains expired after reopening the database',async t=>{
  const f=await fixture(t,{deadlineMs:Date.now()+2000});const waiting=await f.api().start(f.opening);
  const original=f.store.load(waiting.runId).taskContext.deadlineMs;
  await delay(Math.max(1,original-Date.now()+30));f.restart();
  await assert.rejects(f.api().resume({runId:waiting.runId}),error=>error.kind==='node-deadline-exceeded');
  assert.equal(f.store.load(waiting.runId).taskContext.deadlineMs,original);
  assert.equal(f.store.load(waiting.runId).receiptCount,0);
});

test('API continuation reservations persist across restart and reject calls beyond the original Run budget',async t=>{
  const f=await fixture(t,{maxDispatches:2});const waiting=await f.api().start(f.opening);
  let requests=0;
  const adapter=createApiAgentAdapter({scope:'tasks',model:'local-protocol-fixture',authorizeTool:()=>true,
    tools:[{name:'inspect',description:'Read pinned resource',sideEffect:'read',parameters:{type:'object'},validate:()=>[],execute:async()=>({ok:true})}],
    request:async()=>Response.json({id:'response-'+ ++requests,status:'completed',output:requests===1 ?
      [{type:'function_call',name:'inspect',call_id:'call',arguments:'{}'}] :
      [{type:'message',content:[{type:'output_text',text:'{"answer":"api"}'}]}]})});
  const result=await adapter.runAgentTask(waiting.pending.preparedTask,{budget:{check(){},dispatch:reservation=>f.api().reserveDispatch({
    runId:waiting.runId,requestId:waiting.pending.requestId,...reservation})}});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(requests,2);f.restart();
  assert.equal(f.store.load(waiting.runId).taskContext.dispatches,2);
  const id={runId:waiting.runId,requestId:waiting.pending.requestId};
  assert.equal((await f.api().reserveDispatch({...id,operationId:`${id.requestId}:provider:1`})).dispatches,2);
  await assert.rejects(f.api().reserveDispatch({...id,operationId:'new-provider-call'}),error=>error.kind==='dispatch-limit');
  assert.equal((await f.api().complete(receipt(waiting,result.result))).status,'succeeded');
});
