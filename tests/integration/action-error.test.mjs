import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileArtifact} from '../../src/index.mjs';
import {compileInteractive,complete,createInteractiveHostContext,createSqliteInteractivePersistence,resume,start} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const source=`import {defineWorkflow,action,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'canary',name:'Canary rollout',version:'1.0.0',nodes:[
  action('deploy-canary',{name:'Deploy canary',action:'deploy',next:'collect-canary-metrics',onError:'rollback-release'}),
  action('collect-canary-metrics',{name:'Collect metrics',action:'collect',effect:'read-only',next:'ready'}),
  action('rollback-release',{name:'Prepare rollback',action:'prepare',effect:'read-only',next:'check-rollback-eligibility'}),
  verification('check-rollback-eligibility',{name:'Check eligibility',verifier:'eligibility',onSuccess:'restore-previous-release',onFailure:'blocked'}),
  action('restore-previous-release',{name:'Restore previous version',action:'restore',next:'rolled-back'}),
  terminal('ready',{name:'Canary ready',status:'succeeded'}),
  terminal('blocked',{name:'Rollback blocked',status:'failed'}),
  terminal('rolled-back',{name:'Rolled back',status:'failed'}),
]});`;

test('explicit Action onError uses a settled executor failure and keeps rollback separately authorized', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-action-error-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'canary.workflow.js');
  await writeFile(file,source);
  const p2=()=>compileInteractive(file,{output:'memory',featureStage:'P2'});
  const compiled=await p2();
  assert.deepEqual(compiled.diagnostics,[]);
  assert.ok(compiled.graphSnapshot.referenceEdges.some(edge=>edge.from==='deploy-canary'
    && edge.to==='rollback-release' && edge.role==='action-error' && edge.origin==='declared'));
  assert.ok(compiled.graphSnapshot.executionEdges.some(edge=>edge.from==='deploy-canary'
    && edge.to==='collect-canary-metrics' && edge.role==='next'));
  assert.equal(compiled.graphSnapshot.executionEdges.some(edge => edge.from === 'rollback-release' && edge.to === 'blocked'), false);
  await writeFile(file, source.replaceAll(",effect:'read-only'", ''));
  assert.deepEqual((await compileArtifact(file)).diagnostics, []);
  await writeFile(file,source.replace("onError:'rollback-release'","onError:'collect-canary-metrics'"));
  assert.ok((await p2()).diagnostics.some(item=>item.code==='FK_C007'));
  await writeFile(file,source);

  const namespace='isolated-canary';
  const policy={id:namespace,version:'1',disclosePolicyId:'empty',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const auth=createInteractiveHostContext({namespace,subjectId:'owner',authorize:()=>true,authorizeTask:()=>true});
  const denied=createInteractiveHostContext({namespace,subjectId:'observer',authorize:()=>true,
    authorizeTask:({nodeId})=>nodeId!=='restore-previous-release'});
  const db=path.join(dir,'run.sqlite');
  const open=()=>({...createSqliteInteractivePersistence(db,{namespace}),auth,policy});
  let options=open();
  const launch=startKey=>start(file,{}, {},{...options,startKey});
  const normalize=(frame,expected)=>{
    const [pending]=frame.pending;
    assert.equal(pending.nodeId,expected);
    return {runId:frame.runId,requestId:pending.requestId,operationKey:pending.task.operationKey,kind:'action'};
  };
  async function claim(frame,nodeId) {
    const {kind,...submission}=normalize(frame,nodeId);
    const sealed={...submission,inputHash:sha256Bytes(canonicalBytes(frame.pending[0].task))};
    const granted=await options.operationController.claim(sealed,auth);
    assert.equal(granted.claimed,true);
    const {runId,operationKey,inputHash}=sealed;
    return {submission:{...submission,kind},operation:{runId,operationKey,inputHash},readOnly:granted.readOnly===true};
  }
  const success={set:{}};
  const technical={code:'CANARY_CHECK_FAILED',message:'Canary post-write validation failed',origin:'executor',sideEffectStatus:'known'};
  const target=path.join(dir,'canary-target');
  await writeFile(target,'stable');
  const targetHash=async()=>sha256Bytes(await readFile(target));
  async function finish(frame,nodeId,apply,selected=auth) {
    const {submission,operation,readOnly}=await claim(frame,nodeId);
    if (apply) assert.equal(readOnly,false);
    if (apply) await apply();
    await options.operationController.settle({...operation,effect:readOnly?'no-effect':'applied',result:success,evidenceHash:await targetHash()},auth);
    return complete({...submission,outcome:'succeeded',result:success},{},{...options,auth:selected});
  }
  try {
    const failed=await launch('settled');
    const {submission,operation}=await claim(failed,'deploy-canary');
    const failure={...submission,outcome:'failed',error:technical};
    await writeFile(target,'stable and canary');
    await assert.rejects(complete(failure,{},options),{code:'FK_I_INVALID_OPERATION'});
    await assert.rejects(complete({...failure,error:{...technical,sideEffectStatus:'unknown'}},{},options),
      {code:'FK_I_INVALID_OPERATION'});
    options.close();
    options=open();
    assert.equal((await resume(failed.runId,{},options)).pending[0].requestId,submission.requestId);
    await options.operationController.settle({...operation,effect:'applied',result:technical,evidenceHash:await targetHash()},auth);
    const rollback=await complete(failure,{},options);
    assert.equal(rollback.pending[0].task.contextError.code,technical.code);
    const eligibility=await finish(rollback,'rollback-release');
    assert.equal(await readFile(target,'utf8'),'stable and canary');
    const eligible=await complete({runId:eligibility.runId,requestId:eligibility.pending[0].requestId,kind:'verification',
      outcome:'succeeded',result:{passed:(await readFile(target,'utf8'))==='stable and canary'}},{},options);
    const restore=normalize(eligible,'restore-previous-release');
    await assert.rejects(options.operationController.claim({runId:restore.runId,requestId:restore.requestId,
      operationKey:restore.operationKey,inputHash:sha256Bytes(canonicalBytes(eligible.pending[0].task))},denied),
      {code:'FK_I_HOST_DENIED'});
    assert.equal(await readFile(target,'utf8'),'stable and canary');
    const restored=await finish(eligible,'restore-previous-release',()=>writeFile(target,'stable'));
    assert.equal(restored.terminal.nodeId,'rolled-back');
    assert.equal(await readFile(target,'utf8'),'stable');

    const normal=await finish(await launch('normal'),'deploy-canary');
    assert.equal(normal.pending[0].nodeId,'collect-canary-metrics');
    const skipped=normalize(await launch('not-dispatched'),'deploy-canary');
    const notDispatched={code:'FK_I_ACTION_NOT_DISPATCHED',message:'Execution never started',origin:'executor',sideEffectStatus:'none'};
    assert.equal((await complete({...skipped,outcome:'failed',error:notDispatched},{},options)).status,'errored');

    for (const error of [
      {...technical,code:'ACCESS_DENIED',origin:'policy',sideEffectStatus:'none'},
      {...technical,code:'FK_I_HOST_DENIED',sideEffectStatus:'none'},
      {...technical,sideEffectStatus:'none'},
    ]) {
      const {submission,operation}=await claim(await launch(error.code),'deploy-canary');
      await options.operationController.settle({...operation,effect:'no-effect',result:error,evidenceHash:await targetHash()},auth);
      const frame=await complete({...submission,outcome:'failed',error},{},options);
      if (error.code===technical.code) {
        const {submission,operation}=await claim(frame,'rollback-release');
        const prepareFailure={...error,code:'ROLLBACK_PREPARE_FAILED',message:'Rollback preparation failed before writing'};
        await assert.rejects(complete({...submission,outcome:'failed',error:prepareFailure},{},options),{code:'FK_I_INVALID_OPERATION'});
        await options.operationController.settle({...operation,effect:'no-effect',result:prepareFailure,evidenceHash:await targetHash()},auth);
        const blocked=await complete({...submission,outcome:'failed',error:prepareFailure},{},options);
        assert.equal(blocked.status,'errored');
        assert.deepEqual(blocked.pending,[]);
      } else {
        assert.equal(frame.status,'errored');
        assert.deepEqual(frame.pending,[]);
      }
    }
  } finally {options.close();}
});
