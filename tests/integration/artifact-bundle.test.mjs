import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileInteractive,complete,createInteractiveHostContext,createSqliteInteractivePersistence,start} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {startLocalMcp} from '../../scripts/run-local-mcp.mjs';
import {readWorkflowPageData,workflowRunPage} from '../../scripts/workflow-viewer.mjs';
import {browserIdentity} from '../integrations/local-mcp-fixture.mjs';

test('an authorized bundle decision makes only its fixed version effective across a SQLite restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-bundle-'));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'artifact.workflow.js');
  await writeFile(filename,`import {defineWorkflow,action,human,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'artifact-review',name:'Artifact review',version:'1.0.0',nodes:[
action('first',{name:'Read first version',action:'read-file',effect:'read-only',reads:[],writes:[],next:'second'}),
action('second',{name:'Read second version',action:'read-file',effect:'read-only',reads:[],writes:[],next:'review'}),
human('review',{name:'Review versions',onApprove:'done',onReject:'repair',onDecline:'blocked',maxRevisions:1}),
action('repair',{name:'Recheck file',action:'read-file',effect:'read-only',reads:[],writes:[],next:'review'}),
terminal('done',{name:'Done',status:'succeeded'}),terminal('blocked',{name:'Blocked',status:'failed'})]});`);
  const {graphSnapshot}=await compileInteractive(filename,{output:'memory',featureStage:'P2'});
  const namespace='artifact-probe',db=path.join(dir,'checkpoint.sqlite');
  const policy={id:'artifact-probe',version:'1',disclosePolicyId:'empty',capabilityStage:'P2',requiredBundleReviews:['review'],
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const auth=createInteractiveHostContext({namespace,subjectId:'reviewer',authorize:()=>true,authorizeTask:()=>true,
    authorizeHuman:({bundle})=>({proofId:'approved-material',evidenceHash:bundle.bundleHash})});
  let ref,latest;
  const initial=createSqliteInteractivePersistence(db,{namespace});
  try {
    const options={...initial,auth,policy,startKey:'artifact-probe',graphSnapshot};
    let frame=await start(filename,{},{},options);
    ref={namespace,runId:frame.runId,artifactHash:graphSnapshot.artifactHash,graphDigest:graphSnapshot.graphDigest};
    const records=[];
    for(const number of [1,2]) {
      const pending=frame.pending[0];
      const storageRef=path.join(dir,`evidence-v${number}.txt`);
      await writeFile(storageRef,`Business evidence version ${number}`);
      const bytes=await readFile(storageRef);
      const contentHash=sha256Bytes(bytes);
      const op={runId:frame.runId,operationKey:pending.task.operationKey,inputHash:sha256Bytes(canonicalBytes(pending.task))};
      await initial.operationController.claim({...op,requestId:pending.requestId},auth);
      const result={set:{}};
      await initial.operationController.settle({...op,effect:'no-effect',evidenceHash:contentHash,result},auth);
      frame=await complete({kind:'action',runId:frame.runId,requestId:pending.requestId,operationKey:op.operationKey,
        outcome:'succeeded',result},{},options);
      records.push({runId:frame.runId,requestId:pending.requestId,artifactId:'evidence',contentHash,
        mimeType:'text/plain',sizeBytes:bytes.length,storageRef});
    }
    const review=frame.pending[0];
    const request={runId:frame.runId,requestId:review.requestId,reviewDigest:review.task.reviewDigest};
    const approval={...request,kind:'human',outcome:'succeeded',result:{decision:'approve'}};
    await assert.rejects(complete(approval,{},options),{code:'FK_I_STALE_RECEIPT'});
    const readOnly=createInteractiveHostContext({namespace,subjectId:'observer',authorizeTask:()=>true,
      authorize:({action})=>action==='viewer:artifacts'});
    await assert.rejects(initial.artifactController.registerVersion({...records[0],action:'viewer:artifacts'},readOnly),{code:'FK_I_HOST_DENIED'});
    const first=await initial.artifactController.registerVersion(records[0],auth);
    const expiresAt=Date.now()+120000;
    const previous=await initial.artifactController.freezeBundle({...request,versionIds:[first.versionId],expiresAt},auth);
    latest=await initial.artifactController.registerVersion(records[1],auth);
    await assert.rejects(complete({...approval,bundleHash:previous.bundleHash},{},options),{code:'FK_I_STALE_RECEIPT'});
    assert.equal((await readOnly.readRunArtifacts({ref},options)).items.at(-1).effectiveVersionId,null);
    const revised=await initial.artifactController.freezeBundle({...request,versionIds:[latest.versionId],expiresAt,
      expectedBundleHash:previous.bundleHash},auth);
    assert.notEqual(revised.bundleHash,previous.bundleHash);
    await assert.rejects(complete({...approval,bundleHash:revised.bundleHash,result:{decision:'approve',approved:true}},{},options),
      {code:'FK_I_INVALID_RECEIPT'});
    const finished=await complete({...approval,bundleHash:revised.bundleHash},{},options);
    assert.equal(finished.status,'succeeded');
    assert.equal((await complete({...approval,bundleHash:revised.bundleHash},{},options)).acknowledgement.repeated,true);
  } finally {initial.close();}
  const reopened=createSqliteInteractivePersistence(db,{namespace});
  try {
    const options={...reopened,policy,graphSnapshot};
    const index=await auth.readRunArtifacts({ref},options);
    assert.equal(index.items.length,2);
    assert.ok(index.items.every(v=>v.latestVersionId===latest.versionId&&v.effectiveVersionId===latest.versionId));
    assert.equal(JSON.stringify(index).includes('storageRef'),false);
    const browserHost=createInteractiveHostContext({namespace,subjectId:'observer',authorizeTask:()=>true,
      authorize:({action})=>['viewer:read','viewer:artifacts','viewer:events'].includes(action)});
    const service=await startLocalMcp({listen:{port:0},dataDir:path.join(dir,'mcp'),exportDir:path.join(dir,'exports')},{
      credential:'isolated-viewer-test-credential',
      resolveRunViewer:({runId})=>runId===ref.runId?{auth:browserHost,ref,options}:null,
    });
    try {
      const root=new URL(service.url).origin;
      const runUrl=root+'/runs/'+ref.runId;
      assert.equal((await fetch(runUrl)).status,403);
      const cookie=await browserIdentity(service);
      const headers={cookie};
      assert.equal((await fetch(root+'/runs/unknown',{headers})).status,404);
      assert.equal((await fetch(runUrl+'?afterRevision=9999',{headers})).status,400);
      const response=await fetch(runUrl,{headers});
      assert.equal(response.status,200);
      const html=await response.text();
      const data=readWorkflowPageData(html);
      assert.equal(data.graph.graphDigest,ref.graphDigest);
      assert.equal(data.runView.status,'succeeded');
      assert.ok(data.runView.events.length>0);
      assert.ok(data.runView.events.some(event=>Number.isSafeInteger(event.activation)&&Number.isSafeInteger(event.attempt)));
      assert.deepEqual(data.runView.artifacts.map(item=>item.effectiveVersionId),[latest.versionId,latest.versionId]);
      assert.doesNotMatch(html,/storageRef|Business evidence version/);
      const refresh=readWorkflowPageData(await (await fetch(runUrl+'?afterRevision=0',{headers})).text());
      assert.equal(refresh.runView.revision,data.runView.revision);
      assert.ok(refresh.runView.events.every(event=>event.revision>0));
      const limited=createInteractiveHostContext({namespace,subjectId:'limited',authorizeTask:()=>false,
        authorize:({action})=>action==='viewer:read'});
      const limitedView=readWorkflowPageData(await workflowRunPage({auth:limited,ref,options})).runView;
      assert.equal(limitedView.events,null);
      assert.equal(limitedView.artifacts,null);
      await assert.rejects(workflowRunPage({auth:browserHost,ref:{...ref,graphDigest:'sha256:'+'0'.repeat(64)},options}),
        {code:'FK_I_PROGRAM_MISMATCH'});
    } finally {await service.close();}
  } finally {reopened.close();}
});
