import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { startLocalMcp } from '../../scripts/run-local-mcp.mjs';
import { localModel } from '../../scripts/local-mcp-model.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { checkCandidate, prepareStandardSkill, publishStandardSkill } from '../../src/author/standard-artifact.mjs';
import { bindApprovedInteractiveWorkflow, runApprovedCollectionWorkflow } from '../../src/author/approved-run.mjs';
import { complete, createInteractiveHostContext, createSqliteInteractivePersistence, forkInteractiveRun, resume } from '../../src/interactive/index.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';

const provider = process.env.FLOWKIT_LIVE_VIEW_PROVIDER;
const source = `import {defineWorkflow,parallel,verification,condition,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'delivery-review',name:'Delivery review',version:'1.0.0',nodes:[
  parallel('checks',{name:'Delivery checks',branchMode:'subflow',branches:['document','total'],join:{strategy:'all_succeeded',next:'route'}}),
  verification('document',{name:'Check signed record',verifier:'check-document',onSuccess:'route',onFailure:'decline-document'}),
  verification('total',{name:'Check item count',verifier:'check-total',onSuccess:'route',onFailure:'decline-total'}),
  condition('route',{name:'Route to handoff',branches:[{when:'true',next:'handoff'}]}),
  verification('handoff',{name:'Confirm handoff',verifier:'confirm-handoff',onSuccess:'done',onFailure:'declined'}),
  terminal('decline-document',{name:'Document declined',status:'failed'}),
  terminal('decline-total',{name:'Count declined',status:'failed'}),
  terminal('done',{name:'Delivered',status:'succeeded'}),
  terminal('declined',{name:'Declined',status:'failed'})
]});`;

async function verifyWithModel(model, nodeId) {
  const checks = {
    document:'The record approval is signed. Pass if signed.',
    total:'The delivery expected 4 items and received 4. Pass if they match.',
    handoff:'The delivery destination is the approved review folder and has accepted the handoff. Pass if both facts hold.',
  };
  const response=await model.requestForExecution({
    input:[{role:'user',content:checks[nodeId]+' Evaluate the supplied facts. Use no tools. Return JSON only, with a boolean passed field.'}],
    text:{format:{type:'json_object'}},max_output_tokens:1200,
  },{signal:AbortSignal.timeout(70000)});
  assert.equal(response.status,200);
  const receipt=await response.json();
  assert.equal(receipt.status,'completed');
  const output=receipt.output.flatMap(item=>item.content??[]).filter(item=>item.type==='output_text').map(item=>item.text).join('');
  const result=JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  const requestId=response.headers.get('x-request-id')??receipt.id;
  assert.ok(requestId);
  assert.deepEqual(result,{passed:true});
  return {result,receipt:{provider,nodeId,requestId,model:receipt.model??'codex-default'}};
}

test('Interactive browser follows parallel, pause, reconnect and two independent fork runs', {timeout:provider?420000:60000}, async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-live-view-'));
  const namespace='flowkit-local';
  const stateDir=path.join(dir,'service');
  const open=()=>createSqliteInteractivePersistence(path.join(dir,'runtime.sqlite'),{namespace});
  let allowFork=true;
  const worker=createInteractiveHostContext({namespace,subjectId:'live-view-worker',
    authorize:({action})=>action!=='run:fork'||allowFork,authorizeTask:()=>true});
  let service, client, browser, candidateStore, view, runtimeOptions, approval, graph, target, lastFork;
  const views=new Map();
  let persistence=open(), allowView=true, allowHistory=true, unavailable=false, terminalRevision;
  const policy={id:'live-view',version:'1',disclosePolicyId:'live-view',capabilityStage:'P2',
    canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{}};
  const viewer=createInteractiveHostContext({namespace,subjectId:'live-view-reader',authorizeTask:()=>true,
    authorize:({action,runId,...actual})=>allowView &&
      (action==='viewer:read'||action==='viewer:events'&&allowHistory) &&
      views.has(runId) && Object.entries(approval).every(([key,value])=>actual[key]===value)});
  const runtime={};
  const credential='isolated-live-view-mcp-test';
  const evidence=[];
  try {
    const model=provider ? localModel({provider,workspace:dir,model:provider==='openai'?process.env.FLOWKIT_AUTHOR_MODEL:undefined,
      apiKey:process.env.OPENAI_API_KEY,timeoutMs:70000}) : null;
    const installed=path.join(dir,'workflow.js');
    const spec=path.join(dir,'source.workflow.js');
    await writeFile(spec,source);
    service=await startLocalMcp({listen:{port:0},dataDir:stateDir,exportDir:path.join(dir,'exports')},{
      credential,
      resolveRunViewer({runId}) {
        if (unavailable) throw new Error('Host storage temporarily unavailable');
        return views.get(runId)??null;
      },
      async forkRun(request,{view:origin}) {
        const options={...runtimeOptions,graphSnapshot:graph};
        lastFork=await forkInteractiveRun(request,runtime,options);
        views.set(lastFork.runId,{...origin,ref:{...origin.ref,runId:lastFork.runId}});
        return lastFork;
      },
      async runWorkflow(scope,{candidate,store}) {
        const execution={...scope,skillDirectory:dir};
        const host={hostProfile:candidate.manifest.hostProfile,runtime,authorizeExecution:({executionRef})=>executionRef==='browser-run',
          interactive:{...persistence,auth:worker,policy,startKey:scope.executionRef}};
        const started=await runApprovedCollectionWorkflow(store,execution,host,{privateInput:'keep-private-live-view'});
        runtimeOptions=(await bindApprovedInteractiveWorkflow(store,execution,host)).options;
        view={candidate,auth:viewer,ref:{namespace,runId:started.runId,artifactHash:graph.artifactHash,graphDigest:graph.graphDigest,...approval},
          options:{...runtimeOptions,graphSnapshot:graph}};
        views.set(started.runId,view);
        return started;
      }
    });
    const profile={id:'live-view',digest:artifactDigest('live-view')};
    const {candidate,diagnostics}=await prepareStandardSkill({file:spec,executionMode:'interactive-p2',collectionId:service.collectionId,
      skillId:'delivery-review',name:'delivery-review',version:'1.0.0',description:'Live delivery review',buildId:'live-view',hostProfile:profile});
    assert.ok(candidate,JSON.stringify(diagnostics));
    graph=checkCandidate(candidate);
    assert.equal(graph.mode,'interactive-p2');
    approval={collectionId:service.collectionId,candidateHash:candidate.hash,approvalRef:'live-view-approval'};
    target={...approval,skillId:candidate.manifest.skillId,skillDirectory:dir,executionRef:'browser-run'};
    await writeFile(installed,candidate.files['workflow.js']);
    candidateStore=openLocalSkillStore(path.join(stateDir,'author.sqlite'),()=>true,()=>false,{namespace});
    await publishStandardSkill(candidate,{reviewRef:'live-view-review',approvalRef:approval.approvalRef,previousHash:null},candidateStore);
    client=new Client({name:'flowkit-live-view-test',version:'1.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url),{requestInit:{headers:{authorization:'Bearer '+credential}}}));
    const launch=async () => {
      const {collectionId,skillId,candidateHash,executionRef}=target;
      const reply=await client.callTool({name:'flowkit_run_workflow',arguments:{collectionId,skillId,candidateHash,executionRef}});
      assert.equal(reply.isError===true,false,JSON.stringify(reply));
      return JSON.parse(reply.content[0].text);
    };
    const started=await launch();
    assert.deepEqual(started.pending.map(task=>task.nodeId),['document','total']);
    assert.equal(started.runUrl,new URL('/runs/'+started.runId,service.url).href);
    const endpoint=started.runUrl+'/progress';
    assert.equal((await fetch(endpoint)).status,403);
    browser=await chromium.launch(process.env.FLOWKIT_BROWSER_CHANNEL?{channel:process.env.FLOWKIT_BROWSER_CHANNEL}:{});
    const page=await browser.newPage({viewport:{width:1440,height:950}});
    const errors=[];
    let navigations=0;
    page.on('pageerror',error=>errors.push(error.message));
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
    await page.goto(service.operatorUrl);
    assert.equal((await page.goto(started.runUrl)).status(),200);
    const originalNavigations=navigations;
    const status=page.locator('#liveRunStatus');
    const pending=page.locator('#nodeLayer .has-pending .node-title');
    async function observed(frame,labels,pattern) {
      await page.waitForFunction(({revision,labels,pattern})=>{
        const status=document.getElementById('liveRunStatus')?.textContent??'';
        const names=[...document.querySelectorAll('#nodeLayer .has-pending .node-title')].map(node=>node.title).sort();
        return status.includes('修订 '+revision) && new RegExp(pattern).test(status) &&
          JSON.stringify(names)===JSON.stringify(labels);
      },{revision:frame.revision,labels:[...labels].sort(),pattern},{timeout:10000});
      evidence.push({revision:frame.revision,status:await status.innerText(),pending:await pending.evaluateAll(nodes=>nodes.map(node=>node.title))});
    }
    const pull=await page.request.get(endpoint+'?afterRevision=-1');
    assert.equal(pull.status(),200);
    assert.equal(pull.headers()['cache-control'],'no-store');
    const snapshot=await pull.json();
    assert.equal(snapshot.runId,started.runId);
    assert.equal(snapshot.graphDigest,graph.graphDigest);
    assert.deepEqual(snapshot.pending.map(task=>task.scope[0].laneId),['document','total']);
    assert.ok(snapshot.pending.every(task=>!Object.hasOwn(task,'requestId')));
    assert.doesNotMatch(JSON.stringify(snapshot),/keep-private-live-view/);
    assert.equal((await page.request.get(endpoint+'?afterRevision=999999')).status(),400);
    allowHistory=false;
    assert.equal((await (await page.request.get(endpoint+'?afterRevision=-1')).json()).events,null);
    allowHistory=true;

    await observed(started,['Check signed record','Check item count'],'待办 2 项');
    unavailable=true;
    assert.equal((await page.request.get(endpoint)).status(),503);
    await page.waitForFunction(()=>document.getElementById('liveRunStatus')?.textContent.includes('正在重连'));
    assert.equal(await pending.count(),2);
    unavailable=false;
    await page.waitForFunction(()=>!document.getElementById('liveRunStatus')?.textContent.includes('正在重连'));
    await page.getByRole('button',{name:'Check item count · total',exact:true}).press('Enter');
    await page.waitForFunction(()=>document.getElementById('inspectorTitle')?.textContent==='Check item count');
    await page.getByRole('button',{name:'放大',exact:true}).click();
    const checkedZoom=await page.locator('#zoomReadout').innerText();
    async function submit(task,options=runtimeOptions,runId=started.runId) {
      assert.equal(task.kind,'verification');
      const resolved=model?await verifyWithModel(model,task.nodeId):{result:{passed:true}};
      if (resolved.receipt) evidence.push({...resolved.receipt,runId});
      return complete({kind:'verification',runId,requestId:task.requestId,outcome:'succeeded',result:resolved.result},
        runtime,options);
    }
    const first=await submit(started.pending[0]);
    await observed(first,['Check item count'],'待办 1 项');
    assert.equal(await page.locator('#zoomReadout').innerText(),checkedZoom);
    assert.equal(await page.locator('#inspectorTitle').innerText(),'Check item count');
    const paused=await submit(first.pending[0],{...runtimeOptions,maxStagesPerCall:1});
    assert.equal(paused.status,'paused');
    await observed(paused,[],'已暂停.*等待下一次调度');

    await page.context().setOffline(true);
    await page.waitForFunction(()=>document.getElementById('liveRunStatus')?.textContent.includes('正在重连'));
    persistence.close();
    persistence=open();
    runtimeOptions=(await bindApprovedInteractiveWorkflow(candidateStore,target,{
      hostProfile:profile,runtime,authorizeExecution:()=>true,interactive:{...persistence,auth:worker,policy,startKey:target.executionRef},
    })).options;
    view.options={...runtimeOptions,graphSnapshot:graph};
    const continued=await resume(started.runId,runtime,runtimeOptions);
    assert.match(await status.innerText(),/正在重连.*已暂停/);
    assert.equal(continued.runId,started.runId);
    assert.equal(continued.pending[0].nodeId,'handoff');
    await page.context().setOffline(false);
    await observed(continued,['Confirm handoff'],'待办 1 项');
    assert.doesNotMatch(await status.innerText(),/已暂停|正在重连|等待下一次调度/);
    const completed=await submit(continued.pending[0]);
    await observed(completed,[],'成功');
    assert.equal(completed.status,'succeeded');
    terminalRevision=completed.revision;
    assert.equal(navigations,originalNavigations);
    const originalCheckpoint=await persistence.store.load(started.runId);
    assert.equal(originalCheckpoint.revision,terminalRevision);
    const forkEndpoint=started.runUrl+'/fork';
    const origin=new URL(started.runUrl).origin;
    assert.equal((await fetch(forkEndpoint+'?nodeId=handoff')).status,403);
    const forks=[];

    async function startFork(nodeName,nodeId,expectedStart,expectedPending) {
      await page.getByRole('button',{name:nodeName+' · '+nodeId,exact:true}).press('Enter');
      await page.getByRole('button',{name:'查看可复跑记录'}).click();
      const picker=page.getByRole('combobox',{name:'历史执行'});
      await picker.locator('option').first().waitFor({state:'attached'});
      assert.match(await page.locator('[data-fork-entry]').innerText(),expectedStart);
      const revision=Number(await picker.inputValue());
      const details=await (await page.request.get(forkEndpoint+'?nodeId='+nodeId)).json();
      const point=details.points.find(item=>item.revision===revision);
      assert.equal(point.nodeId,nodeId);
      assert.ok(point.activation>0);
      const checked={revision,entryRevision:point.entryRevision,startKey:'policy-check-'+nodeId,redoWrites:false};
      assert.equal((await page.request.post(forkEndpoint,{headers:{origin:'https://invalid.example'},data:checked})).status(),403);
      allowFork=false;
      const denied=await page.request.post(forkEndpoint,{headers:{origin},data:checked});
      assert.equal(denied.status(),403,await denied.text());
      allowFork=true;
      const [response]=await Promise.all([
        page.waitForResponse(r=>r.url()===forkEndpoint&&r.request().method()==='POST'),
        page.getByRole('button',{name:'从这次执行重新开始'}).click(),
      ]);
      assert.equal(response.status(),200);
      const {runId}=lastFork;
      await page.waitForURL(origin+'/runs/'+runId);
      assert.notEqual(runId,started.runId);
      assert.deepEqual(lastFork.pending.map(task=>task.nodeId),expectedPending);
      assert.equal((await page.request.post(forkEndpoint,{headers:{origin},
        data:response.request().postDataJSON()})).status(),200);
      assert.equal(lastFork.runId,runId);
      let frame=lastFork;
      while (frame.pending.length) frame=await submit(frame.pending[0],runtimeOptions,runId);
      assert.equal(frame.status,'succeeded');
      await observed(frame,[],'成功');
      assert.deepEqual(await persistence.store.load(started.runId),originalCheckpoint);
      forks.push({runId,nodeId,startNodeId:point.startNodeId,entryRevision:point.entryRevision,terminalRevision:frame.revision,status:frame.status});
    }
    await startFork('Confirm handoff','handoff',/实际起点 · Confirm handoff/,['handoff']);
    assert.equal((await page.goto(started.runUrl)).status(),200);
    await startFork('Check signed record','document',/Delivery checks · 从当次并行组入口重跑整个并行组/,['document','total']);
    assert.deepEqual(errors,[]);
    allowView=false;
    assert.equal((await page.request.get(endpoint)).status(),404);
    assert.equal((await launch()).runUrl,undefined);
    if (provider) console.log(JSON.stringify({provider,runId:started.runId,terminalRevision,status:completed.status,
      reloads:0,port:new URL(service.url).port,forks,evidence}));
  } finally {
    await browser?.close();
    await client?.close();
    await service?.close();
    candidateStore?.close();
    persistence.close();
    await rm(dir,{recursive:true,force:true});
  }
});
