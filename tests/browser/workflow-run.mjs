import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { prepareStandardSkill, prepareImportedStandardSkill, checkCandidate } from '../../src/author/standard-artifact.mjs';
import { isControlSignal, runArtifact } from '../../src/index.mjs';
import { start, complete, createInteractiveHostContext, createSqliteInteractivePersistence,
  loadInteractiveProgram } from '../../src/interactive/index.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { canonicalBytes } from '../../src/interactive/canonical.mjs';
import { startLocalMcp } from '../../scripts/run-local-mcp.mjs';
import { readWorkflowPageData } from '../../scripts/workflow-viewer.mjs';

const standardSource=`import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'single-call',name:'Single call',version:'1.0.0',nodes:[
  action('read',{name:'Read <em>input</em>',action:'read-input',next:'done'}),
  terminal('done',{name:'Done',status:'succeeded'})
]});`;

const interactiveSource=`import {defineWorkflow,action,human,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'observed-run',name:'Observed run',version:'1.0.0',nodes:[
  action('collect',{name:'Collect evidence',action:'collect',effect:'read-only',reads:[],writes:[],next:'review'}),
  human('review',{name:'Review evidence',onApprove:'done',onReject:'repair',onDecline:'blocked',maxRevisions:1}),
  action('repair',{name:'Recheck evidence',action:'collect',effect:'read-only',reads:[],writes:[],next:'review'}),
  terminal('done',{name:'Done',status:'succeeded'}),terminal('blocked',{name:'Blocked',status:'failed'})
]});`;

async function settleRead(frame,options,auth,evidenceHash) {
  const [pending]=frame.pending;
  const {operationKey}=pending.task;
  const inputHash=artifactDigest(canonicalBytes(pending.task));
  const operation={runId:frame.runId,operationKey,inputHash};
  await options.operationController.claim({...operation,requestId:pending.requestId},auth);
  const result={set:{}};
  await options.operationController.settle({...operation,effect:'no-effect',result,evidenceHash},auth);
  return complete({runId:frame.runId,operationKey,requestId:pending.requestId,kind:'action',outcome:'succeeded',result},{},options);
}

test('browser shows an authorized Standard trace and a different persisted Interactive run', {timeout:60000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-browser-run-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const namespace='browser-run';
  const form=async (id,source,executionMode,compilerOptions={})=>{
    const file=path.join(dir,id+'.workflow.js');
    await writeFile(file,source);
    const {candidate}=await prepareStandardSkill({file,executionMode,compilerOptions,collectionId:namespace,
      skillId:id,name:id,version:'1.0.0',description:id,buildId:id,
      hostProfile:{id:namespace,digest:artifactDigest(namespace)}});
    assert.ok(candidate);
    return {file,candidate,graph:checkCandidate(candidate)};
  };
  const standard=await form('single-call',standardSource,'standard',{trace:true});
  const standardFile=path.join(dir,'workflow.js');
  await writeFile(standardFile,standard.candidate.files['workflow.js']);
  const events=[];
  const completed=await runArtifact(standardFile,standard.graph.artifactHash,{isControlSignal,runAction:()=>{},
    trace:{start:nodeId=>events.push({nodeId,kind:'start',private:'private-trace-state'}),
      end:(nodeId,_name,outcome)=>events.push({nodeId,kind:'end',outcome})}},{});
  assert.deepEqual(events.map(({nodeId,kind})=>[nodeId,kind]),[['read','start'],['read','end']]);
  const standardRef={runId:'standard-invocation',artifactHash:standard.graph.artifactHash,
    graphDigest:standard.graph.graphDigest,candidateHash:standard.candidate.hash};

  const interactive=await form('observed-run',interactiveSource,'interactive-p2');
  const recipient=await prepareImportedStandardSkill(interactive.candidate,{mode:'new-collection',
    collectionId:'recipient',skillId:'received-review',sourceRef:'approved-export'},
  {verifyImport:({sourceHash,collectionId})=>sourceHash===interactive.candidate.hash&&collectionId==='recipient'});
  assert.notEqual(recipient.hash,interactive.candidate.hash);
  assert.deepEqual(checkCandidate(recipient),interactive.graph);
  const approval={collectionId:recipient.manifest.collectionId,candidateHash:recipient.hash,approvalRef:'recipient-review'};
  const policy={id:namespace,version:'1',disclosePolicyId:'browser',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const worker=createInteractiveHostContext({namespace,subjectId:'worker',authorize:()=>true,authorizeTask:()=>true,
    authorizeHuman:({reviewDigest,bundle})=>({proofId:'browser-review',evidenceHash:bundle?.bundleHash??reviewDigest})});
  let allowArtifactIndex=true;
  const viewer=createInteractiveHostContext({namespace,subjectId:'viewer',authorizeTask:()=>true,
    authorize:({action,...target})=>['viewer:read','viewer:events','viewer:artifacts','viewer:artifact-content'].includes(action)&&
      (action!=='viewer:artifacts'||allowArtifactIndex)&&
      Object.entries(approval).every(([key,value])=>target[key]===value)});
  const open=()=>createSqliteInteractivePersistence(path.join(dir,'run.sqlite'),{namespace});
  let persistence=open(), frame, service, browser;
  try {
    const options={...persistence,auth:worker,policy,startKey:'reviewable'};
    const programBytes=Buffer.from(recipient.files['workflow.js']);
    const {interactiveProgram}=await loadInteractiveProgram(programBytes,interactive.graph.artifactHash);
    const programRef=await persistence.programRegistry.putImmutable(programBytes,
      {...interactiveProgram.identity,artifactHash:interactive.graph.artifactHash});
    frame=await start(programRef,{},{privateInput:'private-run-state'},options);
    const [{requestId}]=frame.pending;
    const body='## Actual browser review material\n\n- **Original version**';
    const storageRef=path.join(dir,'material.txt');
    await writeFile(storageRef,body);
    const contentHash=artifactDigest(body);
    frame=await settleRead(frame,options,worker,contentHash);
    await persistence.artifactController.registerVersion({runId:frame.runId,requestId,
      artifactId:'review-material',contentHash,mimeType:'text/markdown',sizeBytes:Buffer.byteLength(body),storageRef,versionLabel:'v1'},worker);
    for(let i=1;i<=100;i++)await persistence.artifactController.registerVersion({runId:frame.runId,requestId,
      artifactId:'page-material-'+i,contentHash,mimeType:'text/markdown',sizeBytes:Buffer.byteLength(body),storageRef},worker);
    persistence.close();
    persistence=open();
    const ref={namespace,runId:frame.runId,artifactHash:interactive.graph.artifactHash,graphDigest:interactive.graph.graphDigest,
      ...approval};
    const viewOptions={...persistence,policy,graphSnapshot:interactive.graph};
    let allowStandard=true;
    let allowDescriptions=false;
    let viewerCandidate=recipient;
    let viewManifest={schemaVersion:1,graphDigest:ref.graphDigest,
      nodeDescriptions:[{nodeId:'review',text:'Approved note <em>as text</em>'}]};
    service=await startLocalMcp({listen:{port:0},dataDir:path.join(dir,'mcp'),exportDir:path.join(dir,'exports')},{
      credential:'isolated-browser-run-test',readArtifactContent:({storageRef})=>readFile(storageRef),
      resolveRunViewer:({runId})=>runId===standardRef.runId?
        {ref:standardRef,candidate:standard.candidate,standardTrace:{status:completed.status,events},
          authorizeTrace:({ref:requested,requestContext})=>allowStandard&&requested.runId===standardRef.runId&&!!requestContext.principalId}:
        runId===ref.runId?{ref,candidate:viewerCandidate,auth:viewer,options:viewOptions,viewManifest,
          authorizeViewManifest:({requestContext,ref:requested})=>allowDescriptions&&
            requested.graphDigest===ref.graphDigest&&!!requestContext.principalId}:null
    });
    browser=await chromium.launch(process.env.FLOWKIT_BROWSER_CHANNEL?{channel:process.env.FLOWKIT_BROWSER_CHANNEL}:{});
    const page=await browser.newPage({viewport:{width:1440,height:950}});
    const standardUrl=new URL('/runs/'+standardRef.runId,service.url).href;
    const runUrl=new URL('/runs/'+ref.runId,service.url).href;
    assert.equal((await page.goto(standardUrl)).status(),403);
    await page.goto(service.operatorUrl);
    const trace=await page.goto(standardUrl);
    assert.equal(trace.status(),200);
    assert.doesNotMatch(await trace.text(),/private-trace-state/);
    assert.equal(await page.locator('#nodeLayer em').count(),0);
    await page.getByRole('button',{name:'Read <em>input</em> · read',exact:true}).press('Enter');
    const tracePanel=await page.locator('#panel-section-execution').innerText();
    assert.match(tracePanel,/Standard 单次调用记录/);
    assert.match(tracePanel,/开始调用[\s\S]*调用返回/);
    assert.doesNotMatch(tracePanel,/修订/);
    assert.equal((await page.goto(standardUrl+'?afterRevision=0')).status(),400);
    allowStandard=false;
    assert.equal((await page.goto(standardUrl)).status(),404);
    const durable=await page.goto(runUrl);
    assert.equal(durable.status(),200);
    assert.doesNotMatch(await durable.text(),/private-run-state|storageRef|Actual browser review material|Approved note/);
    viewerCandidate=interactive.candidate;
    assert.equal((await page.goto(runUrl)).status(),404);
    viewerCandidate=recipient;
    allowDescriptions=true;
    const described=await page.goto(runUrl);
    const describedPage=readWorkflowPageData(await described.text());
    assert.equal(describedPage.candidateHash,recipient.hash);
    assert.equal(describedPage.mermaid,recipient.files['workflow.mmd']);
    assert.equal(describedPage.layout.nodes.find(node=>node.nodeId==='review').description,viewManifest.nodeDescriptions[0].text);
    assert.deepEqual(describedPage.graph,interactive.graph);
    await page.getByRole('button',{name:'Review evidence · review',exact:true}).press('Enter');
    assert.match(await page.locator('#panel-section-description').innerText(),/Approved note <em>as text<\/em>/);
    assert.equal(await page.locator('#panel-section-description em').count(),0);
    viewManifest={...viewManifest,schemaVersion:99};
    assert.doesNotMatch(await (await page.goto(runUrl)).text(),/Approved note/);
    viewManifest={...viewManifest,schemaVersion:1,nodeDescriptions:[{nodeId:'unknown',text:'Wrong scope'}]};
    assert.doesNotMatch(await (await page.goto(runUrl)).text(),/Wrong scope/);
    await page.getByRole('button',{name:'Review evidence · review',exact:true}).press('Enter');
    assert.ok(await page.locator('#nodeLayer .has-pending').count());
    const journalPanel=await page.locator('#panel-section-execution').innerText();
    assert.match(journalPanel,/Interactive 持久日志[\s\S]*待处理/);
    await page.locator('#artifactCenterBtn').click();
    assert.match(await page.locator('#acList').innerText(),/review-material/);
    const artifact=page.locator('.ac-item').filter({has:page.getByText('review-material',{exact:true})});
    assert.match(await artifact.innerText(),/版本 v1/);
    await artifact.getByText('版本与内容摘要').click();
    assert.match(await artifact.innerText(),new RegExp(contentHash));
    await artifact.getByRole('button',{name:'查看正文'}).click();
    assert.equal(await page.locator('#readerContent h2').textContent(),'Actual browser review material');
    assert.equal(await page.locator('#readerContent strong').textContent(),'Original version');
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'下一页'}).click();
    await page.getByText('page-material-100',{exact:true}).waitFor();
    assert.equal(await page.getByText('review-material',{exact:true}).count(),0);
    await page.getByRole('button',{name:'上一页'}).click();
    await page.getByText('review-material',{exact:true}).waitFor();
    assert.equal((await viewer.readRunView(ref,viewOptions)).revision,frame.revision);
    const [prior]=frame.pending;
    const runOptions={...viewOptions,auth:worker};
    const revise={runId:frame.runId,requestId:prior.requestId,kind:'human',outcome:'succeeded',
      reviewDigest:prior.task.reviewDigest,result:{decision:'revise'}};
    const repair=await complete(revise,{},runOptions);
    assert.equal((await complete(revise,{},runOptions)).acknowledgement.repeated,true);
    const second=await settleRead(repair,runOptions,worker,contentHash);
    assert.ok(second.pending[0].activation>prior.activation);
    await page.context().setOffline(true);
    await assert.rejects(page.goto(runUrl));
    await page.context().setOffline(false);
    const restored=await page.goto(runUrl+'?afterRevision=0');
    const latest=readWorkflowPageData(await restored.text()).runView;
    assert.equal(latest.revision,second.revision);
    assert.ok(latest.events.every(event=>event.revision>0));
    await page.getByRole('button',{name:'Review evidence · review',exact:true}).press('Enter');
    const repeatedPanel=await page.locator('#panel-section-execution').innerText();
    assert.match(repeatedPanel,new RegExp('待处理[^\\n]*激活 '+second.pending[0].activation));
    assert.match(repeatedPanel,new RegExp('激活 '+prior.activation));
    const fetchedAgain=readWorkflowPageData(await (await page.goto(runUrl+'?afterRevision=0')).text()).runView;
    assert.deepEqual(fetchedAgain,latest);
    const cursor=Math.floor(second.revision/2);
    const newer=readWorkflowPageData(await (await page.goto(runUrl+'?afterRevision='+cursor)).text()).runView;
    assert.ok(newer.events.length>0);
    assert.ok(newer.events.every(event=>event.revision>cursor));
    const older=readWorkflowPageData(await (await page.goto(runUrl+'?afterRevision=0')).text()).runView;
    assert.deepEqual(older,latest);
    assert.equal((await viewer.readRunView(ref,viewOptions)).revision,second.revision);

    await page.goto(runUrl);
    const timeOrigin=await page.evaluate(()=>performance.timeOrigin);
    await page.locator('#artifactCenterBtn').click();
    await page.getByRole('button',{name:'下一页'}).click();
    await page.getByText('page-material-100',{exact:true}).waitFor();
    await page.locator('#acSearch').fill('review-material');
    await page.locator('#acStatus').selectOption('latest');
    assert.equal(await artifact.count(),0);

    await page.context().setOffline(true);
    const version=await persistence.artifactController.registerVersion({runId:frame.runId,
      requestId:repair.pending[0].requestId,artifactId:'review-material',contentHash,mimeType:'text/markdown',
      sizeBytes:Buffer.byteLength(body),storageRef,versionLabel:'v2'},worker);
    assert.equal((await viewer.readRunView(ref,viewOptions)).revision,second.revision);
    await page.context().setOffline(false);
    await artifact.getByText('版本 v2',{exact:true}).waitFor({timeout:8000});
    assert.equal(await page.locator('#acSearch').inputValue(),'review-material');
    assert.equal(await page.locator('#acStatus').inputValue(),'latest');
    assert.match(await page.locator('#acPageStatus').innerText(),/第 2 页/);

    await artifact.getByRole('button',{name:'查看正文'}).click();
    await page.locator('#readerContent h2').waitFor();
    allowArtifactIndex=false;
    await page.getByText('当前授权未提供产物索引。',{exact:true}).waitFor();
    assert.equal(await page.locator('#detailReader').isVisible(),false);
    assert.equal(await page.locator('#readerContent h2').count(),0);
    allowArtifactIndex=true;
    await artifact.getByText('版本 v2',{exact:true}).waitFor();
    assert.equal(await page.locator('#acSearch').inputValue(),'review-material');

    // Hold a pre-approval index response across the final Run transition.
    const held=Promise.withResolvers(),release=Promise.withResolvers();
    await page.route(/\/artifacts\?after=\d+$/,async route=>{
      const response=await route.fetch();
      held.resolve();
      await release.promise;
      await route.fulfill({response});
    },{times:1});
    try {
      await held.promise;
      const pending=second.pending[0];
      const request={runId:frame.runId,requestId:pending.requestId,reviewDigest:pending.task.reviewDigest};
      const bundle=await persistence.artifactController.freezeBundle({...request,versionIds:[version.versionId],
        expiresAt:Date.now()+120000},worker);
      const finished=await complete({...request,kind:'human',bundleHash:bundle.bundleHash,outcome:'succeeded',
        result:{decision:'approve'}},{},runOptions);
      assert.equal(finished.status,'succeeded');
      await page.getByText('成功 · 修订 '+finished.revision,{exact:true}).waitFor();
    } finally {release.resolve();}
    await artifact.getByText('已确认 · 生效 · 最新版本',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>performance.timeOrigin),timeOrigin);
    assert.equal(await page.locator('#acSearch').inputValue(),'review-material');
    assert.equal(await page.locator('#acStatus').inputValue(),'latest');
  } finally {
    await browser?.close();
    await service?.close();
    persistence.close();
  }
});
