import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {compileInteractive,complete,createInteractiveHostContext,createSqliteInteractivePersistence,resume,start} from '../../src/interactive/index.mjs';
import {createCapabilities} from './capabilities.mjs';
import {change,createLocalTarget,flowKitRoot} from './local-target.mjs';

const hash = value => sha256Bytes(canonicalBytes(value));
const source = fileURLToPath(new URL('./software-delivery.workflow.js',import.meta.url));
const compiled = await compileInteractive(source,{output:'memory',featureStage:'P2'});
assert.deepEqual(compiled.diagnostics,[]);
assert.equal(compiled.graphSnapshot.nodes.length,140);
const base=path.join(flowKitRoot,'.tmp','v45-reference');
await mkdir(base,{recursive:true});
const bundleOut=await mkdtemp(path.join(base,'verification-'));
await writeFile(path.join(bundleOut,'workflow.js'),compiled.code);
await writeFile(path.join(bundleOut,'workflow.graph.json'),JSON.stringify(compiled.graphSnapshot,null,2));
await writeFile(path.join(bundleOut,'workflow.mmd'),compiled.mermaid);
console.log(JSON.stringify({evidence:bundleOut,program:compiled.programIdentity.artifactHash,graph:compiled.graphSnapshot.graphDigest}));

let npm;
for(const candidate of [process.env.FLOWKIT_V45_NPM_CLI,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),
  path.join(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
  try {await access(candidate);npm=candidate;break;} catch { /* Try the next known installation location. */ }
}
assert.ok(npm,'Set FLOWKIT_V45_NPM_CLI to the npm CLI JS entrypoint');

const suites = [
  {name:'delivered',terminal:'done',migration:true,revise:true},
  {name:'rolled-back',terminal:'rolled-back',canaryPostWrite:true},
  {name:'rollback-failed',terminal:'rollback-failed',canaryPostWrite:true,rollbackDenied:true},
  {name:'restore-error',terminal:'rollback-failed',canaryPostWrite:true,restoreError:true},
  {name:'closeout-failed',terminal:'closeout-failed',archiveDenied:true},
  {name:'declined',terminal:'blocked',decline:true},
  {name:'clarification',terminal:'needs-clarification',ambiguity:true},
];
const selected=process.argv.slice(2);
assert.ok(selected.every(name=>suites.some(suite=>suite.name===name)),'Unknown scenario');
const reports=[];
const auditedToolchains=new Map();

for(const suite of suites.filter(item=>!selected.length||selected.includes(item.name))) {
  const namespace='v45-'+suite.name;
  const root=path.join(bundleOut,suite.name);
  await mkdir(root);
  const target=await createLocalTarget(root,namespace,{rejectRestore:!!suite.restoreError});
  const db=path.join(root,'flowkit.sqlite');
  const evidence=new DatabaseSync(path.join(root,'evidence.sqlite'));
  evidence.exec(`CREATE TABLE receipt(request TEXT PRIMARY KEY,node TEXT NOT NULL,entry TEXT NOT NULL);
    CREATE TABLE artifact(version TEXT PRIMARY KEY,entry TEXT NOT NULL);
    CREATE TABLE review(request TEXT PRIMARY KEY,node TEXT NOT NULL,statement TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE TABLE observation(name TEXT PRIMARY KEY,entry TEXT NOT NULL);`);
  const notes=[];
  const get=id=>{
    const row=evidence.prepare('SELECT entry FROM receipt WHERE node=? ORDER BY rowid DESC LIMIT 1').get(id);
    assert.ok(row,'Missing prior evidence for '+id);
    return JSON.parse(row.entry).evidence;
  };
  const note=(name,value)=>{
    evidence.prepare('INSERT INTO observation VALUES (?,?)').run(name,JSON.stringify(value));
    notes.push(name);
  };
  const record=(pending,entry)=>evidence.prepare('INSERT INTO receipt VALUES (?,?,?)').run(pending.requestId,pending.nodeId,
    JSON.stringify({attempt:pending.attempt,activation:pending.activation,...entry}));
  const journal={
    artifacts:()=>evidence.prepare('SELECT entry FROM artifact ORDER BY rowid').all().map(row=>JSON.parse(row.entry)),
    lastDecision:id=>JSON.parse(evidence.prepare('SELECT statement FROM review WHERE node=? ORDER BY rowid DESC LIMIT 1').get(id)?.statement??'null')?.result,
    parallelStartedWithFourPending:()=>Boolean(evidence.prepare("SELECT name FROM observation WHERE name='parallel-reopen'").get()),
    latestFailure:()=>JSON.parse(evidence.prepare("SELECT entry FROM receipt WHERE json_extract(entry,'$.outcome')='failed' ORDER BY rowid DESC LIMIT 1").get()?.entry??'null'),
  };
  const request={target:namespace,change:suite.ambiguity?'Update something in the service':change,migration:!!suite.migration};
  const signers=new Map(['reference-user','reference-operator'].map(id=>[id,generateKeyPairSync('ed25519')]));
  for(const [id,key] of signers) await writeFile(path.join(root,id+'-public.pem'),key.publicKey.export({format:'pem',type:'spki'}));
  function approval(id) {
    const row=evidence.prepare('SELECT statement,signature FROM review WHERE node=? ORDER BY rowid DESC LIMIT 1').get(id);
    if (!row) return null;
    const statement=JSON.parse(row.statement);
    if (statement.result.decision!=='approve') return null;
    assert.equal(verify(null,canonicalBytes(statement),signers.get(statement.subjectId).publicKey,Buffer.from(row.signature,'base64url')),true);
    return statement;
  }
  const lockHash=await target.hashFile(path.join(flowKitRoot,'package-lock.json'));
  const toolchain={lockHash,allowedLicenses:new Set(['MIT','ISC','Apache-2.0','BSD-2-Clause','BSD-3-Clause','0BSD','BlueOak-1.0.0']),
    async sbom(){
      const result=await target.execute('dependency-sbom',[npm,'sbom','--package-lock-only','--sbom-format','cyclonedx'],flowKitRoot);
      const document=JSON.parse(await target.checked(result));
      return {components:document.components.length,digest:sha256Bytes(Buffer.from(result.stdout)),lockHash};
    },
    async audit(){
      if (!auditedToolchains.has(lockHash)) {
        const result=await target.execute('dependency-audit',[npm,'audit','--audit-level=high','--json'],flowKitRoot);
        const document=JSON.parse(result.stdout);
        assert.ok(document.metadata?.vulnerabilities,'Dependency audit returned no verification evidence');
        auditedToolchains.set(lockHash,{exitCode:result.exitCode,summary:document.metadata.vulnerabilities,
          digest:sha256Bytes(Buffer.from(result.stdout))});
      }
      const report=auditedToolchains.get(lockHash);
      await target.writeJson(path.join(target.evidence,'dependency-audit-receipt.json'),{lockHash,...report});
      return report.exitCode===0;
    },
  };
  const handlers=createCapabilities({target,request,namespace,get,journal,faults:suite,approval,toolchain});
  const graph=compiled.graphSnapshot;
  assert.deepEqual(graph.nodes.filter(node=>node.type==='action').map(node=>node.id).sort(),Object.keys(handlers.actions).sort());
  assert.deepEqual(graph.nodes.filter(node=>node.type==='verification').map(node=>node.id).sort(),Object.keys(handlers.verifiers).sort());
  const knownIds=new Set(graph.nodes.map(node=>node.id));
  const allowed=new Set(['run:create','run:resume','run:complete','result:read','operation:claim','operation:settle','artifact:register',
    'artifact:freeze','viewer:read','viewer:events','viewer:output','viewer:artifacts']);
  const authorize = request=>allowed.has(request.action) && (!request.action.startsWith('viewer:') || request.graphDigest===graph.graphDigest);
  const worker=createInteractiveHostContext({namespace,subjectId:'reference-worker',authorize,
    authorizeTask:({nodeId})=>knownIds.has(nodeId)&&!(nodeId==='restore-previous-release'&&suite.rollbackDenied)});
  const observer=createInteractiveHostContext({namespace,subjectId:'reference-viewer',authorize:({action,graphDigest})=>
    action.startsWith('viewer:')&&graphDigest===graph.graphDigest,authorizeTask:({nodeId})=>knownIds.has(nodeId)});
  const policy={id:namespace,version:'1',disclosePolicyId:'reference-only',capabilityStage:'P2',bindingManifest:{},
    requiredBundleReviews:['record-user-confirmation','approve-release'],canonicalizationVersion:'jcs-rfc8785-v1'};
  const open=()=>({...createSqliteInteractivePersistence(db,{namespace}),auth:worker,policy,startKey:namespace,graphSnapshot:graph});
  let binding=open();
  let frame;
  let rootRef;
  const registered=new Map();

  async function reopen(label,current) {
    binding.close();
    binding=open();
    const after=await resume(current.runId,{},binding);
    assert.deepEqual(after.pending,current.pending);
    note(label,after.pending.map(({nodeId,requestId,activation})=>({nodeId,requestId,activation})));
    return after;
  }
  async function register(pending,artifacts) {
    for(const [artifactId,storageRef,mimeType] of artifacts) {
      const bytes=await readFile(storageRef);
      const registeredVersion=await binding.artifactController.registerVersion({runId:frame.runId,requestId:pending.requestId,artifactId,
        storageRef,mimeType,contentHash:sha256Bytes(bytes),sizeBytes:bytes.byteLength},worker);
      registered.set(artifactId,registeredVersion.versionId);
      evidence.prepare('INSERT INTO artifact VALUES (?,?)').run(registeredVersion.versionId,JSON.stringify(registeredVersion));
    }
  }
  async function doReview(pending) {
    const initial=pending.nodeId==='record-user-confirmation';
    const previous=journal.lastDecision(pending.nodeId);
    const decision=initial&&suite.decline?'decline':suite.revise&&!previous?'revise':'approve';
    const artifactIds=initial?['requirements','acceptance','requirement-flow']:['candidate','release-plan'];
    const versionIds=artifactIds.map(id=>registered.get(id));
    assert.ok(versionIds.every(Boolean),'Every reviewed artifact must be registered');
    const {runId}=frame;
    const {requestId,task:{reviewDigest}}=pending;
    const selectedBundle=await binding.artifactController.freezeBundle({runId,requestId,reviewDigest,versionIds,
      expiresAt:Date.now()+5*60*1000},worker);
    const result={decision,comment:decision==='revise'?(initial?'Clarify whitespace acceptance.':'Keep the same release; explain the CI evidence.'):null};
    const subjectId=initial?'reference-user':'reference-operator';
    const key=signers.get(subjectId);
    const statement={namespace,subjectId,runId,requestId,reviewDigest,result,bundleHash:selectedBundle.bundleHash,versionIds,
      ...(initial?{}:{artifact:get('package-approval-bundle').artifact,plan:get('package-approval-bundle').planHash})};
    const signature=sign(null,canonicalBytes(statement),key.privateKey);
    const reviewer=createInteractiveHostContext({namespace,subjectId,authorize,authorizeTask:({nodeId})=>knownIds.has(nodeId),
      authorizeHuman:input=>{
        if (input.namespace!==namespace||input.subjectId!==subjectId||input.runId!==runId||input.requestId!==requestId
          ||input.reviewDigest!==reviewDigest||input.bundle.bundleHash!==statement.bundleHash||hash(input.result)!==hash(result)
          ||!verify(null,canonicalBytes(statement),key.publicKey,signature)) return false;
        return {proofId:hash(statement),evidenceHash:sha256Bytes(signature)};
      }});
    const submission={kind:'human',outcome:'succeeded',result,runId,requestId,reviewDigest,bundleHash:statement.bundleHash};
    if (!previous) {
      await assert.rejects(complete(submission,{},binding),{code:'FK_I_HOST_DENIED'});
      await assert.rejects(complete({...submission,bundleHash:'sha256:'+'0'.repeat(64)},{},{...binding,auth:reviewer}),{code:'FK_I_STALE_RECEIPT'});
    }
    if (previous?.decision==='revise') {
      const prior=JSON.parse(evidence.prepare('SELECT statement FROM review WHERE node=? ORDER BY rowid DESC LIMIT 1').get(pending.nodeId).statement);
      assert.notEqual(prior.reviewDigest,reviewDigest);
      if (initial) assert.notEqual(prior.versionIds[0],versionIds[0]);
      else assert.deepEqual(prior.versionIds,versionIds);
      await assert.rejects(complete({...submission,bundleHash:prior.bundleHash},{},{...binding,auth:reviewer}),{code:'FK_I_STALE_RECEIPT'});
    }
    const after=await complete(submission,{},{...binding,auth:reviewer});
    evidence.prepare('INSERT INTO review VALUES (?,?,?,?)').run(requestId,pending.nodeId,JSON.stringify(statement),signature.toString('base64url'));
    record(pending,{outcome:'succeeded',evidence:{decision,bundleHash:statement.bundleHash}});
    return after;
  }

  try {
    frame=await start(source,{}, {request,privateMarker:'host-only-reference-marker'},binding);
    rootRef={namespace,runId:frame.runId,artifactHash:graph.artifactHash,graphDigest:graph.graphDigest};
    let iterations=0;
    while(frame.status==='waiting'||frame.status==='paused') {
      assert.ok(++iterations<550,JSON.stringify(frame));
      if(frame.status==='paused') {
        assert.notEqual(frame.pauseReason,'reconciliation','Unresolved operation requires operator reconciliation');
        frame=await resume(frame.runId,{},binding);
        continue;
      }
      assert.ok(frame.pending.length);
      if(frame.pending.length===4&&!notes.includes('parallel-reopen')) frame=await reopen('parallel-reopen',frame);
      let pending=frame.pending.at(-1);
      if(pending.kind==='human') {
        if(!notes.includes(pending.nodeId+'-reopen')) {
          frame=await reopen(pending.nodeId+'-reopen',frame);
          pending=frame.pending[0];
        }
        frame=await doReview(pending);
        continue;
      }
      const {runId}=frame;
      const {requestId,nodeId,kind,task}=pending;
      if(kind==='verification') {
        if(nodeId==='verify-audit-trail'&&suite.archiveDenied) {
          const original=await readFile(target.auditPath);
          await writeFile(target.auditPath,Buffer.concat([original,Buffer.from('\n')]));
          note('archive-integrity-fault',{before:sha256Bytes(original),after:await target.hashFile(target.auditPath)});
        }
        const passed=await handlers.verifiers[nodeId](pending);
        assert.equal(typeof passed,'boolean',nodeId);
        record(pending,{outcome:'succeeded',evidence:{passed}});
        frame=await complete({runId,requestId,kind,outcome:'succeeded',result:{passed}},{},binding);
        continue;
      }
      assert.equal(kind,'action');
      const {operationKey}=task;
      const inputHash=sha256Bytes(canonicalBytes(task));
      const claim=await binding.operationController.claim({runId,requestId,operationKey,inputHash},worker);
      assert.equal(claim.claimed,true,'Unexpected duplicate execution '+nodeId);
      const output=await handlers.actions[nodeId](pending);
      const detail=Object.hasOwn(output,'evidence')?output.evidence:output;
      const result={set:output.set??{}};
      if(output.failure) {
        const failed={runId,requestId,kind,operationKey,outcome:'failed',error:output.failure};
        await assert.rejects(complete({...failed,error:{...output.failure,sideEffectStatus:'unknown'}},{},binding),{code:'FK_I_INVALID_OPERATION'});
        frame=await reopen(nodeId+'-unsettled-reopen',frame);
        const effect=output.failure.sideEffectStatus==='known'?'applied':'no-effect';
        await binding.operationController.settle({runId,operationKey,inputHash,effect,evidenceHash:hash(detail),result:output.failure},worker);
        record(pending,{outcome:'failed',evidence:detail,error:output.failure,operationKey});
        frame=await complete(failed,{},binding);
      } else {
        await binding.operationController.settle({runId,operationKey,inputHash,effect:claim.readOnly?'no-effect':'applied',evidenceHash:hash(detail),result},worker);
        record(pending,{outcome:'succeeded',evidence:detail,operationKey});
        frame=await complete({runId,requestId,kind,operationKey,outcome:'succeeded',result},{},binding);
        if (output.artifacts) await register(pending,output.artifacts);
      }
    }
    assert.equal(frame.terminal?.nodeId,suite.terminal,JSON.stringify(frame));
    const final=await worker.readTerminalResult(frame.resultRef,binding);
    const view=await observer.readRunView(rootRef,binding);
    assert.equal(view.status,frame.status);
    assert.equal(JSON.stringify(view).includes('host-only-reference-marker'),false);
    const artifacts=await observer.readRunArtifacts({ref:rootRef},binding);
    await assert.rejects(binding.artifactController.registerVersion({runId:frame.runId},observer),{code:'FK_I_HOST_DENIED'});
    assert.equal(JSON.stringify(artifacts).includes('storageRef'),false);
    for(const entry of journal.artifacts()) {
      const intact=await target.hashFile(entry.storageRef)===entry.contentHash;
      assert.equal(intact,!(suite.archiveDenied&&entry.artifactId==='delivery'),entry.artifactId);
    }
    const events=[];
    for(let cursor=-1;cursor<frame.revision;) {
      const page=await observer.listRunViewEvents({ref:rootRef,afterRevision:cursor,limit:100},binding);
      assert.ok(page.cursor>cursor);
      events.push(...page.events);
      cursor=page.cursor;
    }
    assert.equal(events.length,frame.revision+1);
    const snapshot=target.current();
    const mutations=target.record().map(row=>row.kind);
    if(suite.terminal==='done') {
      assert.deepEqual(view.publicOutput,{delivery:await target.hashFile(target.auditPath)});
      assert.deepEqual(mutations,['stage','canary','promote']);
      assert.equal(snapshot.traffic,100);
    } else assert.equal(Object.hasOwn(final,'publicOutput'),false);
    if(suite.terminal==='rolled-back') assert.deepEqual(mutations,['stage','canary','restore']);
    if(suite.rollbackDenied||suite.restoreError) assert.deepEqual(mutations,['stage','canary']);
    if(suite.canaryPostWrite) assert.equal(snapshot.traffic,suite.rollbackDenied||suite.restoreError?10:0);
    const records=evidence.prepare('SELECT request,node,entry FROM receipt ORDER BY rowid').all().map(row=>({...row,entry:JSON.parse(row.entry)}));
    await writeFile(path.join(root,'trace.json'),JSON.stringify({identity:compiled.programIdentity,ref:rootRef,frame,view,events,artifacts,records,
      observations:evidence.prepare('SELECT * FROM observation ORDER BY rowid').all(),target:snapshot,mutations},null,2));
    const result={scenario:suite.name,terminal:suite.terminal,status:frame.status,runId:frame.runId,revision:frame.revision,receipts:records.length,
      reopen:notes,mutations,declaredTasks:[...new Set([...records.map(row=>row.node),...events.flatMap(event=>event.nodeId?[event.nodeId]:[])])],evidence:root};
    reports.push(result);
    const {declaredTasks:_declaredTasks,...summary}=result;
    console.log(JSON.stringify(summary));
  } finally {binding.close();evidence.close();}
}

const visited=new Set(reports.flatMap(result=>[...result.declaredTasks,result.terminal]));
const missing=compiled.graphSnapshot.nodes.map(node=>node.id).filter(id=>!visited.has(id));
if(!selected.length) assert.deepEqual(missing,[],'All declared nodes need evidence across the reference paths');
await writeFile(path.join(bundleOut,'verification.json'),JSON.stringify({program:compiled.programIdentity,graphDigest:compiled.graphSnapshot.graphDigest,
  declaredNodes:compiled.graphSnapshot.nodes.length,visited:visited.size,missing,reports},null,2));
console.log(JSON.stringify({complete:!missing.length,visited:visited.size,scenarios:reports.length,evidence:bundleOut}));
