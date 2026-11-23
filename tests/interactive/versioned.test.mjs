import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn,spawnSync} from 'node:child_process';
import {createApiAgentAdapter} from '../../src/host/api-agent.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {
  compileInteractive,complete,cancelInteractiveRun,createInteractiveAdminContext,createInteractiveHostContext,
  createInteractiveCoordinator,
  createSqliteCheckpointStore,createSqliteInteractivePersistence,resume,start,
} from '../../src/interactive/index.mjs';

const ns='p0a-compatible';
const runtime={
  skillResolver:{id:'skill',version:'1',mode:'trusted-read',implementation:async reference=>'Skill: '+reference},
  validateResult:{id:'schema',version:'1',mode:'pure-local',implementation:(_schema,result)=>
    typeof result.answer==='string'?[]:['Expected answer']},
};
const policy={
  id:'compatibility-test',version:'1',disclosePolicyId:'input-allowlist',capabilityStage:'P0-A',
  canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{
    skillResolver:{id:'skill',version:'1',mode:'trusted-read'},
    validateResult:{id:'schema',version:'1',mode:'pure-local'},
  },
};
const source=`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'compat',name:'Compat',version:'1.0.0',nodes:[
node('agent',{name:'Agent',agent:'writer',inputs:['message'],
output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`;
const bare=`import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'pure',name:'Pure',version:'1.0.0',nodes:[
terminal('done',{name:'Done',status:'succeeded'})
]});`;
function context(overrides={}) {
  return createInteractiveHostContext({namespace:ns,subjectId:'test-host',
    authorize:()=>true,authorizeTask:({task})=>Object.keys(task.input).every(key=>key==='message'),...overrides});
}
async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-compat-'));
  const file=path.join(dir,'cp.sqlite');
  const persistence=createSqliteInteractivePersistence(file,{namespace:ns});
  const raw=createSqliteCheckpointStore(file,{namespace:ns});
  let closed=false;
  function closePersistence() {
    if (!closed) persistence.close();
    closed=true;
  }
  t.after(async()=>{closePersistence();raw.close();await rm(dir,{recursive:true,force:true});});
  const script=path.join(dir,'agent.workflow.js');
  await writeFile(script,source);
  const compiled=await compileInteractive(script,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
  const program=await persistence.programRegistry.putImmutable(Buffer.from(compiled.code),compiled.programIdentity);
  return {dir,file,raw,persistence,closePersistence,compiled,program,options:{...persistence,policy,auth:context(),startKey:'new'}};
}
const submission=(frame,result={answer:'yes'})=>({
  runId:frame.runId,requestId:frame.pending[0].requestId,kind:'agent',outcome:'succeeded',result,
});

test('operation claims survive a reopened Store and settlement is separate from the workflow terminal',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello'},f.options);
  const claim={
    runId:waiting.runId,requestId:waiting.pending[0].requestId,
    operationKey:sha256Bytes(Buffer.from('logical external operation')),
    inputHash:sha256Bytes(Buffer.from('normalized action arguments')),
  };
  const {operationController:first}=f.persistence;
  const allowed=context({authorize:({action})=>action.startsWith('operation:')});
  await assert.rejects(first.claim(claim,context({authorize:()=>false})),{code:'FK_I_HOST_DENIED'});
  await assert.rejects(first.claim({...claim,requestId:'superseded'},allowed),{code:'FK_I_STALE_RECEIPT'});
  assert.equal((await first.claim(claim,allowed)).claimed,true);

  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const second=reopened.operationController;
    assert.deepEqual(await second.claim(claim,allowed),
      {claimed:false,requestId:claim.requestId,inputHash:claim.inputHash,settlement:null});
    await assert.rejects(second.claim({...claim,inputHash:claim.operationKey},allowed),{code:'FK_I_OPERATION_CONFLICT'});
    await assert.rejects(second.load({runId:claim.runId,operationKey:claim.operationKey},
      context({namespace:'other-tenant'})),{code:'FK_I_HOST_DENIED'});

    const terminal=await complete(submission(waiting),runtime,f.options);
    assert.equal(terminal.status,'succeeded');
    await assert.rejects(second.claim(claim,allowed),{code:'FK_I_STALE_RECEIPT'});
    const settlement={
      runId:claim.runId,operationKey:claim.operationKey,inputHash:claim.inputHash,
      effect:'applied',evidenceHash:sha256Bytes(Buffer.from('upstream receipt')),result:{externalId:'123'},
    };
    const saved=await second.settle(settlement,allowed);
    assert.deepEqual(await first.settle(settlement,allowed),saved);
    await assert.rejects(first.settle({...settlement,result:{externalId:'other'}},allowed),
      {code:'FK_I_OPERATION_CONFLICT'});
    assert.deepEqual(await second.load({runId:claim.runId,operationKey:claim.operationKey},allowed),saved);
    const {acknowledgement,...terminalFrame}=terminal;
    assert.deepEqual(await resume(claim.runId,runtime,f.options),terminalFrame);
    assert.equal((await f.options.store.load(claim.runId)).revision,terminal.revision);
  } finally {reopened.close();}
});

test('P0-B routes a durable Action settlement through a separate boolean Verification',async t=>{
  const f=await fixture(t);
  const script=path.join(f.dir,'steps.workflow.js');
  await writeFile(script,`import {defineWorkflow,action,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'durable-steps',name:'Durable steps',version:'1.0.0',nodes:[
action('write',{name:'Write',action:'some-write',writes:['receipt'],next:'verify'}),
verification('verify',{name:'Verify',verifier:'some-check',onSuccess:'done',onFailure:'rejected'}),
terminal('done',{name:'Done',status:'succeeded'}), terminal('rejected',{name:'Rejected',status:'failed'}),
]});`);
  const auth=context({authorizeTask:()=>true});
  const cfg={...f.options,auth,policy:{...policy,bindingManifest:{},capabilityStage:'P0-B'}};
  const frame=await start(script,{}, {},cfg);
  assert.equal(frame.status,'waiting');
  const [pending]=frame.pending;
  assert.equal(pending.kind,'action');
  assert.equal(pending.task.action,'some-write');
  const claim={runId:frame.runId,requestId:pending.requestId,
    operationKey:pending.task.operationKey,
    inputHash:sha256Bytes(canonicalBytes(pending.task))};
  const result={set:{receipt:'upstream-42'}};
  const submit={runId:frame.runId,requestId:pending.requestId,operationKey:claim.operationKey,
    kind:'action',outcome:'succeeded',result};
  await assert.rejects(complete(submit,{},cfg),{code:'FK_I_INVALID_OPERATION'});
  const rawCoordinator=createInteractiveCoordinator({store:f.raw,runtime:{},policy:cfg.policy});
  await assert.rejects(rawCoordinator.resume({runId:frame.runId}),{code:'FK_I_UNSUPPORTED_GRAPH'});
  await assert.rejects(rawCoordinator.complete({runId:frame.runId,requestId:pending.requestId,
    nodeId:pending.nodeId,attempt:pending.attempt,kind:'action-result',result}),{code:'FK_I_UNSUPPORTED_GRAPH'});
  await assert.rejects(f.persistence.operationController.claim({...claim,
    operationKey:sha256Bytes(Buffer.from('different operation key'))},auth),{code:'FK_I_OPERATION_CONFLICT'});
  const upstream=path.join(f.dir,'upstream.sqlite');
  const sdk=new URL('../../src/interactive/index.mjs',import.meta.url).href;
  // Kill the worker after the actual external write and before it can settle.
  const worker=spawnSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    const [sdk,file,namespace,serialized,upstream]=process.argv.slice(1);
    const {createSqliteInteractivePersistence,createInteractiveHostContext}=await import(sdk);
    const persistence=createSqliteInteractivePersistence(file,{namespace});
    const auth=createInteractiveHostContext({namespace,subjectId:'writer',authorize:()=>true,authorizeTask:()=>true});
    const claim=JSON.parse(serialized);
    if (!(await persistence.operationController.claim(claim,auth)).claimed) throw Error('dispatch not granted');
    const db=new DatabaseSync(upstream);
    db.exec('CREATE TABLE writes (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
    db.prepare('INSERT INTO writes VALUES (?, ?)').run(claim.operationKey,'upstream-42');
    process.kill(process.pid,'SIGKILL');`,sdk,f.file,ns,JSON.stringify(claim),upstream],
  {encoding:'utf8',timeout:20000});
  assert.notEqual(worker.status,0,worker.stderr);
  assert.equal(worker.error,undefined);
  const recovered=spawnSync(process.execPath,['--input-type=module','-e',`
    import {DatabaseSync} from 'node:sqlite';
    const [sdk,file,namespace,serialized,upstream]=process.argv.slice(1);
    const {createSqliteInteractivePersistence,createInteractiveHostContext,complete}=await import(sdk);
    const {claim,submit,policy,evidenceHash}=JSON.parse(serialized);
    const persistence=createSqliteInteractivePersistence(file,{namespace});
    const auth=createInteractiveHostContext({namespace,subjectId:'reconciler',authorize:()=>true,authorizeTask:()=>true});
    try {
      if ((await persistence.operationController.claim(claim,auth)).claimed) throw Error('repeated dispatch');
      const db=new DatabaseSync(upstream,{readOnly:true});
      const rows=db.prepare('SELECT receipt FROM writes WHERE id=?').all(claim.operationKey);
      db.close();
      if (rows.length!==1 || rows[0].receipt!==submit.result.set.receipt) throw Error('missing upstream receipt');
      const {runId,operationKey,inputHash}=claim;
      await persistence.operationController.settle({runId,operationKey,inputHash,
        effect:'applied',evidenceHash,result:submit.result},auth);
      process.stdout.write(JSON.stringify(await complete(submit,{},{...persistence,auth,policy})));
    } finally {persistence.close();}
    `,sdk,f.file,ns,JSON.stringify({claim,submit,policy:cfg.policy,
    evidenceHash:sha256Bytes(Buffer.from('external evidence'))}),upstream],
  {encoding:'utf8',timeout:20000});
  assert.equal(recovered.status,0,recovered.stderr);
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const options={...cfg,...reopened};
    const checking=JSON.parse(recovered.stdout);
    assert.equal(checking.pending[0].kind,'verification');
    assert.equal(checking.pending[0].task.input.receipt,'upstream-42');
    const terminal=await complete({runId:frame.runId,requestId:checking.pending[0].requestId,
      kind:'verification',outcome:'succeeded',result:{passed:false}}, {},options);
    assert.equal(terminal.status,'failed');
    assert.deepEqual((await auth.readTerminalResult(terminal.resultRef,options)).state,{receipt:'upstream-42'});
  } finally {reopened.close();}
});

test('P0-B persists Loop limits and binds Human decisions to the current review',async t=>{
  const f=await fixture(t);
  const script=path.join(f.dir,'review.workflow.js');
  await writeFile(script,`import {defineWorkflow,node,verification,loop,human,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'human-loop',name:'Human and loop',version:'1.0.0',nodes:[
loop('attempts',{name:'Attempts',body:'quality',onSuccess:'review',onMaxExceeded:'rejected',maxIterations:2}),
verification('quality',{name:'Quality',verifier:'quality',onSuccess:'attempts',onFailure:'revise'}),
node('revise',{name:'Revise',agent:'writer',output:{type:'object'},retries:0,next:'quality'}),
human('review',{name:'Review',onApprove:'done',onReject:'rewrite',maxRevisions:1}),
node('rewrite',{name:'Rewrite',agent:'writer',output:{type:'object'},retries:0,next:'review'}),
terminal('done',{name:'Done',status:'succeeded'}), terminal('rejected',{name:'Rejected',status:'failed'}),
]});`);
  const modelAuth=context({authorizeTask:()=>true});
  let proofCalls=0;
  const operator=context({subjectId:'operator',authorizeTask:()=>true,
    authorizeHuman:({subjectId,reviewDigest})=>subjectId==='operator'
      ? {proofId:'operator-confirmation-'+(++proofCalls),evidenceHash:reviewDigest}:null});
  const cfg={...f.options,auth:modelAuth,policy:{...policy,capabilityStage:'P0-B'}};
  const compiled=await compileInteractive(script,{output:'memory',featureStage:'P0-B',skillCheck:false});
  assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
  const program=await cfg.programRegistry.putImmutable(Buffer.from(compiled.code),compiled.programIdentity);
  const settle=(frame,kind,result,options=cfg,other={})=>complete({
    runId:frame.runId,requestId:frame.pending[0].requestId,kind,outcome:'succeeded',result,...other,
  },runtime,options);
  const modelOutput={answer:'fixed'};

  const initial=await start(program,runtime,{},cfg);
  const repair=await settle(initial,'verification',{passed:false});
  const verifiedAgain=await settle(repair,'agent',modelOutput);
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const reopenedOptions={...cfg,...reopened};
    const exhausted=await settle(verifiedAgain,'verification',{passed:false},reopenedOptions);
    assert.equal(exhausted.terminal.nodeId,'rejected');

    const second=await start(program,runtime,{}, {...reopenedOptions,startKey:'human'});
    const review=await settle(second,'verification',{passed:true},reopenedOptions);
    const reviewDigest=review.pending[0].task.reviewDigest;
    await assert.rejects(settle(review,'human',{approved:true},reopenedOptions,{reviewDigest}),{code:'FK_I_HOST_DENIED'});
    const authorized={...reopenedOptions,auth:operator};
    const rewrite=await settle(review,'human',{approved:false,comment:'revise it'},authorized,{reviewDigest});
    const afterRewrite=await settle(rewrite,'agent',modelOutput,reopenedOptions);
    assert.notEqual(afterRewrite.pending[0].task.reviewDigest,reviewDigest);
    await assert.rejects(settle(afterRewrite,'human',{approved:true},authorized,{reviewDigest}),
      {code:'FK_I_STALE_RECEIPT'});
    const done=await settle(afterRewrite,'human',{approved:true},authorized,
      {reviewDigest:afterRewrite.pending[0].task.reviewDigest});
    assert.equal(done.status,'succeeded');
    const proof=await reopened.store.loadReceipt(done.runId,afterRewrite.pending[0].requestId);
    assert.deepEqual(proof.humanProof,{subjectId:'operator',proofId:'operator-confirmation-2',
      evidenceHash:afterRewrite.pending[0].task.reviewDigest});
    const reack=await settle(afterRewrite,'human',{approved:true},
      {...authorized,auth:context({subjectId:'operator',authorizeTask:()=>true})},
      {reviewDigest:afterRewrite.pending[0].task.reviewDigest});
    assert.equal(reack.acknowledgement.repeated,true);
    assert.equal(proofCalls,2);
    assert.deepEqual((await operator.readTerminalResult(done.resultRef,authorized)).state.review,{approved:true,comment:null});
  } finally {reopened.close();}
});

test('P0-B checks an Agent against the committed state, then verifies its uncommitted candidate',async t=>{
  const f=await fixture(t);
  const script=path.join(f.dir,'agent-verify.workflow.js');
  await writeFile(script,source.replace("retries:0,next:'done'", "retries:1,verify:'quality',next:'done'"));
  const checkStep={id:'check',version:'1',mode:'pure-local'};
  const verifyAgentResult={id:'verify',version:'1',mode:'trusted-read'};
  const cfg={...f.options,policy:{...policy,capabilityStage:'P0-B',
    bindingManifest:{...policy.bindingManifest,checkStep,verifyAgentResult}}};
  let resolveCount=0;
  const callbacks={...runtime,
    skillResolver:{...runtime.skillResolver,implementation:async()=>`instruction-${++resolveCount}`},
    checkStep:{...checkStep,implementation:({state})=>{assert.equal(state.answer,'old');return null;}},
    verifyAgentResult:{...verifyAgentResult,implementation:({state})=>state.answer==='accepted'}};
  const compiled=await compileInteractive(script,{output:'memory',featureStage:'P0-B',skillCheck:false});
  assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
  const program=await cfg.programRegistry.putImmutable(Buffer.from(compiled.code),compiled.programIdentity);
  const waiting=await start(program,callbacks,{message:'hi',answer:'old'},cfg);
  await assert.rejects(complete(submission(waiting,{answer:'first'}),{...callbacks,checkStep:undefined},cfg),
    {code:'FK_I_BINDING_MISSING'});
  const retry=await complete(submission(waiting,{answer:'first'}),callbacks,cfg);
  assert.equal(retry.status,'waiting');
  assert.equal(retry.pending[0].attempt,2);
  assert.equal(retry.pending[0].task.instruction,waiting.pending[0].task.instruction);
  assert.equal(resolveCount,1);
  const done=await complete(submission(retry,{answer:'accepted'}),callbacks,cfg);
  assert.equal(done.status,'succeeded');
  assert.equal((await cfg.auth.readTerminalResult(done.resultRef,cfg)).state.answer,'accepted');
});

test('Host cancellation fences new claims and leaves prior claims available for reconciliation',async t=>{
  const f=await fixture(t);
  const pending=await start(f.program,runtime,{message:'hello'},f.options);
  const operationController=f.persistence.operationController;
  const input={runId:pending.runId,requestId:pending.pending[0].requestId,
    operationKey:sha256Bytes(Buffer.from('operation')),inputHash:sha256Bytes(Buffer.from('input'))};
  assert.equal((await operationController.claim(input,f.options.auth)).claimed,true);
  await assert.rejects(cancelInteractiveRun(pending.runId,'OPERATOR_CANCEL',
    {...f.options,auth:context({authorize:()=>false})}),{code:'FK_I_HOST_DENIED'});
  const cancelled=await cancelInteractiveRun(pending.runId,'OPERATOR_CANCEL',f.options);
  assert.equal(cancelled.status,'cancelled');
  assert.deepEqual(await cancelInteractiveRun(pending.runId,'OPERATOR_CANCEL',f.options),cancelled);
  await assert.rejects(operationController.claim(input,f.options.auth),{code:'FK_I_STALE_RECEIPT'});
  const result=await operationController.settle({runId:pending.runId,operationKey:input.operationKey,
    inputHash:input.inputHash,effect:'applied',evidenceHash:input.inputHash,result:{upstream:'effect remains'}},f.options.auth);
  assert.equal(result.settlement.effect,'applied');
  assert.deepEqual(await resume(pending.runId,runtime,f.options),cancelled);
});

test('P1 publishes independent Pending and commits all patches only after the last success',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'parallel-success.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-success',name:'Parallel success',version:'1.0.0',nodes:[
parallel('checks',{name:'Checks',branches:['left','right'],join:{strategy:'all_succeeded',next:'done'}}),
verification('left',{name:'Left',verifier:'left-check'}),
verification('right',{name:'Right',verifier:'right-check'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),
    policy:{...policy,capabilityStage:'P1',bindingManifest:{}}};
  const waiting=await start(file,{}, {input:'baseline'},cfg);
  assert.deepEqual(waiting.pending.map(task=>task.nodeId),['left','right']);
  const submit=(task)=>({kind:'verification',runId:waiting.runId,requestId:task.requestId,
    outcome:'succeeded',result:{passed:true}});
  const left=await complete(submit(waiting.pending[0]),{},cfg);
  assert.equal(left.pending[0].requestId,waiting.pending[1].requestId);
  assert.deepEqual((await cfg.store.load(waiting.runId)).state,{input:'baseline'});
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const options={...cfg,...reopened};
    const done=await complete(submit(waiting.pending[1]),{},options);
    assert.equal(done.status,'succeeded');
    assert.deepEqual((await options.auth.readTerminalResult(done.resultRef,options)).state,
      {input:'baseline',left:true,right:true});
    assert.equal((await complete(submit(waiting.pending[0]),{},options)).acknowledgement.repeated,true);
    const racing=await start(file,{}, {},{...options,startKey:'p1-race'});
    const sdk=new URL('../../src/interactive/index.mjs',import.meta.url).href;
    const workerScript=`
      const [sdk,file,namespace,serialized]=process.argv.slice(1);
      const {createSqliteInteractivePersistence,createInteractiveHostContext,complete}=await import(sdk);
      const {policy,input}=JSON.parse(serialized);
      const db=createSqliteInteractivePersistence(file,{namespace});
      const auth=createInteractiveHostContext({namespace,subjectId:'parallel-worker',authorize:()=>true,authorizeTask:()=>true});
      try {
        const options={...db,policy,auth};
        try {await complete(input,{},options);}
        catch (error) {if (error.code!=='FK_I_STORE_UNCERTAIN') throw error; await complete(input,{},options);}
      } finally {db.close();}
    `;
    await Promise.all(racing.pending.map(task=>new Promise((resolve,reject)=>{
      const input={...submit(task),runId:racing.runId};
      const child=spawn(process.execPath,['--input-type=module','-e',workerScript,sdk,f.file,ns,
        JSON.stringify({policy:cfg.policy,input})],{stdio:['ignore','ignore','pipe']});
      let errors='';
      child.stderr.on('data',chunk=>{errors+=chunk;});
      child.on('error',reject);
      child.on('exit',code=>code===0?resolve():reject(new Error(errors)));
    })));
    const joined=await resume(racing.runId,{},options);
    assert.equal(joined.status,'succeeded');
    assert.deepEqual((await options.auth.readTerminalResult(joined.resultRef,options)).state,{left:true,right:true});
  } finally {reopened.close();}
});

test('P1 business failure fences other branches and awaits their operation evidence',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'parallel-failure.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,verification,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-fail',name:'Parallel failure',version:'1.0.0',nodes:[
parallel('checks',{name:'Checks',branches:['business-write','competing-write','gate'],join:{strategy:'all_succeeded',next:'done'}}),
action('business-write',{name:'Write',action:'some-write',writes:['external']}),
action('competing-write',{name:'Alternate',action:'some-write',writes:['alternate']}),
verification('gate',{name:'Gate',verifier:'gate-check'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),
    policy:{...policy,capabilityStage:'P1',bindingManifest:{}}};
  const waiting=await start(file,{}, {},cfg);
  const [writer,competing,verifier]=waiting.pending;
  const claim={runId:waiting.runId,requestId:writer.requestId,operationKey:writer.task.operationKey,
    inputHash:sha256Bytes(canonicalBytes(writer.task)),businessKey:sha256Bytes(Buffer.from('external effect'))};
  assert.equal((await cfg.operationController.claim(claim,cfg.auth)).claimed,true);
  await assert.rejects(cfg.operationController.claim({...claim,requestId:competing.requestId,
    operationKey:competing.task.operationKey,inputHash:sha256Bytes(canonicalBytes(competing.task))},cfg.auth),
  {code:'FK_I_OPERATION_CONFLICT'});
  const paused=await complete({kind:'verification',runId:waiting.runId,requestId:verifier.requestId,
    outcome:'succeeded',result:{passed:false}},{},cfg);
  assert.equal(paused.status,'paused');
  assert.equal(paused.pauseReason,'reconciliation');
  assert.deepEqual(paused.pending,[]);
  await assert.rejects(cfg.operationController.claim(claim,cfg.auth),{code:'FK_I_STALE_RECEIPT'});
  const {runId,operationKey,inputHash}=claim;
  const result={set:{external:'confirmed'}};
  await cfg.operationController.settle({runId,operationKey,inputHash,
    effect:'applied',evidenceHash:inputHash,result},cfg.auth);
  await assert.rejects(complete({kind:'action',runId,requestId:writer.requestId,operationKey,
    outcome:'succeeded',result},{},cfg),{code:'FK_I_STALE_RECEIPT'});
  const failed=await resume(runId,{},cfg);
  assert.equal(failed.status,'failed');
  assert.equal((await cfg.store.load(runId)).revision,failed.revision);
  assert.deepEqual((await cfg.auth.readTerminalResult(failed.resultRef,cfg)).state,{});
  const another=await start(file,{}, {},{...cfg,startKey:'undispatched'});
  const alternate=another.pending.find(task=>task.nodeId==='competing-write');
  const denied=await complete({kind:'action',runId:another.runId,requestId:alternate.requestId,
    operationKey:alternate.task.operationKey,outcome:'failed',error:{
      code:'FK_I_ACTION_NOT_DISPATCHED',message:'Business authorization denied',sideEffectStatus:'none',
    }},{},cfg);
  assert.equal(denied.status,'errored');
  assert.equal((await cfg.store.loadReceipt(another.runId,alternate.requestId)).outcome,'failed');
});

test('P2 all-succeeded failure preserves a nested sibling claim across restart',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'scoped-failure.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,verification,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'scoped-failure',name:'Scoped failure',version:'1.0.0',nodes:[
parallel('outer',{name:'Outer',branchMode:'subflow',branches:['gate','inner'],join:{strategy:'all_succeeded',next:'done'}}),
verification('gate',{name:'Gate',verifier:'gate-check',onSuccess:'done',onFailure:'rejected'}),
parallel('inner',{name:'Inner',branchMode:'subflow',branches:['read','write'],join:{strategy:'all_succeeded',next:'done'}}),
verification('read',{name:'Read',verifier:'read-check',onSuccess:'done',onFailure:'inner-rejected'}),
action('write',{name:'Write',action:'external-write',effect:'write',reads:[],writes:['receipt'],next:'done'}),
terminal('done',{name:'Done',status:'succeeded'}),
terminal('inner-rejected',{name:'Inner rejected',status:'failed'}),
terminal('rejected',{name:'Rejected',status:'failed'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),policy:{...policy,capabilityStage:'P2',bindingManifest:{}}};
  const {runId,pending}=await start(file,{}, {},cfg);
  const writer=pending.find(task=>task.nodeId==='write');
  const verifier=pending.find(task=>task.nodeId==='gate');
  const {operationKey}=writer.task;
  const inputHash=sha256Bytes(canonicalBytes(writer.task));
  const claim={runId,requestId:writer.requestId,operationKey,inputHash,businessKey:inputHash};
  assert.equal((await cfg.operationController.claim(claim,cfg.auth)).claimed,true);
  const rejection={kind:'verification',runId,requestId:verifier.requestId,outcome:'succeeded',result:{passed:false}};
  const paused=await complete(rejection,{},cfg);
  assert.equal(paused.status,'paused');
  assert.equal(paused.pauseReason,'reconciliation');
  assert.equal(paused.resultRef,undefined);
  assert.deepEqual(paused.pending,[]);
  assert.ok(paused.cancelledRequests.includes(writer.requestId));
  f.closePersistence();
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const options={...cfg,...reopened};
    const recovered=await resume(runId,{},options);
    assert.equal(recovered.pauseReason,'reconciliation');
    assert.equal(recovered.revision,paused.revision);
    assert.equal((await complete(rejection,{},options)).acknowledgement.repeated,true);
    assert.equal((await options.operationController.load({runId,operationKey},cfg.auth)).settlement,null);
    await assert.rejects(options.operationController.claim(claim,cfg.auth),{code:'FK_I_STALE_RECEIPT'});
    await options.operationController.settle({runId,operationKey,inputHash,effect:'no-effect',
      evidenceHash:inputHash,result:{set:{}}},cfg.auth);
    const failed=await resume(runId,{},options);
    assert.equal(failed.status,'failed');
    assert.deepEqual((await cfg.auth.readTerminalResult(failed.resultRef,options)).state,{});
  } finally {reopened.close();}
});

test('Parallel SDK settles retry-budget exhaustion and routes P2 API Agent writes through the durable controller',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'parallel-task.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-tasks',name:'Parallel tasks',version:'1.0.0',nodes:[
parallel('tasks',{name:'Tasks',branches:['left','right'],join:{strategy:'all_succeeded',next:'done'}}),
node('left',{name:'Left',description:'Write the left result',output:{type:'object',properties:{answer:{type:'string'}}},retries:1}),
node('right',{name:'Right',description:'Write the right result',output:{type:'object',properties:{right:{type:'string'}}},retries:0}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const binding=(id,implementation)=>({id,version:'1',mode:'trusted-read',implementation});
  const prepareAgentTask=binding('prep',(task,ctx)=>({protocolVersion:2,task,descriptionResources:ctx.descriptionResources,skills:[]}));
  const authorizeAgentTask=binding('authorize',()=>true);
  const callbacks={validateResult:runtime.validateResult,prepareAgentTask,authorizeAgentTask};
  const {implementation:_prep,...prepareBinding}=prepareAgentTask;
  const {implementation:_authorize,...authorizeBinding}=authorizeAgentTask;
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),
    policy:{...policy,capabilityStage:'P1',bindingManifest:{validateResult:policy.bindingManifest.validateResult,
      prepareAgentTask:prepareBinding,authorizeAgentTask:authorizeBinding},
    taskPolicy:{projectRoot:f.dir,maxDispatches:2,hostProfile:{schemaVersion:1,executionModes:['interactive-p0-a'],capabilities:{}}}}};
  const first=await start(file,callbacks,{},cfg);
  assert.equal(first.pending.length,2);
  const exhausted=await complete(submission(first,{}),callbacks,cfg);
  assert.equal(exhausted.status,'errored');
  assert.ok(await cfg.store.loadReceipt(first.runId,first.pending[0].requestId));

  const anyFile=path.join(f.dir,'parallel-agent-any.workflow.js');
  const code=await readFile(file,'utf8');
  await writeFile(anyFile,code.replace("strategy:'all_succeeded'","strategy:'any'"));
  const toolsCfg={...cfg,startKey:'api-tool',policy:{...cfg.policy,capabilityStage:'P2',parallelEffectMode:'retain'}};
  const second=await start(anyFile,callbacks,{},toolsCfg);
  const [left,right]=second.pending;
  let writes=0;
  const adapterOptions={scope:'fixture',model:'fixture',
    request:async body=>new Response(JSON.stringify(body.previous_response_id
      ? {id:'second',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"answer":"recorded"}'}]}]}
      : {id:'first',status:'completed',output:[{type:'function_call',name:'write',call_id:'tool-one',arguments:'{}'}]})),
    tools:[{name:'write',description:'Write a fixture',parameters:{type:'object'},sideEffect:'write',
      validate:()=>[],operationKey:()=> 'shared-business-effect',execute:async()=>({writes:++writes})}],authorizeTool:()=>true};
  const adapter=createApiAgentAdapter(adapterOptions);
  const attached={interactiveOperations:{controller:cfg.operationController,auth:cfg.auth}};
  const unbound=await adapter.runAgentTask(left.task.preparedTask);
  assert.equal(unbound.failure?.code,'durable-operation-required');
  assert.equal(writes,0);
  const written=await adapter.runAgentTask(left.task.preparedTask,attached);
  assert.equal(written.status,'succeeded');
  assert.equal((await adapter.runAgentTask(left.task.preparedTask,attached)).status,'succeeded');
  assert.equal((await adapter.runAgentTask(right.task.preparedTask,attached)).failure?.code,'FK_I_OPERATION_CONFLICT');
  assert.equal(writes,1);
  const winner=await complete(submission(second,written.result),callbacks,toolsCfg);
  assert.equal(winner.status,'succeeded');
  assert.deepEqual(winner.cancelledRequests,[right.requestId]);

  const seqFile=path.join(f.dir,'sequential-tool.workflow.js');
  await writeFile(seqFile,code.replace(/parallel\('tasks'.*\n/, '')
    .replace('retries:1})',"retries:1,next:'done'})").replace(/node\('right'.*\n/,''));
  const sequential={...cfg,startKey:'sequential-tool',policy:{...cfg.policy,capabilityStage:'P0-B'}};
  const opened=await start(seqFile,callbacks,{},sequential);
  const task=opened.pending[0].task.preparedTask;
  assert.equal((await adapter.runAgentTask(task,attached)).status,'succeeded');
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const restored={interactiveOperations:{controller:reopened.operationController,auth:cfg.auth}};
    assert.equal((await createApiAgentAdapter(adapterOptions).runAgentTask(task,restored)).status,'succeeded');
    assert.equal(writes,2);
    assert.equal((await reopened.operationController.list({runId:opened.runId},cfg.auth)).length,1);
  } finally {reopened.close();}

  const retryCfg={...cfg,startKey:'safe-retry',policy:{...cfg.policy,
    taskPolicy:{...cfg.policy.taskPolicy,maxDispatches:4}}};
  const retryStart=await start(file,callbacks,{},retryCfg);
  const [retryLeft]=retryStart.pending;
  const key=sha256Bytes(Buffer.from('safe-retry'));
  const original={runId:retryStart.runId,requestId:retryLeft.requestId,operationKey:key,inputHash:key,businessKey:key};
  await cfg.operationController.claim(original,cfg.auth);
  const permittable={message:'reconciled',code:'fixture-no-effect',retryable:true,sideEffectStatus:'none'};
  await cfg.operationController.settle({runId:retryStart.runId,operationKey:key,inputHash:key,
    evidenceHash:key,effect:'no-effect',result:permittable},cfg.auth);
  const retry=await complete({runId:retryStart.runId,requestId:retryLeft.requestId,kind:'agent',
    outcome:'failed',error:permittable},callbacks,retryCfg);
  const nextTry=retry.pending.find(item=>item.nodeId==='left');
  assert.equal(nextTry.attempt,2);
  const newKey=sha256Bytes(Buffer.from('new-attempt'));
  const newClaim={...original,requestId:nextTry.requestId,operationKey:newKey};
  await assert.rejects(cfg.operationController.claim({...newClaim,inputHash:newKey},cfg.auth),
    {code:'FK_I_OPERATION_CONFLICT'});
  assert.equal((await cfg.operationController.claim(newClaim,cfg.auth)).claimed,true);
  assert.equal((await cfg.operationController.claim(newClaim,cfg.auth)).claimed,false);

  let enteredRetry, releaseRetry;
  const entered=new Promise(resolve=>{enteredRetry=resolve;});
  const wait=new Promise(resolve=>{releaseRetry=resolve;});
  const delayed={...callbacks,prepareAgentTask:{...prepareAgentTask,implementation:async(task,ctx)=>{
    if (task.execution.attempt===2) {enteredRetry();await wait;}
    return prepareAgentTask.implementation(task,ctx);
  }}};
  const raceCfg={...cfg,startKey:'tool-race',policy:{...cfg.policy,taskPolicy:{...cfg.policy.taskPolicy,maxDispatches:4}}};
  const racing=await start(file,delayed,{},raceCfg);
  const completing=complete(submission(racing,{}),delayed,raceCfg);
  await entered;
  try {
    const key=sha256Bytes(Buffer.from('concurrent-write'));
    await cfg.operationController.claim({runId:racing.runId,requestId:racing.pending[0].requestId,
      operationKey:key,inputHash:key,businessKey:key},cfg.auth);
  } finally {releaseRetry();}
  await assert.rejects(completing,{code:'FK_I_RECONCILIATION_PENDING'});
  assert.deepEqual((await cfg.store.load(racing.runId)).pending.map(task=>task.attempt),[1,1]);

  const mixedFile=path.join(f.dir,'parallel-deadline.workflow.js');
  await writeFile(mixedFile,`import {defineWorkflow,parallel,node,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-expiry',name:'Parallel expiry',version:'1.0.0',nodes:[
parallel('group',{name:'Group',branches:['worker','check'],join:{strategy:'any',next:'done'}}),
node('worker',{name:'Worker',description:'Return a candidate',output:{type:'object',properties:{answer:{type:'string'}}}}),
verification('check',{name:'Check',verifier:'plain-read'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const deadline=Date.now()+60_000;
  const expiring={...toolsCfg,startKey:'expired-agent',policy:{...toolsCfg.policy,
    taskPolicy:{...toolsCfg.policy.taskPolicy,deadlineMs:deadline}}};
  const mixed=await start(mixedFile,callbacks,{},expiring);
  const [lateAgent,plainCheck]=mixed.pending;
  const fakeTime=t.mock.method(Date,'now',()=>deadline+100);
  try {
    const key=sha256Bytes(Buffer.from('expired-effect'));
    await assert.rejects(expiring.operationController.claim({runId:mixed.runId,requestId:lateAgent.requestId,
      operationKey:key,inputHash:key,businessKey:key},expiring.auth),{code:'FK_I_STALE_RECEIPT'});
    const finished=await complete({kind:'verification',runId:mixed.runId,requestId:plainCheck.requestId,
      outcome:'succeeded',result:{passed:true}},callbacks,expiring);
    assert.equal(finished.status,'succeeded');
    assert.deepEqual(finished.cancelledRequests,[lateAgent.requestId]);
  } finally {fakeTime.mock.restore();}
});

test('P0-B fences expired Actions and durably acknowledges a previous accepted receipt',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'sequential-deadline.workflow.js');
  await writeFile(file,`import {defineWorkflow,node,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'sequential-deadline',name:'Sequential deadline',version:'1.0.0',nodes:[
node('worker',{name:'Worker',description:'Return an answer',output:{type:'object'},next:'write'}),
action('write',{name:'Write',action:'persist',writes:[],next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const prepare={id:'prep',version:'1',mode:'trusted-read'};
  const authorize={id:'auth',version:'1',mode:'trusted-read'};
  const callbacks={validateResult:runtime.validateResult,
    prepareAgentTask:{...prepare,implementation:(task,ctx)=>({protocolVersion:2,task,skills:[],descriptionResources:ctx.descriptionResources})},
    authorizeAgentTask:{...authorize,implementation:()=>true}};
  const deadline=Date.now()+60_000;
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),policy:{...policy,capabilityStage:'P0-B',
    taskPolicy:{projectRoot:f.dir,deadlineMs:deadline},bindingManifest:{validateResult:policy.bindingManifest.validateResult,
      prepareAgentTask:prepare,authorizeAgentTask:authorize}}};
  const first=await start(file,callbacks,{},cfg);
  const firstReceipt=submission(first);
  const next=await complete(firstReceipt,callbacks,cfg);
  assert.equal(next.pending[0].kind,'action');
  const action=next.pending[0];
  const time=t.mock.method(Date,'now',()=>deadline+1);
  try {
    await assert.rejects(cfg.operationController.claim({runId:next.runId,requestId:action.requestId,
      operationKey:action.task.operationKey,inputHash:sha256Bytes(canonicalBytes(action.task))},cfg.auth),
    {code:'FK_I_STALE_RECEIPT'});
    const confirmed=await complete(firstReceipt,callbacks,cfg);
    assert.equal(confirmed.acknowledgement.repeated,true);
    assert.equal(confirmed.status,'errored');
    assert.equal((await cfg.auth.readTerminalResult(confirmed.resultRef,cfg)).causeCode,'FK_R004');
  } finally {time.mock.restore();}
});

test('P2 isolates preparation errors, restricts scoped task receipts and checks Action inputs',async t=>{
  const f=await fixture(t);
  const entry=`import {defineWorkflow,parallel,node,action,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-guards',name:'Parallel guards',version:'1.0.0',nodes:[`;
  const done=`terminal('done',{name:'Done',status:'succeeded'})]});`;
  const check=(frame,pending)=>({runId:frame.runId,requestId:pending.requestId,kind:'verification',
    outcome:'succeeded',result:{passed:true}});
  const file=path.join(f.dir,'guard.workflow.js');
  const left=`verification('left',{name:'Left',verifier:'left-check'})`;
  const right=`verification('right',{name:'Right',verifier:'right-check'})`;
  const group=next=>`parallel('race',{name:'Race',branches:['left','right'],join:{strategy:'any',next:'${next}'}})`;
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),policy:{...policy,capabilityStage:'P2',bindingManifest:{}}};
  await writeFile(file,[entry+group('done'),left,
    "node('right',{name:'Right',agent:'writer',inputs:[],output:{type:'object'}})",done].join(','));
  const compiled=await compileInteractive(file,{output:'memory',featureStage:'P2',skillCheck:false});
  const ref=await cfg.programRegistry.putImmutable(Buffer.from(compiled.code),compiled.programIdentity);
  const skillFailure={...runtime,skillResolver:{...runtime.skillResolver,implementation:async()=>{throw new Error('local failure');}}};
  const other={...cfg,startKey:'local-error',policy:{...policy,capabilityStage:'P2'}};
  const ready=await start(ref,skillFailure,{},other);
  assert.deepEqual(ready.pending.map(item=>item.nodeId),['left']);
  assert.equal((await complete(check(ready,ready.pending[0]),skillFailure,other)).status,'succeeded');

  await writeFile(file,[entry+group('publish'),left,right,
    "action('publish',{name:'Publish',action:'publish',reads:['left'],writes:[],next:'done'})",done].join(','));
  const mixed=await start(file,{}, {},{...cfg,startKey:'input'});
  const restricted={...cfg,auth:context({subjectId:'right-host',authorizeTask:({nodeId})=>nodeId==='right'})};
  const drawn=await resume(mixed.runId,{},restricted);
  assert.deepEqual(drawn.pending.map(item=>item.nodeId),['right']);
  await assert.rejects(complete(check(mixed,mixed.pending[0]),{},restricted),{code:'FK_I_HOST_DENIED'});
  const blocked=await complete(check(drawn,drawn.pending[0]),{},restricted);
  assert.deepEqual(blocked.pending,[]);
  assert.equal((await cfg.auth.readTerminalResult(blocked.resultRef,cfg)).causeCode,'FK_I_PARALLEL_INPUT');

  await writeFile(file,[entry+group('done').replace("'any'","'all_succeeded'"),left,right,done].join(','));
  const separate={...cfg,startKey:'separate-workers',policy:{...cfg.policy,capabilityStage:'P1'}};
  const two=await start(file,{}, {},separate);
  const leftHost={...separate,auth:context({subjectId:'left-host',authorizeTask:({nodeId})=>nodeId==='left'})};
  const rightHost={...separate,auth:restricted.auth};
  const [leftView,rightView]=await Promise.all([resume(two.runId,{},leftHost),resume(two.runId,{},rightHost)]);
  assert.deepEqual(leftView.pending.map(item=>item.nodeId),['left']);
  assert.deepEqual(rightView.pending.map(item=>item.nodeId),['right']);
  const leftReceipt=check(leftView,leftView.pending[0]);
  const leftDone=await complete(leftReceipt,{},leftHost);
  assert.equal(leftDone.status,'waiting');
  assert.deepEqual(leftDone.pending,[]);
  await assert.rejects(complete(leftReceipt,{},rightHost),{code:'FK_I_HOST_DENIED'});
  assert.equal((await complete(check(rightView,rightView.pending[0]),{},rightHost)).status,'succeeded');
});

test('Structured parallel subflows resume a nested race inside a Human-approved Loop',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'structured.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,human,condition,loop,action,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'structured',name:'Structured',version:'1.0.0',nodes:[
parallel('outer',{name:'Outer',branchMode:'subflow',branches:['review','side'],join:{strategy:'all_succeeded',next:'done'}}),
human('review',{name:'Review',onApprove:'choose',onReject:'revise',maxRevisions:1}),
action('revise',{name:'Revise',action:'read-revision',effect:'read-only',reads:[],writes:[],next:'review'}),
condition('choose',{name:'Choose',branches:[{when:'true',next:'retry-loop'}]}),
loop('retry-loop',{name:'Retry loop',body:'validate',maxIterations:2,onSuccess:'done',onMaxExceeded:'exhausted'}),
verification('validate',{name:'Validate',verifier:'validation',onSuccess:'retry-loop',onFailure:'repair'}),
parallel('repair',{name:'Repair',branchMode:'subflow',branches:['a','b'],join:{strategy:'any',next:'validate'}}),
action('a',{name:'Repair A',action:'read-repair',effect:'read-only',reads:[],writes:['repaired'],next:'validate'}),
verification('b',{name:'Repair B',verifier:'alternate',onSuccess:'validate',onFailure:'rejected'}),
terminal('rejected',{name:'Rejected',status:'failed'}),
terminal('exhausted',{name:'Exhausted',status:'failed'}),
action('side',{name:'Side',action:'read-side',effect:'read-only',reads:[],writes:['side'],next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const auth=context({authorizeTask:()=>true,authorizeHuman:request=>({proofId:'approved',evidenceHash:request.reviewDigest})});
  const cfg={...f.options,auth,policy:{...policy,capabilityStage:'P2',bindingManifest:{}}};
  const frame=await start(file,{}, {},cfg);
  const lookup=(current,id)=>current.pending.find(pending=>pending.nodeId===id);
  assert.deepEqual(frame.pending.map(item=>item.nodeId),['review','side']);
  const review=lookup(frame,'review');
  const checked=await complete({runId:frame.runId,requestId:review.requestId,kind:'human',
    reviewDigest:review.task.reviewDigest,outcome:'succeeded',result:{approved:true}},{},cfg);
  const verify=(current,id,passed,options)=>complete({runId:current.runId,requestId:lookup(current,id).requestId,
    kind:'verification',outcome:'succeeded',result:{passed}},{},options);
  const race=await verify(checked,'validate',false,cfg);
  assert.deepEqual(race.pending.map(item=>item.nodeId),['a','b','side']);
  const {graphSnapshot}=await compileInteractive(file,{featureStage:'P2',output:'memory'});
  const viewerRef={namespace:ns,runId:frame.runId,artifactHash:graphSnapshot.artifactHash,graphDigest:graphSnapshot.graphDigest};
  const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const options={...cfg,...reopened};
    const resumeFrame=await resume(frame.runId,{},options);
    assert.deepEqual(resumeFrame.pending,race.pending);
    const viewOptions={...options,graphSnapshot};
    const raceView=await auth.readRunView(viewerRef,viewOptions);
    const repairView=raceView.pending.find(item=>item.nodeId==='a');
    assert.deepEqual(repairView.scope,[{groupId:'outer',laneId:'review'},{groupId:'repair',laneId:'a'}]);
    const read=async (current,id,set,selected=options)=>{
      const task=lookup(current,id);
      const operationKey=task.task.operationKey;
      const inputHash=sha256Bytes(canonicalBytes(task.task));
      const result={set};
      await selected.operationController.claim({runId:current.runId,requestId:task.requestId,operationKey,inputHash},auth);
      await selected.operationController.settle({runId:current.runId,operationKey,inputHash,effect:'no-effect',
        evidenceHash:inputHash,result},auth);
      return complete({runId:current.runId,requestId:task.requestId,operationKey,kind:'action',outcome:'succeeded',result},{},selected);
    };
    const repaired=await read(resumeFrame,'a',{repaired:true});
    assert.ok(repaired.cancelledRequests.includes(lookup(race,'b').requestId));
    assert.equal(lookup(repaired,'side').requestId,lookup(frame,'side').requestId);
    const replay=await auth.listRunViewEvents({ref:viewerRef,afterRevision:resumeFrame.revision,limit:100},viewOptions);
    const receipt=replay.events.find(event=>event.requestId===repairView.requestId);
    assert.equal(receipt.kind,'receipt.accepted');
    assert.deepEqual(receipt.scope,repairView.scope);
    assert.equal(receipt.activation,repairView.activation);
    assert.equal(receipt.attempt,repairView.attempt);
    assert.equal(receipt.receiptOutcome,'succeeded');
    const rechecked=await verify(repaired,'validate',true,options);
    const result=await read(rechecked,'side',{side:1});
    assert.equal(result.status,'succeeded');
    assert.deepEqual((await auth.readTerminalResult(result.resultRef,options)).state,
      {review:{approved:true,comment:null},repaired:true,side:1});

    const original=await readFile(file,'utf8');
    await writeFile(file,original.replace("strategy:'all_succeeded'","strategy:'any'")
      .replace("effect:'read-only',reads:[],writes:['repaired']","effect:'write',reads:[],writes:['repaired']"));
    const writes={...options,startKey:'ancestor-wins',policy:{...options.policy,parallelEffectMode:'compensate'}};
    const active=await start(file,{}, {},writes);
    const human=lookup(active,'review');
    const inside=await complete({runId:active.runId,requestId:human.requestId,kind:'human',
      reviewDigest:human.task.reviewDigest,outcome:'succeeded',result:{approved:true}},{},writes);
    const nested=await verify(inside,'validate',false,writes);
    const losing=lookup(nested,'a');
    const operationKey=losing.task.operationKey;
    const inputHash=sha256Bytes(canonicalBytes(losing.task));
    const op={runId:active.runId,requestId:losing.requestId,operationKey,inputHash,businessKey:inputHash,
      compensationPlan:{capabilityId:'release',inputHash}};
    await writes.operationController.claim(op,auth);
    const sealed=await read(nested,'side',{side:2},writes);
    assert.equal(sealed.pauseReason,'reconciliation');
    assert.deepEqual(new Set(sealed.cancelledRequests),new Set([losing.requestId,lookup(nested,'b').requestId]));
    await assert.rejects(writes.operationController.claim(op,auth),{code:'FK_I_STALE_RECEIPT'});
    await writes.operationController.settle({runId:active.runId,operationKey,inputHash,effect:'applied',
      evidenceHash:inputHash,result:{set:{repaired:true}}},auth);
    const compensated=await writes.operationController.claimCompensation({runId:active.runId,operationKey},auth);
    await writes.operationController.settleCompensation({runId:active.runId,operationKey,
      compensationKey:compensated.compensation.key,evidenceHash:inputHash},auth);
    const terminal=await resume(active.runId,{},writes);
    assert.deepEqual((await auth.readTerminalResult(terminal.resultRef,writes)).state,{side:2});

    await writeFile(file,original.replace("writes:['side'],next:'done'","writes:['side'],next:'a'"));
    const rejected=await compileInteractive(file,{featureStage:'P2',output:'memory'});
    assert.ok(rejected.diagnostics.some(item=>item.code==='FK_C024'));
  } finally {reopened.close();}
});

test('P2 read-only Actions can win with a no-effect settlement and no compensation',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'read-only.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,action,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'read-only',name:'Read only',version:'1.0.0',nodes:[
parallel('race',{name:'Race',branches:['read','alt'],join:{strategy:'any',next:'done'}}),
action('read',{name:'Read',action:'read-counter',effect:'read-only',reads:[],writes:['counter']}),
verification('alt',{name:'Alternative',verifier:'no-write'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),policy:{...policy,
    capabilityStage:'P2',parallelEffectMode:'compensate',bindingManifest:{}}};
  const frame=await start(file,{}, {},cfg);
  const [request]=frame.pending;
  const operationKey=request.task.operationKey;
  const inputHash=sha256Bytes(canonicalBytes(request.task));
  const claim=await cfg.operationController.claim({runId:frame.runId,requestId:request.requestId,operationKey,inputHash},cfg.auth);
  assert.equal(claim.readOnly,true);
  const result={set:{counter:1}};
  const settlement={runId:frame.runId,operationKey,inputHash,evidenceHash:inputHash,result};
  await assert.rejects(cfg.operationController.settle({...settlement,effect:'applied'},cfg.auth),{code:'FK_I_OPERATION_CONFLICT'});
  await cfg.operationController.settle({...settlement,effect:'no-effect'},cfg.auth);
  const done=await complete({runId:frame.runId,requestId:request.requestId,operationKey,
    kind:'action',outcome:'succeeded',result},{},cfg);
  assert.deepEqual((await cfg.auth.readTerminalResult(done.resultRef,cfg)).state,{counter:1});
});

test('P2 selects the first qualified Verification, preserves inputs, and never merges the loser',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'parallel-any.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-any',name:'Parallel any',version:'1.0.0',nodes:[
parallel('checks',{name:'Checks',branches:['left','right'],join:{strategy:'any',next:'done'}}),
verification('left',{name:'Left',verifier:'left-check'}),
verification('right',{name:'Right',verifier:'right-check'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),
    policy:{...policy,capabilityStage:'P2',bindingManifest:{}}};
  const check=(frame,task,passed)=>({kind:'verification',runId:frame.runId,requestId:task.requestId,
    outcome:'succeeded',result:{passed}});
  const frame=await start(file,{}, {base:1},cfg);
  const [left,right]=frame.pending;
  assert.equal((await complete(check(frame,left,false),{},cfg)).status,'waiting');
  const done=await complete(check(frame,right,true),{},cfg);
  assert.equal(done.status,'succeeded');
  assert.deepEqual((await cfg.auth.readTerminalResult(done.resultRef,cfg)).state,{base:1,right:true});

  const racing=await start(file,{}, {},{...cfg,startKey:'p2-race'});
  const other=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const races=await Promise.allSettled([
      complete(check(racing,racing.pending[0],true),{},cfg),
      complete(check(racing,racing.pending[1],true),{},{...cfg,...other}),
    ]);
    assert.equal(races.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(races.find(item=>item.status==='rejected').reason.code,'FK_I_STALE_RECEIPT');
    const terminal=await resume(racing.runId,{},{...cfg,...other});
    const state=(await cfg.auth.readTerminalResult(terminal.resultRef,cfg)).state;
    assert.equal(Object.keys(state).length,1);
    assert.equal(Object.values(state)[0],true);
  } finally {other.close();}

  const invalid=await start(file,{}, {},{...cfg,startKey:'p2-error'});
  const [bad,rejected]=invalid.pending;
  await complete(check(invalid,bad,'malformed'),{},cfg);
  const failure=await complete(check(invalid,rejected,false),{},cfg);
  assert.equal(failure.status,'errored');
  assert.equal((await cfg.auth.readTerminalResult(failure.resultRef,cfg)).causeCode,'FK_I_VERIFICATION_CONTRACT');

  const consumes=path.join(f.dir,'parallel-consumer.workflow.js');
  const original=await readFile(file,'utf8');
  await writeFile(consumes,original.replace('parallel,verification,terminal','parallel,verification,condition,node,terminal')
    .replace("strategy:'any',next:'done'","strategy:'any',next:'route'")
    .replace("terminal('done'",`condition('route',{name:'Route',branches:[{when:'true',next:'consumer'}]}),
node('consumer',{name:'Consumer',agent:'writer',inputs:['left'],output:{type:'object'},next:'done'}),
terminal('done'`));
  const checked=await compileInteractive(consumes,{output:'memory',featureStage:'P2',skillCheck:false});
  assert.ok(checked.code,JSON.stringify(checked.diagnostics));
  const ref=await cfg.programRegistry.putImmutable(Buffer.from(checked.code),checked.programIdentity);
  const inputsCfg={...cfg,startKey:'p2-required-input',policy:{...policy,capabilityStage:'P2'}};
  const invalidInputs=await start(ref,runtime,{},inputsCfg);
  assert.equal(invalidInputs.status,'errored');
  assert.deepEqual(invalidInputs.pending,[]);
  assert.equal((await inputsCfg.auth.readTerminalResult(invalidInputs.resultRef,inputsCfg)).causeCode,'FK_I_PARALLEL_INPUT');
});

test('P2 seals the winner across process death and gates the next step on loser reconciliation and compensation',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'parallel-writes.workflow.js');
  await writeFile(file,`import {defineWorkflow,parallel,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'parallel-writes',name:'Parallel writes',version:'1.0.0',nodes:[
parallel('race',{name:'Race',branches:['winner-write','loser-write'],join:{strategy:'any',next:'done'}}),
action('winner-write',{name:'Primary',action:'primary-write',writes:['winner']}),
action('loser-write',{name:'Alternate',action:'alternate-write',writes:['loser']}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  const cfg={...f.options,auth:context({authorizeTask:()=>true}),
    policy:{...policy,capabilityStage:'P2',parallelEffectMode:'compensate',bindingManifest:{}}};
  await assert.rejects(start(file,{}, {},{...cfg,policy:{...cfg.policy,parallelEffectMode:'retain-not-specified'}}),
    /Interactive policy/);
  const missingPolicy={...cfg.policy};
  delete missingPolicy.parallelEffectMode;
  await assert.rejects(start(file,{}, {},{...cfg,policy:missingPolicy}),{code:'FK_I_INVALID_OPERATION'});
  const frame=await start(file,{}, {baseline:true},cfg);
  const [winner,loser]=frame.pending;
  const claim=(task,logical)=>({runId:frame.runId,requestId:task.requestId,operationKey:task.task.operationKey,
    inputHash:sha256Bytes(canonicalBytes(task.task)),businessKey:sha256Bytes(Buffer.from(logical)),
    compensationPlan:{capabilityId:'release-reservation',inputHash:sha256Bytes(Buffer.from(logical))}});
  const main=claim(winner,'selected-reservation'),alt=claim(loser,'alternate-reservation');
  const operations=cfg.operationController;
  const {compensationPlan:_missing,...withoutCompensation}=main;
  await assert.rejects(operations.claim(withoutCompensation,cfg.auth),{code:'FK_I_INVALID_OPERATION'});
  assert.equal((await operations.claim(main,cfg.auth)).claimed,true);
  assert.equal((await operations.claim(alt,cfg.auth)).claimed,true);
  const external=new DatabaseSync(path.join(f.dir,'effects.sqlite'));
  try {
    external.exec('CREATE TABLE effects (key TEXT PRIMARY KEY, value TEXT)');
    const write=external.prepare('INSERT INTO effects VALUES (?,?)');
    write.run(main.operationKey,'selected');
    write.run(alt.operationKey,'alternate');
    const record=(operation,result)=>({runId:frame.runId,operationKey:operation.operationKey,
      inputHash:operation.inputHash,effect:'applied',evidenceHash:sha256Bytes(canonicalBytes(result)),result});
    const result={set:{winner:'selected'}};
    await operations.settle(record(main,result),cfg.auth);
    const sdk=new URL('../../src/interactive/index.mjs',import.meta.url).href;
    const worker=spawnSync(process.execPath,['--input-type=module','-e',`
      const [sdk,file,namespace,data]=process.argv.slice(1);
      const {policy,receipt}=JSON.parse(data);
      const {createSqliteInteractivePersistence,createInteractiveHostContext,complete}=await import(sdk);
      const persistence=createSqliteInteractivePersistence(file,{namespace});
      const auth=createInteractiveHostContext({namespace,subjectId:'worker',authorize:()=>true,authorizeTask:()=>true});
      const paused=await complete(receipt,{},{...persistence,policy,auth});
      if (paused.status!=='paused'||paused.pauseReason!=='reconciliation') throw Error('missing reconciliation gate');
      process.kill(process.pid,'SIGKILL');`,sdk,f.file,ns,JSON.stringify({policy:cfg.policy,receipt:{
      kind:'action',runId:frame.runId,requestId:winner.requestId,operationKey:main.operationKey,outcome:'succeeded',result,
    }})],{encoding:'utf8',timeout:20000});
    assert.notEqual(worker.status,0,worker.stderr);
    assert.equal(worker.error,undefined);
    const recovered=await resume(frame.runId,{},cfg);
    assert.equal(recovered.pauseReason,'reconciliation');
    assert.deepEqual(recovered.cancelledRequests,[loser.requestId]);
    assert.equal((await cfg.store.load(frame.runId)).execution.parallel.decision.winner,winner.nodeId);
    assert.deepEqual((await cfg.store.load(frame.runId)).state,{baseline:true});
    assert.equal((await operations.list({runId:frame.runId},cfg.auth)).filter(op=>!op.settlement).length,1);
    await assert.rejects(operations.claim(alt,cfg.auth),{code:'FK_I_STALE_RECEIPT'});
    await assert.rejects(operations.claimCompensation({runId:frame.runId,operationKey:main.operationKey},cfg.auth),
      {code:'FK_I_OPERATION_CONFLICT'});
    const losingResult={set:{loser:'alternate'}};
    await operations.settle(record(alt,losingResult),cfg.auth);
    await assert.rejects(complete({kind:'action',runId:frame.runId,requestId:loser.requestId,
      operationKey:alt.operationKey,outcome:'succeeded',result:losingResult},{},cfg),{code:'FK_I_STALE_RECEIPT'});
    assert.equal((await resume(frame.runId,{},cfg)).pauseReason,'reconciliation');
    const compensation={runId:frame.runId,operationKey:alt.operationKey};
    const processExit=spawnSync(process.execPath,['--input-type=module','-e',`
      const [sdk,file,namespace,input]=process.argv.slice(1);
      const {createSqliteInteractivePersistence,createInteractiveHostContext}=await import(sdk);
      const p=createSqliteInteractivePersistence(file,{namespace});
      const auth=createInteractiveHostContext({namespace,subjectId:'compensator',authorize:()=>true,authorizeTask:()=>true});
      const grant=await p.operationController.claimCompensation(JSON.parse(input),auth);
      process.stdout.write(JSON.stringify(grant),()=>process.kill(process.pid,'SIGKILL'));
    `,sdk,f.file,ns,JSON.stringify(compensation)],{encoding:'utf8',timeout:20000});
    assert.equal(processExit.error,undefined);
    assert.notEqual(processExit.status,0,processExit.stderr);
    const grant=JSON.parse(processExit.stdout);
    assert.equal(grant.claimed,true);
    assert.equal((await operations.claimCompensation(compensation,cfg.auth)).claimed,false);
    const oldAttempt={...compensation,compensationKey:grant.compensation.key,
      evidenceHash:sha256Bytes(Buffer.from('worker stopped before release'))};
    const recovery=await operations.recoverCompensation(oldAttempt,cfg.auth);
    assert.equal(recovery.claimed,true);
    assert.equal(recovery.compensation.idempotencyKey,grant.compensation.idempotencyKey);
    assert.notEqual(recovery.compensation.key,grant.compensation.key);
    await assert.rejects(operations.recoverCompensation(oldAttempt,cfg.auth),{code:'FK_I_OPERATION_CONFLICT'});
    await assert.rejects(operations.settleCompensation(oldAttempt,cfg.auth),{code:'FK_I_OPERATION_CONFLICT'});
    assert.equal(external.prepare('DELETE FROM effects WHERE key=?').run(alt.operationKey).changes,1);
    await operations.settleCompensation({...compensation,compensationKey:recovery.compensation.key,
      evidenceHash:sha256Bytes(Buffer.from('released alternate reservation'))},cfg.auth);
    const terminal=await resume(frame.runId,{},cfg);
    assert.equal(terminal.status,'succeeded');
    assert.deepEqual(terminal.cancelledRequests,[loser.requestId]);
    assert.deepEqual((await cfg.auth.readTerminalResult(terminal.resultRef,cfg)).state,{baseline:true,winner:'selected'});
    assert.deepEqual(external.prepare('SELECT value FROM effects').all().map(row=>row.value),['selected']);
  } finally {external.close();}
});

test('R5 uses the same persisted envelope in SQLite and the asynchronous Store',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello',secret:'private'},f.options);
  assert.equal(waiting.protocolVersion,1);
  assert.equal(waiting.pending.length,1);
  assert.deepEqual(waiting.pending[0].task.input,{message:'hello'});
  assert.equal(waiting.pending[0].activation,1);
  assert.ok(!JSON.stringify(waiting).includes('private'));
  const idem=await start(f.program,runtime,{message:'hello',secret:'private'},f.options);
  assert.deepEqual(idem,waiting);
  await assert.rejects(start(f.program,runtime,{message:'hello',secret:'private'},
    {...f.options,auth:context({authorize:({action})=>action==='run:create'})}),{code:'FK_I_HOST_DENIED'});
  const envelope=await f.options.store.load(waiting.runId);
  const db=new DatabaseSync(f.file,{readOnly:true});
  try {
    const row=db.prepare('SELECT checkpoint_json,checkpoint_hash FROM fk_i_runs WHERE run_id=?').get(waiting.runId);
    assert.deepEqual(JSON.parse(row.checkpoint_json),envelope);
    assert.equal(row.checkpoint_hash,sha256Bytes(canonicalBytes(envelope)));
    assert.equal(envelope.execution.phase,'awaiting');
    assert.equal(envelope.pending[0].issuedRevision,waiting.revision);
    assert.equal(envelope.policyIdentity.id,policy.id);
    assert.equal(envelope.program.artifactHash,f.program.artifactHash);
    assert.equal(Object.hasOwn(envelope,'artifactHash'),false);
  } finally {db.close();}
  await assert.rejects(start(f.program,runtime,{message:'changed'},f.options),{code:'FK_I_START_CONFLICT'});
  const denied={...f.options,auth:context({authorize:({action})=>action!=='run:complete'})};
  await assert.rejects(complete(submission(waiting),runtime,denied),{code:'FK_I_HOST_DENIED'});
  const forged={...f.options,auth:{...f.options.auth}};
  await assert.rejects(resume(waiting.runId,runtime,forged),{code:'FK_I_HOST_DENIED'});
  await assert.rejects(resume(waiting.runId,runtime,{...f.options,auth:context({authorizeTask:()=>false})}),
    {code:'FK_I_HOST_DENIED'});
  const final=await complete(submission(waiting),runtime,f.options);
  assert.equal(final.status,'succeeded');
  assert.deepEqual(final.pending,[]);
  assert.deepEqual(final.resultRef,{runId:final.runId,revision:final.revision,projectionVersion:1});
  assert.equal(Object.hasOwn(final,'state'),false);
  const privateResult=await f.options.auth.readTerminalResult(final.resultRef,f.options);
  assert.equal(privateResult.state.secret,'private');
  await assert.rejects(context({authorize:({action})=>action!=='result:read'})
    .readTerminalResult(final.resultRef,f.options),{code:'FK_I_HOST_DENIED'});
  const journal=f.raw.listJournal(final.runId);
  for(const row of journal) {
    const transition=await f.options.store.loadTransition(final.runId,row.transitionId);
    assert.equal(transition.transitionId,sha256Bytes(canonicalBytes([
      ns,final.runId,transition.fromRevision,transition.fromBlockId,transition.eventDigest,
      transition.programHash,transition.proposalDigest,
    ])));
  }
  const receipt=await f.options.store.loadReceipt(final.runId,waiting.pending[0].requestId);
  assert.equal(receipt.submissionDigest,sha256Bytes(canonicalBytes(submission(waiting))));
  assert.equal(receipt.acceptedRevision,final.acknowledgement.acceptedRevision);
  assert.equal((await f.options.store.loadTransition(final.runId,receipt.transitionId)).toRevision,receipt.acceptedRevision);
  const wrongTenant=createSqliteInteractivePersistence(f.file,{namespace:'other'});
  try {
    assert.equal(await wrongTenant.store.load(final.runId),null);
    assert.equal(await wrongTenant.store.loadReceipt(final.runId,waiting.pending[0].requestId),null);
    assert.equal(await wrongTenant.store.loadTransition(final.runId,receipt.transitionId),null);
  } finally {wrongTenant.close();}
  await assert.rejects(f.options.programRegistry.release(final.runId,f.program.artifactHash),{code:'FK_I_ARTIFACT_IN_USE'});
});

test('R5 CAS recovers from a lost response only with durable transition evidence',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello'},f.options);
  let lose=true, recoveredId;
  const dropping={...f.options.store,
    async compareAndSwap(runId,revision,tx) {
      const result=await f.options.store.compareAndSwap(runId,revision,tx);
      if(lose && tx.receipt && result.committed) {
        lose=false;
        recoveredId=tx.transition.transitionId;
        throw new Error('lost response');
      }
      return result;
    },
  };
  const result=await complete(submission(waiting),runtime,{...f.options,store:dropping});
  assert.equal(result.status,'succeeded');
  assert.equal((await f.options.store.loadTransition(result.runId,recoveredId)).toRevision,
    result.acknowledgement.acceptedRevision);
  const before=f.raw.listJournal(result.runId);
  const replay=await complete(submission(waiting),runtime,f.options);
  assert.equal(replay.acknowledgement.repeated,true);
  assert.deepEqual(f.raw.listJournal(result.runId),before);

  const second=await start(f.program,runtime,{message:'again'},{...f.options,startKey:'uncertain'});
  const stale=await f.options.store.load(second.runId);
  let attempted=0;
  const unusable={...f.options.store,
    async load(){return stale;},
    async compareAndSwap(){attempted++;throw new Error('database unavailable');},
    async loadTransition(){return null;},
  };
  await assert.rejects(complete(submission(second),runtime,{...f.options,store:unusable}),
    {code:'FK_I_STORE_UNCERTAIN'});
  assert.equal(attempted,1);
  assert.deepEqual(await f.options.store.load(second.runId),stale);
});

test('R5 errored result reads return the persisted cause without changing execution data',async t=>{
  for(const [name,bindings,result,causeCode] of [
    ['validator-contract',{...runtime,validateResult:{...runtime.validateResult,
      implementation(){throw new Error('fixed local validator error');}}},{answer:'yes'},'FK_I_VALIDATOR_CONTRACT'],
    ['retry-exhaustion',runtime,{answer:37},'FK_R004'],
  ]) await t.test(name,async t=>{
    const f=await fixture(t);
    const waiting=await start(f.program,bindings,{message:'hello',secret:'private'},f.options);
    const final=await complete(submission(waiting,result),bindings,f.options);
    assert.equal(final.status,'errored');
    const checkpoint=await f.options.store.load(final.runId);
    assert.equal(checkpoint.terminal,null);
    assert.equal(checkpoint.causeCode,causeCode);
    const journal=f.raw.listJournal(final.runId);
    const receipt=await f.options.store.loadReceipt(final.runId,waiting.pending[0].requestId);
    const denied=context({authorize:({action})=>action!=='result:read'});
    await assert.rejects(denied.readTerminalResult(final.resultRef,f.options),{code:'FK_I_HOST_DENIED'});
    await assert.rejects(f.options.auth.readTerminalResult({...final.resultRef,revision:final.revision+1},f.options),
      {code:'FK_I_HOST_DENIED'});
    const expected={projectionVersion:1,namespace:ns,runId:final.runId,status:'errored',
      state:{message:'hello',secret:'private'},contextError:null,causeCode};
    assert.deepEqual(await f.options.auth.readTerminalResult(final.resultRef,f.options),expected);
    const reopened=createSqliteInteractivePersistence(f.file,{namespace:ns});
    try {
      const auth=context();
      assert.deepEqual(await auth.readTerminalResult(final.resultRef,{...f.options,...reopened,auth}),expected);
    } finally {reopened.close();}
    assert.deepEqual(await f.options.store.load(final.runId),checkpoint);
    assert.deepEqual(f.raw.listJournal(final.runId),journal);
    assert.deepEqual(await f.options.store.loadReceipt(final.runId,waiting.pending[0].requestId),receipt);
  });
});

test('R5 result reads preserve business-failed and cancelled shapes without a cause',async t=>{
  for(const status of ['failed','cancelled']) await t.test(status,async t=>{
    const f=await fixture(t);
    let final;
    if(status==='failed') {
      const file=path.join(f.dir,'failed.workflow.js');
      await writeFile(file,bare.replace("status:'succeeded'","status:'failed'"));
      final=await start(file,{}, {secret:'private'},{...f.options,policy:{...policy,bindingManifest:{}}});
    } else {
      const waiting=await start(f.program,runtime,{secret:'private'},f.options);
      const admin=createInteractiveAdminContext({namespace:ns,subjectId:'ops',authorize:()=>true});
      final=await f.persistence.adminController.adminTerminate(waiting.runId,'OPERATOR',admin);
    }
    assert.equal(final.status,status);
    const opts=status==='failed'?{...f.options,policy:{...policy,bindingManifest:{}}}:f.options;
    const result=await opts.auth.readTerminalResult(final.resultRef,opts);
    assert.equal(result.status,status);
    assert.deepEqual(result.state,{secret:'private'});
    assert.equal(Object.hasOwn(result,'causeCode'),false);
    if(status==='failed') assert.deepEqual(result.terminal,{nodeId:'done',status:'failed'});
    else assert.equal(Object.hasOwn(result,'terminal'),false);
  });
});

test('R5 file source works without Agent bindings and honors pre-aborted operations',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'terminal.workflow.js');
  await writeFile(file,bare);
  const opts={...f.options,policy:{...policy,bindingManifest:{}},startKey:'pure'};
  await assert.rejects(start(file,{}, {},{...opts,signal:AbortSignal.abort()}),{name:'AbortError'});
  const result=await start(file,{}, {secret:'private'},opts);
  assert.equal(result.status,'succeeded');
  assert.equal(Object.hasOwn(result,'state'),false);
  assert.equal(result.terminal.nodeId,'done');
});

test('S12-A creates its audit table in a fresh R5 database and atomically terminates without the Program',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello'},f.options);
  const before=f.raw.load(waiting.runId);
  const journal=f.raw.listJournal(waiting.runId);
  const admin=createInteractiveAdminContext({namespace:ns,subjectId:'ops-1',authorize:()=>true});
  const persisted=f.persistence;
  {
    const db=new DatabaseSync(f.file);
    const audit=()=>db.prepare('SELECT * FROM fk_i_admin_events').all();
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',{...admin}),
        {code:'FK_I_HOST_DENIED'});
      const other=createInteractiveAdminContext({namespace:'another',subjectId:'ops-1',authorize:()=>true});
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',other),{code:'FK_I_HOST_DENIED'});
      assert.deepEqual(audit(),[]);
      db.exec(`CREATE TRIGGER force_audit_failure BEFORE INSERT ON fk_i_admin_events
        BEGIN SELECT RAISE(ABORT,'audit fixture failure'); END`);
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',admin),/audit fixture failure/);
      assert.deepEqual(f.raw.load(waiting.runId),before);
      assert.deepEqual(f.raw.listJournal(waiting.runId),journal);
      assert.deepEqual(audit(),[]);
      db.exec('DROP TRIGGER force_audit_failure');
      // A deliberately broken test fixture models an unavailable artifact.
      // The management action must not open or verify Program bytes.
      db.prepare('UPDATE fk_i_artifacts SET program_bytes=? WHERE namespace=? AND artifact_hash=?')
        .run(Buffer.from('unavailable'),ns,before.artifactHash);
      const result=await persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',admin);
      assert.equal(result.status,'cancelled');
      assert.equal(result.revision,before.revision+1);
      assert.deepEqual(result.pending,[]);
      assert.equal(Object.hasOwn(result,'state'),false);
      const opts={...f.options,...persisted};
      assert.deepEqual(await resume(waiting.runId,runtime,opts),result);
      await assert.rejects(complete(submission(waiting),runtime,opts),{code:'FK_I_STALE_RECEIPT'});
      assert.deepEqual(await persisted.adminController.adminTerminate(waiting.runId,'REPEATED',admin),result);
      const [record]=audit();
      assert.equal(record.admin_subject_id,'ops-1');
      assert.equal(record.reason_code,'OPERATOR');
      assert.equal((await persisted.store.loadTransition(waiting.runId,record.transition_id)).toRevision,result.revision);
      assert.equal(audit().length,1);
    } finally {db.close();}
  }
});

test('S12-A terminal completion and management termination have a single final transition',async t=>{
  const f=await fixture(t);
  const migrated=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const opts={...f.options,...migrated};
    const waiting=await start(f.program,runtime,{message:'hello'},opts);
    let entered;
    const gate=new Promise(resolve=>{entered=resolve;});
    let release;
    const hold=new Promise(resolve=>{release=resolve;});
    const controlled={...opts,store:{...opts.store,async compareAndSwap(runId,revision,tx) {
      if (tx.next.status==='succeeded') {
        entered();
        await hold;
      }
      return opts.store.compareAndSwap(runId,revision,tx);
    }}};
    const completing=complete(submission(waiting),runtime,controlled);
    await Promise.race([gate,completing.then(()=>assert.fail('terminal barrier not reached'))]);
    try {
      const admin=createInteractiveAdminContext({namespace:ns,subjectId:'ops-1',authorize:()=>true});
      const ended=await migrated.adminController.adminTerminate(waiting.runId,'OPERATOR',admin);
      assert.equal(ended.status,'cancelled');
      release();
      assert.equal((await completing).status,'cancelled');
      assert.equal(f.raw.listJournal(waiting.runId).at(-1).entry.kind,'admin-terminate');
      assert.equal(f.raw.listJournal(waiting.runId).filter(row=>row.entry.kind==='admin-terminate').length,1);
      const another=await start(f.program,runtime,{message:'hello'},{...opts,startKey:'completion-first'});
      const completed=await complete(submission(another),runtime,opts);
      const before=f.raw.listJournal(another.runId);
      assert.equal((await migrated.adminController.adminTerminate(another.runId,'OPERATOR',admin)).status,'succeeded');
      assert.equal(completed.revision,before.at(-1).revision);
      assert.deepEqual(f.raw.listJournal(another.runId),before);
    } finally {release(); await completing.catch(()=>{});}
  } finally {migrated.close();}
});
