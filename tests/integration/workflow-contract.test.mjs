import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileArtifact,evalWhen,run,runArtifact,isControlSignal} from '../../src/index.mjs';
import {cancelInteractiveRun,compileInteractive,complete,createInteractiveHostContext,createSqliteInteractivePersistence,loadInteractiveProgram,resume,start} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const source=`import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'job',name:'Job',version:'1.0.0',contract:{
  input:{type:'object',properties:{intent:{type:'string',minLength:1}},required:['intent']},
  output:{type:'object',properties:{receipt:{type:'string',minLength:1}},required:['receipt']}
},nodes:[terminal('done',{name:'Done',status:'succeeded'})]});`;

test('the same root contract validates Standard source, exact artifact bytes and a persisted Interactive run',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-root-contract-'));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'job.workflow.js');
  const delivery=path.join(dir,'workflow.js');
  await writeFile(filename,source);
  const artifact=await compileArtifact(filename);
  assert.deepEqual(artifact.diagnostics,[]);
  await writeFile(delivery,artifact.code);
  const initial={intent:'file',receipt:'evidence',secret:'internal-state'};
  const expected={receipt:'evidence'};
  const runtime={isControlSignal};
  for (const execute of [state=>run(filename,runtime,state),
    state=>runArtifact(delivery,artifact.artifactHash,runtime,state)]) {
    await assert.rejects(execute({intent:''}),{code:'FK_R008'});
    await assert.rejects(execute({intent:'file'}),{code:'FK_R009'});
    assert.deepEqual((await execute(initial)).publicOutput,expected);
    await assert.rejects(execute({get intent(){throw new Error('accessor must not run');}}),{code:'FK_R008'});
  }

  const namespace='root-contract';
  const db=path.join(dir,'checkpoint.sqlite');
  const {graphSnapshot}=await compileInteractive(filename,{output:'memory',featureStage:'P2'});
  assert.equal(Object.isFrozen(graphSnapshot),true);
  assert.equal(Object.isFrozen(graphSnapshot.nodes[0]),true);
  assert.equal(Object.isFrozen(graphSnapshot.contract.output.properties),true);
  let viewerAllowed=true;
  let outputAllowed=true;
  const auth=createInteractiveHostContext({namespace,subjectId:'test-host',authorizeTask:()=>true,
    authorize:({action,graphDigest})=>!action.startsWith('viewer:') ||
      (viewerAllowed&&graphDigest===graphSnapshot.graphDigest&&(action!=='viewer:output'||outputAllowed))});
  const policy={id:'root-test',version:'1',disclosePolicyId:'empty',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const persistence=createSqliteInteractivePersistence(db,{namespace});
  let success;
  try {
    const options={...persistence,auth,policy,startKey:'job'};
    await assert.rejects(start(filename,{}, {intent:''},options),{code:'FK_R008'});
    success=await start(filename,{},initial,options);
    assert.equal(success.status,'succeeded');
    const cp=await options.store.load(success.runId);
    assert.deepEqual(cp.publicOutput,expected);
    assert.match(cp.outputContractDigest,/^sha256:[0-9a-f]{64}$/);
    const invalid=await start(filename,{}, {intent:'file'}, {...options,startKey:'missing-output'});
    assert.equal(invalid.status,'errored');
    assert.equal((await options.store.load(invalid.runId)).publicOutput,undefined);
    assert.equal((await auth.readTerminalResult(invalid.resultRef,options)).causeCode,'FK_R009');
  } finally {persistence.close();}
  const reopened=createSqliteInteractivePersistence(db,{namespace});
  try {
    const options={...reopened,auth,policy};
    const recovered=await resume(success.runId,{},options);
    assert.equal(recovered.revision,success.revision);
    assert.deepEqual((await auth.readTerminalResult(recovered.resultRef,options)).publicOutput,expected);
    const viewOptions={...options,graphSnapshot};
    const ref={namespace,runId:recovered.runId,artifactHash:graphSnapshot.artifactHash,graphDigest:graphSnapshot.graphDigest};
    assert.equal(artifact.graphSnapshot.sourceHash,graphSnapshot.sourceHash);
    assert.notEqual(artifact.graphSnapshot.artifactHash,graphSnapshot.artifactHash);
    assert.notEqual(artifact.graphSnapshot.graphDigest,graphSnapshot.graphDigest);
    await assert.rejects(auth.readRunView({...ref,graphDigest:artifact.graphSnapshot.graphDigest},
      {...viewOptions,graphSnapshot:artifact.graphSnapshot}),{code:'FK_I_HOST_DENIED'});
    await assert.rejects(auth.readRunView(ref,{...viewOptions,graphSnapshot:artifact.graphSnapshot}),
      {code:'FK_I_PROGRAM_MISMATCH'});
    const view=await auth.readRunView(ref,viewOptions);
    assert.deepEqual(view.publicOutput,expected);
    assert.equal(Object.hasOwn(view,'state'),false);
    assert.equal(JSON.stringify(view).includes(initial.secret),false);
    const {graphDigest:originalDigest,...forged}=structuredClone(graphSnapshot);
    forged.nodes[0].name='Different graph for the same Program';
    const forgedDigest=sha256Bytes(canonicalBytes(forged));
    assert.notEqual(forgedDigest,originalDigest);
    const permissive=createInteractiveHostContext({namespace,subjectId:'authorized-viewer',
      authorize:()=>true,authorizeTask:()=>true});
    await assert.rejects(permissive.readRunView({...ref,graphDigest:forgedDigest},
      {...viewOptions,auth:permissive,graphSnapshot:{...forged,graphDigest:forgedDigest}}),{code:'FK_I_PROGRAM_MISMATCH'});
    const first=await auth.listRunViewEvents({ref,limit:1},viewOptions);
    assert.equal(first.events[0].kind,'run.started');
    const rest=await auth.listRunViewEvents({ref,afterRevision:first.cursor},viewOptions);
    assert.equal(rest.events.at(-1).kind,'run.finished');
    assert.equal(rest.cursor,recovered.revision);
    assert.equal((await auth.listRunViewEvents({ref,afterRevision:rest.cursor},viewOptions)).events.length,0);
    outputAllowed=false;
    assert.equal(Object.hasOwn(await auth.readRunView(ref,viewOptions),'publicOutput'),false);
    viewerAllowed=false;
    await assert.rejects(auth.readRunView(ref,viewOptions),{code:'FK_I_HOST_DENIED'});
    await assert.rejects(auth.listRunViewEvents({ref},viewOptions),{code:'FK_I_HOST_DENIED'});
    assert.equal((await options.store.load(recovered.runId)).revision,recovered.revision);
  } finally {reopened.close();}
});

test('required input is checked before dispatch and a successful Action cannot bypass root output validation', async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-action-contract-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'dispatch.workflow.js');
  await writeFile(path.join(dir,'package.json'),'{}');
  await mkdir(path.join(dir,'skills'));
  await writeFile(path.join(dir,'skills','counter.md'),'Return the asset count as a number.');
  await writeFile(file,`import {defineWorkflow,node,action,condition,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'dispatch',name:'Dispatch',version:'1.0.0',contract:{
  input:{type:'object',properties:{request:{type:'object',additionalProperties:false,properties:{assets:{type:'array',minItems:1,items:{type:'integer'}}},required:['assets']}},required:['request']},
  output:{type:'object',properties:{count:{type:'integer',minimum:0}},required:['count']}
},nodes:[
  condition('route',{name:'Route',branches:[{when:'blocked === true',next:'blocked'},{when:'skip === true',next:'done'},{when:'true',next:'estimate'}]}),
  node('estimate',{name:'Estimate count',agent:'counter',output:{type:'object',properties:{count:{type:'integer'}},required:['count']},next:'count'}),
  action('count',{name:'Count assets',action:'count',writes:['count'],next:'done'}),
  terminal('done',{name:'Done',status:'succeeded'}),terminal('blocked',{name:'Blocked',status:'failed'})
]});`);
  const badInputs=[{}, {request:{}}, {request:{assets:[]}}, {request:{assets:['one']}}, {request:{assets:[1],extra:true}}];
  let calls=0;
  const validateResult=(_schema,result)=>Number.isInteger(result.count)?[]:['count must be an integer'];
  const runtime={isControlSignal,evalWhen,loadSkillByAgent:()=> 'Count assets',runAgent:()=>({count:1}),validateResult,
    runAction:(_id,_name,ctx)=>{calls++;assert.equal(ctx.state.count,1);ctx.state.count='wrong type';}};
  for(const invalid of badInputs) await assert.rejects(run(file,runtime,invalid),{code:'FK_R008'});
  assert.equal(calls,0);
  const initial={request:{assets:[1]},token:'host-only'};
  await assert.rejects(run(file,runtime,initial),{code:'FK_R009'});
  assert.equal(calls,1);
  await assert.rejects(run(file,runtime,{...initial,skip:true}),{code:'FK_R009'});
  const failed=await run(file,runtime,{...initial,blocked:true});
  assert.equal(failed.status,'failed');
  assert.equal(Object.hasOwn(failed,'publicOutput'),false);

  const namespace='dispatch-contract';
  const bindingManifest={skillResolver:{id:'counter',version:'1',mode:'trusted-read'},
    validateResult:{id:'counter-schema',version:'1',mode:'pure-local'}};
  const bindings={skillResolver:{...bindingManifest.skillResolver,implementation:()=> 'Count assets'},
    validateResult:{...bindingManifest.validateResult,implementation:validateResult}};
  const policy={id:namespace,version:'1',disclosePolicyId:'empty',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest};
  let disclosed=0;
  const auth=createInteractiveHostContext({namespace,subjectId:'contract',authorize:()=>true,authorizeTask:()=>{disclosed++;return true;}});
  const persistence=createSqliteInteractivePersistence(path.join(dir,'run.sqlite'),{namespace});
  try {
    const options={...persistence,auth,policy,startKey:'input'};
    for(const invalid of badInputs) await assert.rejects(start(file,bindings,invalid,options),{code:'FK_R008'});
    assert.equal(disclosed,0);
    const estimate=await start(file,bindings,initial,options);
    assert.equal(estimate.pending[0].nodeId,'estimate');
    const waiting=await complete({runId:estimate.runId,requestId:estimate.pending[0].requestId,kind:'agent',
      outcome:'succeeded',result:{count:1}},bindings,options);
    const [pending]=waiting.pending;
    assert.equal(pending.nodeId,'count');
    const {runId}=waiting;
    const {requestId,task:{operationKey}}=pending;
    const inputHash=sha256Bytes(canonicalBytes(pending.task));
    await options.operationController.claim({runId,requestId,operationKey,inputHash},auth);
    const result={set:{count:'wrong type'}};
    const bytes=canonicalBytes(result);
    await writeFile(path.join(dir,'count-receipt.json'),bytes);
    await options.operationController.settle({runId,operationKey,inputHash,effect:'applied',result,evidenceHash:sha256Bytes(bytes)},auth);
    const rejected=await complete({runId,requestId,operationKey,kind:'action',outcome:'succeeded',result},bindings,options);
    assert.equal(rejected.status,'errored');
    const failure=await auth.readTerminalResult(rejected.resultRef,options);
    assert.equal(failure.causeCode,'FK_R009');
    assert.equal(Object.hasOwn(failure,'publicOutput'),false);
    const skipped=await start(file,bindings,{...initial,skip:true},{...options,startKey:'skipped'});
    assert.equal((await auth.readTerminalResult(skipped.resultRef,options)).causeCode,'FK_R009');
    const blocked=await start(file,bindings, {...initial,blocked:true},{...options,startKey:'blocked'});
    assert.equal(blocked.status,'failed');
    assert.equal(Object.hasOwn(await auth.readTerminalResult(blocked.resultRef,options),'publicOutput'),false);
    const pendingRun=await start(file,bindings,initial,{...options,startKey:'cancelled'});
    const cancelled=await cancelInteractiveRun(pendingRun.runId,'OPERATOR_CANCEL',options);
    assert.equal(cancelled.status,'cancelled');
    assert.equal(Object.hasOwn(await auth.readTerminalResult(cancelled.resultRef,options),'publicOutput'),false);
  } finally {persistence.close();}
});

test('a lost terminal CAS response preserves the atomically projected output after SQLite reopen', async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-output-cas-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourceFile=path.join(dir,'job.workflow.js'),db=path.join(dir,'run.sqlite');
  await writeFile(sourceFile,source);
  const namespace='transactional-output';
  const auth=createInteractiveHostContext({namespace,subjectId:'contract',authorize:()=>true,authorizeTask:()=>true});
  const policy={id:namespace,version:'1',disclosePolicyId:'empty',capabilityStage:'P0-A',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const open=()=>createSqliteInteractivePersistence(db,{namespace});
  const connection=open();
  let recovered, lostTransition;
  try {
    const store={...connection.store,async compareAndSwap(runId,revision,tx) {
      const saved=await connection.store.compareAndSwap(runId,revision,tx);
      if(saved.committed&&tx.next.status==='succeeded') {
        lostTransition=tx.transition;
        throw new Error('Response lost after committing the terminal output');
      }
      return saved;
    }};
    recovered=await start(sourceFile,{}, {intent:'file',receipt:'committed',private:'never public'},
      {...connection,auth,policy,startKey:'commit',store});
    assert.equal(recovered.status,'succeeded');
    assert.equal(lostTransition?.toRevision,recovered.revision);
  } finally {connection.close();}
  const reopened=open();
  try {
    const options={...reopened,auth,policy};
    assert.deepEqual(await resume(recovered.runId,{},options),recovered);
    assert.deepEqual((await auth.readTerminalResult(recovered.resultRef,options)).publicOutput,{receipt:'committed'});
    assert.deepEqual(await reopened.store.loadTransition(recovered.runId,lostTransition.transitionId),lostTransition);
  } finally {reopened.close();}
});

test('the compiled Program rejects missing or substituted validators and the DSL rejects dynamic output keys', async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-root-validator-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'validator.workflow.js');
  await writeFile(file,source);
  const compiled=await compileInteractive(file,{output:'memory',featureStage:'P2'});
  assert.deepEqual(compiled.diagnostics,[]);
  const validator='"validator":"flowkit-json-schema-object-v1",';
  for(const replacement of ['', '"validator":"untrusted-validator",']) {
    const tampered=compiled.code.replace(validator,replacement);
    assert.notEqual(tampered,compiled.code);
    const bytes=Buffer.from(tampered);
    await assert.rejects(loadInteractiveProgram(bytes,sha256Bytes(bytes)),/invalid ProgramTable/);
  }
  for(const dynamic of ["patternProperties:{'.*':{type:'string'}}", "$ref:'https://example.invalid/output'", 'anyOf:[]']) {
    await writeFile(file,source.replace("output:{type:'object'",`output:{${dynamic},type:'object'`));
    const standard=await compileArtifact(file);
    const interactive=await compileInteractive(file,{output:'memory',featureStage:'P2'});
    for(const result of [standard,interactive]) {
      assert.equal(result.code,'');
      assert.ok(result.diagnostics.some(item=>item.code==='FK_C008'));
    }
  }
});

test('GraphSnapshot distinguishes root input and may-writes and omits undeclared verifier dependencies', async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-reachable-inputs-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'provenance.workflow.js');
  await writeFile(file,`import {defineWorkflow,action,condition,human,verification,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'provenance',name:'Provenance',version:'1.0.0',contract:{input:{type:'object',
  properties:{request:{type:'string'}},required:['request']}},nodes:[
  human('review',{name:'Review',onApprove:'choice',onReject:'review',onDecline:'blocked',maxRevisions:1}),
  condition('choice',{name:'Choose',branches:[{when:'useDraft === true',next:'write-draft'},{when:'true',next:'read'}]}),
  action('write-draft',{name:'Write draft',action:'write',writes:['draft'],next:'read'}),
  action('read',{name:'Read',action:'read',effect:'read-only',reads:['request','draft','host-only','review'],next:'check'}),
  verification('check',{name:'Check',verifier:'check',onSuccess:'done',onFailure:'blocked'}),
  terminal('done',{name:'Done',status:'succeeded'}),terminal('blocked',{name:'Blocked',status:'failed'})
]});`);
  const {graphSnapshot,diagnostics}=await compileInteractive(file,{output:'memory',featureStage:'P2'});
  assert.deepEqual(diagnostics,[]);
  assert.deepEqual(graphSnapshot.nodes.find(node=>node.id==='read').inputs,[
    {key:'request',source:'declared'},{key:'draft',source:'conditional'},{key:'host-only',source:'unknown'},
    {key:'review',source:'inferred'},
  ]);
  assert.deepEqual(graphSnapshot.nodes.find(node=>node.id==='check').inputs,[]);
  assert.deepEqual(graphSnapshot.nodes.find(node=>node.id==='review').inputs,[]);
});
