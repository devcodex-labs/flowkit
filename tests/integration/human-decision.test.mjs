import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileArtifact,evalWhen,isControlSignal,run} from '../../src/index.mjs';
import {compileInteractive,complete,createInteractiveHostContext,createSqliteInteractivePersistence,resume,start} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const source=`import {defineWorkflow,human,verification,condition,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'deliberation',name:'Deliberation',version:'1.0.0',nodes:[
  human('review',{name:'Review',onApprove:'done',onReject:'verify',onDecline:'blocked',maxRevisions:1}),
  verification('verify',{name:'Verify changes',verifier:'revision-check',onSuccess:'choose',onFailure:'review'}),
  condition('choose',{name:'Return to reviewer',branches:[{when:'true',next:'review'}]}),
  terminal('done',{name:'Done',status:'succeeded'}),
  terminal('blocked',{name:'Blocked',status:'failed'})
]});`;

test('three Human decisions select separate routes and bounded multi-step repair in both engines',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-human-decision-'));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'review.workflow.js');
  await writeFile(filename,source);
  const compiled=await compileArtifact(filename);
  assert.deepEqual(compiled.diagnostics,[]);
  assert.ok(compiled.graphSnapshot.executionEdges.some(({role})=>role==='human-decline'));
  for (const [decisions,status,expectedCalls] of [
    [['revise','approve'],'succeeded',1],[['decline'],'failed',0],[['revise','revise'],'failed',1],
  ]) {
    const queue=[...decisions];
    let calls=0;
    const result=await run(filename,{isControlSignal,evalWhen,
      runHuman:()=>({decision:queue.shift()}),runVerification:()=>{calls++;return true;}});
    assert.equal(result.status,status);
    assert.equal(calls,expectedCalls);
    assert.deepEqual(result.state.review,{decision:decisions.at(-1),comment:null});
    assert.equal(result.error?.code,decisions.at(-1)==='revise'?'FK_R004':undefined);
  }
  await assert.rejects(run(filename,{isControlSignal,evalWhen,runHuman:()=>({approved:false})}),{code:'FK_R002'});

  const namespace='decisions',db=path.join(dir,'human.sqlite');
  const policy={id:'decisions',version:'1',disclosePolicyId:'empty',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const auth=createInteractiveHostContext({namespace,subjectId:'reviewer',authorize:()=>true,authorizeTask:()=>true,
    authorizeHuman:({reviewDigest})=>({proofId:'authorized-review',evidenceHash:reviewDigest})});
  const submit=(current,decision,options,override={})=>{
    const pending=current.pending[0];
    return complete({kind:'human',runId:current.runId,requestId:pending.requestId,
      reviewDigest:pending.task.reviewDigest,outcome:'succeeded',result:{decision},...override},{},options);
  };
  const first=createSqliteInteractivePersistence(db,{namespace});
  let waiting;
  let digest;
  try {
    const options={...first,auth,policy,startKey:'return'};
    const initial=await start(filename,{},{},options);
    digest=initial.pending[0].task.reviewDigest;
    const checking=await submit(initial,'revise',options);
    assert.equal(checking.pending[0].nodeId,'verify');
    waiting=await complete({kind:'verification',runId:initial.runId,requestId:checking.pending[0].requestId,
      outcome:'succeeded',result:{passed:true}},{},options);
    assert.equal(waiting.pending[0].nodeId,'review');
    assert.notEqual(waiting.pending[0].task.reviewDigest,digest);
  } finally {first.close();}
  const reopened=createSqliteInteractivePersistence(db,{namespace});
  try {
    const options={...reopened,auth,policy,startKey:'decline'};
    const recovered=await resume(waiting.runId,{},options);
    await assert.rejects(submit(recovered,'approve',options,{reviewDigest:digest}),{code:'FK_I_STALE_RECEIPT'});
    const exhausted=await submit(recovered,'revise',options);
    assert.equal(exhausted.status,'failed');
    const result=await auth.readTerminalResult(exhausted.resultRef,options);
    assert.equal(result.contextError.code,'FK_R004');
    assert.equal(result.state.review.decision,'revise');
    const decline=await submit(await start(filename,{},{},options),'decline',options);
    assert.equal(decline.status,'failed');
    assert.equal((await auth.readTerminalResult(decline.resultRef,options)).contextError,null);
  } finally {reopened.close();}
});

test('first preparation and bounded revision share an entry and a failed verification blocks review', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-shared-review-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'requirements.workflow.js');
  const reviewSource = `import {defineWorkflow,action,condition,human,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'requirements-review',name:'Requirements review',version:'1.0.0',nodes:[
  condition('intake',{name:'Intake',branches:[{when:'skipPreparation',next:'review'},{when:'true',next:'prepare'}]}),
  action('prepare',{name:'Prepare requirements',action:'read-requirements',next:'check'}),
  verification('check',{name:'Check requirements',verifier:'check-requirements',onSuccess:'review',onFailure:'blocked'}),
  human('review',{name:'Review requirements',onApprove:'done',onReject:'prepare',onDecline:'blocked',maxRevisions:1}),
  terminal('done',{name:'Done',status:'succeeded'}),
  terminal('blocked',{name:'Blocked',status:'failed'})
]});`;
  await writeFile(file, reviewSource);
  for (const [checks, decisions, skipPreparation, status, expected] of [
    [[true,true], ['revise','approve'], false, 'succeeded', ['prepare','check','review','prepare','check','review']],
    [[false], [], false, 'failed', ['prepare','check']],
    [[false], ['revise'], true, 'failed', ['review','prepare','check']],
    [[], ['approve'], true, 'succeeded', ['review']],
  ]) {
    const calls = [];
    const result = await run(file, {isControlSignal, evalWhen,
      runAction: () => { calls.push('prepare'); },
      runVerification: () => { calls.push('check'); return checks.shift(); },
      runHuman: () => { calls.push('review'); return {decision:decisions.shift()}; },
    }, {skipPreparation});
    assert.equal(result.status, status);
    assert.deepEqual(calls, expected);
  }

  const p2Source = reviewSource.replace("action:'read-requirements',next:", "action:'read-requirements',effect:'read-only',reads:[],next:");
  const compileP2 = () => compileInteractive(file, {output:'memory', featureStage:'P2'});
  for (const [invalid, code] of [
    [p2Source.replace("when:'skipPreparation',next:'review'", "when:'skipPreparation',next:'check'"), 'FK_C060'],
    [p2Source.replace("onSuccess:'review'", "onSuccess:'blocked'"), 'FK_C061'],
    [p2Source.replace("onFailure:'blocked'", "onFailure:'done'"), 'FK_C061'],
  ]) {
    await writeFile(file, invalid);
    assert.ok((await compileP2()).diagnostics.some(item => item.code === code));
  }
  await writeFile(file, p2Source);
  const compiled = await compileP2();
  assert.deepEqual(compiled.diagnostics, []);
  assert.equal(compiled.graphSnapshot.artifactHash, compiled.programIdentity.artifactHash);
  assert.ok(compiled.graphSnapshot.executionEdges.some(edge =>
    edge.from === 'check' && edge.to === 'blocked' && edge.role === 'verification-failure'));

  const namespace = 'shared-review';
  const db = path.join(dir, 'reviews.sqlite');
  const requirement = path.join(dir, 'requirements.md');
  const policy = {id:'shared-review', version:'1', disclosePolicyId:'empty', capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1', bindingManifest:{}};
  const authorize = allowReview => createInteractiveHostContext({namespace, subjectId:'reviewer',
    authorize:() => true, authorizeTask:() => true,
    authorizeHuman:({reviewDigest}) => allowReview ? {proofId:'scope-bound-review', evidenceHash:reviewDigest} : false});
  const auth = authorize(true);
  async function checkRequirement(current, options) {
    const [pending] = current.pending;
    assert.equal(pending.nodeId, 'prepare');
    const {operationKey} = pending.task;
    const {runId} = current;
    const inputHash = sha256Bytes(canonicalBytes(pending.task));
    const claim = {runId, requestId:pending.requestId, operationKey, inputHash};
    assert.equal((await options.operationController.claim(claim, auth)).claimed, true);
    const bytes = await readFile(requirement);
    const result = {set:{}};
    await options.operationController.settle({runId, operationKey, inputHash, result,
      evidenceHash:sha256Bytes(bytes), effect:'no-effect'}, auth);
    const checking = await complete({runId, requestId:pending.requestId, operationKey, kind:'action',
      outcome:'succeeded', result}, {}, options);
    assert.equal(checking.pending[0].nodeId, 'check');
    return complete({runId, requestId:checking.pending[0].requestId, kind:'verification', outcome:'succeeded',
      result:{passed:bytes.includes('Acceptance criteria')}}, {}, options);
  }
  function submit(review, decision, options, reviewDigest = review.pending[0].task.reviewDigest) {
    return complete({runId:review.runId, requestId:review.pending[0].requestId, kind:'human',
      outcome:'succeeded', reviewDigest, result:{decision}}, {}, options);
  }
  const first = createSqliteInteractivePersistence(db, {namespace});
  let initialDigest, repairRun;
  try {
    const options = {...first, auth, policy, startKey:'prepare-and-revise'};
    await writeFile(requirement, '# Acceptance criteria\n');
    const initial = await checkRequirement(await start(file, {}, {skipPreparation:false}, options), options);
    assert.equal(initial.pending[0].nodeId, 'review');
    initialDigest = initial.pending[0].task.reviewDigest;
    await assert.rejects(submit(initial, 'approve', {...options, auth:authorize(false)}), {code:'FK_I_HOST_DENIED'});
    repairRun = await submit(initial, 'revise', options);
  } finally { first.close(); }
  const reopened = createSqliteInteractivePersistence(db, {namespace});
  try {
    const options = {...reopened, auth, policy, startKey:'fail-before-review'};
    await writeFile(requirement, '# Acceptance criteria\nRevised after the initial review.\n');
    const revised = await checkRequirement(await resume(repairRun.runId, {}, options), options);
    assert.notEqual(revised.pending[0].task.reviewDigest, initialDigest);
    await assert.rejects(submit(revised, 'approve', options, initialDigest), {code:'FK_I_STALE_RECEIPT'});
    assert.equal((await submit(revised, 'approve', options)).status, 'succeeded');
    await writeFile(requirement, '# Missing criteria\n');
    const blocked = await checkRequirement(await start(file, {}, {skipPreparation:false}, options), options);
    assert.equal(blocked.status, 'failed');
    assert.deepEqual(blocked.pending, []);
    assert.equal((await auth.readTerminalResult(blocked.resultRef, options)).contextError, null);
  } finally { reopened.close(); }
});
