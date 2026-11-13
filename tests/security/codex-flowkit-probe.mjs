import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {
  compileInteractive,createAgentReceiptStatement,createSqliteCheckpointStore,
  createTrustedInteractiveHost,encodeAgentReceiptStatement,
} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';

const [exe,cwd,out,requested='loop',profile='direct',scenarioDir,answer,cut,scenarioBytes]=process.argv.slice(2);
const scenario=['outbox-worker','outbox-recover','outbox-setup','outbox-next','outbox-replay'].includes(requested);
const worker=requested==='outbox-worker';
const offline=scenario&&!worker;
const rotation=cut==='rotate-old'||cut==='rotate-new';
const runRecord=cut==='rotate-new'?'run-next.json':'run.json';
const fallback=requested.startsWith('file-') || (scenario && scenarioBytes!==undefined);
const artifactSize=fallback?Number(scenario?scenarioBytes:requested.slice(5)):0;
const size=requested==='loop'||fallback||scenario?0:Number(requested);
assert.ok(path.isAbsolute(exe) && path.isAbsolute(cwd) && path.isAbsolute(out));
assert.ok([0,65536,262144,2093056].includes(size));
assert.ok(!fallback||[262144,2093056].includes(artifactSize));
assert.ok(['direct','isolated'].includes(profile));
mkdirSync(out,{recursive:false});
const nonce=randomUUID();
const bodyLength=size===0?0:size-Buffer.byteLength(JSON.stringify({nonce,payload:''}));
const expectedBytes=size===0?null:canonicalBytes({nonce,payload:'A'.repeat(bodyLength)});
const record=(file,data)=>appendFileSync(path.join(out,file),data);
const journal=(event,details={})=>record('observer.ndjson',JSON.stringify({event,at:Date.now(),...details})+'\n');
const objectSchema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'};
const tool=(name,description,inputSchema)=>({type:'function',name,description,inputSchema});
const specs=size ? [tool('flowkit_inline','Measure an inline synthetic payload',objectSchema({nonce:str,payload:str}))] : [
  tool('flowkit_start','Start the one provisioned synthetic FlowKit Run and return the current public task',objectSchema({nonce:str})),
  fallback?tool('flowkit_submit_file','Submit the Host-issued artifact reference for the exact current FlowKit request',
    objectSchema({requestId:str,id:str}))
    :tool('flowkit_submit','Submit the answer for the exact current FlowKit request',objectSchema({requestId:str,answer:str})),
  tool('flowkit_continue','Read the public terminal state of the provisioned Run',objectSchema({runId:str})),
];
const fixture=scenario?scenarioDir:size?null:await mkdtemp(path.join(tmpdir(),'flowkit-codex-evidence-'));
if (scenario) assert.ok(path.isAbsolute(fixture));
if (worker) assert.ok(process.send && ['alpha','beta','ready'].includes(answer)
  && (!cut || ['after-cas','before-sign','expire','rotate-old','rotate-new'].includes(cut)));
let store,host,program,frame,currentTask,handoff,staged,outbox;
const appArgs=['app-server','--listen','stdio://','-c','web_search="disabled"'];
let command=exe,args=appArgs;
let hostSid;
if (profile==='isolated'&&!offline) {
  const node=process.execPath;
  // A pre-authorized, fixture-only launcher must enforce the model uid/gid and
  // pass only stdio. This probe never acquires or transfers account credentials.
  command=process.env.FLOWKIT_CODEX_LAUNCHER;
  assert.ok(path.isAbsolute(command));
  const sshConfig=process.env.FLOWKIT_CODEX_SSH_CONFIG;
  if (process.platform==='linux') {
    const modelUid=Number(process.env.FLOWKIT_MODEL_UID), modelGid=Number(process.env.FLOWKIT_MODEL_GID);
    const hostUid=Number(process.env.FLOWKIT_HOST_UID), hostGid=Number(process.env.FLOWKIT_HOST_GID);
    assert.ok([hostUid,hostGid,modelUid,modelGid].every(id=>Number.isSafeInteger(id)&&id>0));
    assert.notEqual(hostUid,modelUid);
    assert.notEqual(hostGid,modelGid);
    assert.equal(process.getuid(),hostUid);
    assert.equal(process.getgid(),hostGid);
    const modelExec=process.env.FLOWKIT_CODEX_LINUX_EXEC;
    if (!sshConfig) assert.ok(path.isAbsolute(modelExec));
    args=[node,fileURLToPath(new URL('./codex-model-identity.mjs',import.meta.url)),String(modelUid),String(modelGid),
      modelExec,exe,...appArgs];
  } else {
    assert.equal(process.platform,'win32');
    assert.ok(process.env.FLOWKIT_HOST_SID && process.env.FLOWKIT_MODEL_SID
      && process.env.FLOWKIT_HOST_SID!==process.env.FLOWKIT_MODEL_SID);
    const identityHelper=process.env.FLOWKIT_CODEX_WINDOWS_IDENTITY;
    assert.ok(path.isAbsolute(identityHelper));
    hostSid=execFileSync(identityHelper,['--host-identity'],{encoding:'utf8',timeout:5000,windowsHide:true}).trim();
    assert.equal(hostSid,process.env.FLOWKIT_HOST_SID);
    args=[exe,...appArgs];
  }
  if (sshConfig) {
    assert.ok(path.isAbsolute(sshConfig) && ['ssh','ssh.exe'].includes(path.basename(command).toLowerCase()));
    args=['-F',sshConfig,'-T','-o','HostName=127.0.0.1','-o','BatchMode=yes',
      '-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ForwardAgent=no',
      '-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ProxyCommand=none',
      '-o','ProxyJump=none','-o','ControlMaster=no','-o','ControlPath=none','flowkit-model'];
  }
}
const child=offline?null:spawn(command,args,
  {cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
child?.stdin.on('error',()=>{});
const pending=new Map(),starts=new Map(),completed=new Set(),successful=[];
let seq=0,threadId,turnId,turnStatus,failure,inlineObserved;
let finish;
const finished=new Promise(resolve=>{finish=resolve;});
let recordIdentity;
const identityReady=new Promise(resolve=>{recordIdentity=resolve;});
child?.on('error',error=>{failure=error.message;finish('spawn-error');});
child?.on('close',code=>{journal('exit',{code});finish('closed');});
child?.stdout.on('data',buffer=>record('app-server.stdout.ndjson',buffer));
child?.stderr.on('data',buffer=>record('app-server.stderr',buffer));
const timer=offline?null:setTimeout(()=>finish('timeout'),size?95000:65000);

function send(message) {
  record('app-server.requests.ndjson',JSON.stringify(message)+'\n');
  child.stdin.write(JSON.stringify(message)+'\n');
}
function request(method,params) {
  const id=++seq;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method,params});});
}

async function prepareFlowKit() {
  const file=path.join(fixture,'probe.workflow.js');
  if (!scenario || requested==='outbox-setup') await writeFile(file,`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'codex-probe',version:'1.0.0',name:'Codex probe',nodes:[
node('review',{name:'Review',agent:'reviewer',inputs:['question'],
output:{type:'object',properties:${fallback?'{artifact:{type:"object"}}':"{answer:{type:'string'}}"}},retries:0,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  program=await compileInteractive(file,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(program.programIdentity,JSON.stringify(program.diagnostics));
  store=createSqliteCheckpointStore(path.join(fixture,'run.sqlite'),{namespace:'codex-proof'});
  let publicKey,privateKey;
  if (!scenario || requested==='outbox-setup') {
    ({publicKey,privateKey}=generateKeyPairSync('ed25519'));
    if (scenario) {
      await writeFile(path.join(fixture,'proof.public.pem'),publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
      await writeFile(path.join(fixture,'proof.private.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
  } else {
    publicKey=createPublicKey(await readFile(path.join(fixture,'proof.public.pem')));
    if (worker) privateKey=createPrivateKey(await readFile(path.join(fixture,
      cut==='rotate-new'?'next.private.pem':'proof.private.pem')));
  }
  const trustedPublicKeys={proof:publicKey};
  if (rotation) {
    if (requested==='outbox-setup') {
      const next=generateKeyPairSync('ed25519');
      await writeFile(path.join(fixture,'next.public.pem'),next.publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
      await writeFile(path.join(fixture,'next.private.pem'),next.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
    trustedPublicKeys.next=createPublicKey(await readFile(path.join(fixture,'next.public.pem')));
  }
  if (fallback) {
    const inbox=path.join(fixture,'inbox');
    await mkdir(inbox,{mode:0o700,recursive:true});
    handoff=createFileHandoff({inbox,database:path.join(fixture,'file-handoff.sqlite'),
      validateArtifact:value=>Object.keys(value).length===1 && typeof value.answer==='string'});
  }
  host=createTrustedInteractiveHost({
    store, runtime:{skillResolver:async()=> 'Read the public question and submit its requested answer.',
      validateResult:(_schema,value)=>fallback ? validateArtifactResult(value)
        : (scenario?['alpha','beta','ready'].includes(value.answer):value.answer==='ready')?[]:['Unexpected answer']},
    trustedPublicKeys,trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:['question'],disclosurePolicyId:'probe-v1',authorizeDisclosure:()=>true,
    authorizeTerminalAccess:({action})=>action==='run:read',
  });
  if (scenario) outbox=openCodexOutbox({database:path.join(fixture,'outbox.sqlite'),store,host,handoff});
  return privateKey;
}

let key;
function validateArtifactResult(value) {
  if (!scenario) return value.artifact?.id===staged?.id?[]:['Expected staged reference'];
  const artifact=value.artifact;
  const snapshot=artifact && handoff.readSnapshot(artifact.id);
  return snapshot && ['claimed','acked'].includes(snapshot.state) && snapshot.byteLength===artifact.byteLength
    && snapshot.sha256===artifact.sha256 ? [] : ['Expected claimed snapshot'];
}

async function acceptResult(result,identity,pending=currentTask) {
  const receipt={runId:pending.runId,requestId:pending.requestId,nodeId:pending.nodeId,
    attempt:pending.attempt,kind:'agent-result',result};
  const issuedAt=Date.now();
  const statement=createAgentReceiptStatement({run:store.load(receipt.runId),receipt,keyId:'proof',
    proofId:identity.callId,issuedAt,expiresAt:issuedAt+30000});
  const statementBytes=encodeAgentReceiptStatement(statement);
  journal('signing',{callId:identity.callId,requestId:receipt.requestId,toolInputDigest:identity.digest,
    statementDigest:sha256Bytes(statementBytes),...(result.artifact?{artifact:result.artifact}:{})});
  const signature=sign(null,statementBytes,key).toString('base64url');
  frame=await host.accept({receipt,attestation:{statement,signature}});
  journal('accepted',{acceptedRevision:frame.acceptedRevision,revision:frame.revision,runId:frame.runId,
    receipt:store.getReceipt(frame.runId,receipt.requestId)});
  return {runId:frame.runId,acceptedRevision:frame.acceptedRevision};
}

async function deliverCandidate(result,name,args,identity,started) {
  const receipt={runId:currentTask.runId,requestId:currentTask.requestId,nodeId:currentTask.nodeId,
    attempt:currentTask.attempt,kind:'agent-result',result};
  const details={threadId,turnId,callId:identity.callId,hostPid:process.pid,
    modelPid:isolatedIdentity?.pid??child.pid,requestId:currentTask.requestId};
  const proofId=await outbox.record({task:currentTask,modelPid:details.modelPid,
    started:{...started,callId:identity.callId,args:started.arguments},
    callback:{...identity,tool:name,args}},receipt,key,{
    keyId:cut==='rotate-new'?'next':'proof',
    ttlMs:cut==='expire'?3000:cut==='rotate-old'?15000:120000,
    afterObserve:cut==='before-sign'?async observed=>{
      journal('outbox-before-sign',{...details,...observed});
      process.send({event:'observed',...details,...observed});
      await new Promise(()=>{});
    }:undefined,
  });
  const signed=outbox.describe(proofId);
  const detail={...details,...signed,
    ...(result.artifact?{artifact:result.artifact}:{})};
  const release=new Promise(resolve=>process.once('message',resolve));
  journal('outbox-signed',{...identity,...detail});
  process.send({event:'signed',...detail});
  assert.equal(await release,'deliver');
  const afterAccept=cut==='after-cas'?async ack=>{
    journal('outbox-after-cas',{proofId,ack});
    process.send({event:'committed',proofId,ack,hostPid:process.pid});
    // Keep the exact post-CAS cut open until the independent supervisor kills this Host.
    await new Promise(()=>{});
  }:undefined;
  try {frame=await outbox.deliver(proofId,{afterAccept});}
  catch (error) {
    if (error.code!=='FK_I_RECEIPT_CONFLICT') throw error;
    return {conflict:true,...outbox.describe(proofId)};
  }
  return {runId:frame.runId,...outbox.describe(proofId)};
}

async function handleTool(name,args,identity,started) {
  if (size) {
    const canonical=canonicalBytes(args);
    inlineObserved={expected:size,received:canonical.byteLength,matched:canonical.equals(expectedBytes),
      expectedDigest:sha256Bytes(expectedBytes),receivedDigest:sha256Bytes(canonical)};
    journal('inline-comparison',inlineObserved);
    assert.ok(inlineObserved.matched,'complete inline JSON differs from exact target');
    return {bytes:canonical.byteLength};
  }
  if (name==='flowkit_start') {
    assert.ok(!worker || fallback);
    assert.equal(args.nonce,nonce);
    if (worker) assert.equal(staged,undefined);
    else {
      assert.equal(frame,undefined);
      frame=await host.start({programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,
        startKey:nonce,state:{question:'Return the word ready.',privateMarker:'host-only synthetic marker'}});
      currentTask=await host.getPublicAgentTask({runId:frame.runId});
    }
    journal('pending', {runId:frame.runId,requestId:currentTask.requestId,revision:frame.revision,
      programHash:program.programIdentity.artifactHash,taskDigest:sha256Bytes(canonicalBytes(currentTask))});
    if (!fallback) return currentTask;
    const sourceId=randomUUID();
    const bytes=canonicalBytes({answer:'A'.repeat(artifactSize-13)});
    assert.equal(bytes.length,artifactSize);
    const ingress=path.join(fixture,'inbox',sourceId+'.json');
    await writeFile(ingress,bytes,{mode:0o600,flag:'wx'});
    const checkpoint=store.load(frame.runId);
    staged=await handoff.stage({sourceId,byteLength:bytes.length,sha256:sha256Bytes(bytes),
      binding:{namespace:store.namespace,runId:frame.runId,requestId:currentTask.requestId,
        nodeId:currentTask.nodeId,attempt:currentTask.attempt,threadId:identity.threadId,turnId:identity.turnId,
        programHash:checkpoint.artifactHash,policyHash:checkpoint.policyHash}});
    // The inbox is no longer needed once the private BLOB is committed.
    await rm(ingress);
    journal('file-staged',{...staged,byteLength:bytes.length,sha256:sha256Bytes(bytes),producer:'trusted-synthetic-fixture'});
    return {task:currentTask,fileReference:staged};
  }
  if (name==='flowkit_submit') {
    if (worker) {
      assert.deepEqual(args,{requestId:currentTask.requestId,answer});
      return deliverCandidate({answer},name,args,identity,started);
    }
    assert.equal(frame?.status,'waiting');
    assert.equal(args.requestId,currentTask.requestId);
    return acceptResult({answer:args.answer},identity);
  }
  if (name==='flowkit_submit_file') {
    return handoff.consume({
      started:{...started,callId:identity.callId},callback:{...identity,tool:name,arguments:args},
      loadPending:store.load,signAndAccept:({artifact,pending})=>worker
        ?deliverCandidate({artifact},name,args,identity,started):acceptResult({artifact},identity,pending),
    });
  }
  assert.equal(name,'flowkit_continue');
  assert.equal(args.runId,frame?.runId);
  const final=await host.getPublicTerminalFrame({runId:args.runId});
  assert.equal(final.status,'succeeded');
  if (fallback) {
    const snapshot=handoff.readSnapshot(staged.id);
    assert.equal(snapshot.state,'acked');
    assert.equal(snapshot.byteLength,artifactSize);
    assert.deepEqual(frame.state.artifact,{id:staged.id,byteLength:artifactSize,sha256:snapshot.sha256});
    journal('file-ack',{id:staged.id,byteLength:snapshot.byteLength,sha256:snapshot.sha256,
      acceptedRevision:snapshot.acceptedRevision});
  } else assert.equal(frame.state.answer,'ready');
  const rows=store.listJournal(frame.runId);
  assert.equal(rows.length,frame.revision+1);
  journal('terminal',{status:final.status,revision:final.revision,journalRows:rows.length,
    checkpointHash:rows.at(-1).checkpointHash});
  return final;
}

const lines=child&&createInterface({input:child.stdout});
lines?.on('line',line=>{
  let message;
  try {message=JSON.parse(line);} catch {failure='invalid JSONL';finish('protocol-error');return;}
  if (message.id!==undefined && !message.method) {
    const waiter=pending.get(message.id);
    pending.delete(message.id);
    if(message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result);
    return;
  }
  const p=message.params;
  if(message.method==='item/started' && p.item.type==='dynamicToolCall') {
    starts.set(p.item.id,{threadId:p.threadId,turnId:p.turnId,tool:p.item.tool,arguments:p.item.arguments});
    journal('tool-start',{callId:p.item.id,threadId:p.threadId,turnId:p.turnId,tool:p.item.tool});
  } else if(message.method==='item/completed' && p.item.type==='dynamicToolCall') {
    completed.add(p.item.id);
  } else if (message.method==='item/tool/call') {
    void (async()=>{
      const started=starts.get(p.callId);
      try {
        assert.ok((profile==='direct'||isolatedIdentity) && started && !completed.has(p.callId) && p.threadId===threadId && p.turnId===turnId
          && started.threadId===threadId && started.turnId===turnId && started.tool===p.tool);
        const args=canonicalBytes(p.arguments);
        assert.ok(args.equals(canonicalBytes(started.arguments)));
        assert.ok(specs.some(spec=>spec.name===p.tool));
        starts.delete(p.callId);
        const identity={callId:p.callId,threadId,turnId,digest:sha256Bytes(args),bytes:args.byteLength};
        journal('tool-callback',identity);
        const result=await handleTool(p.tool,p.arguments,identity,started);
        if (worker && p.tool!=='flowkit_start') {
          journal('outbox-delivered',result);
          process.send({event:'delivered',...result});
        }
        successful.push(p.tool);
        send({id:message.id,result:{success:!result.conflict,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
      } catch(error) {
        failure=error.message;
        journal('rejected',{callId:p.callId,code:error.code,detail:error.message});
        send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'Rejected fixture submission'}]}});
      }
    })();
  } else if(message.id!==undefined && message.method) {
    send({id:message.id,error:{code:-32601,message:'Unexpected server request'}});
  } else if(message.method==='turn/completed') {
    turnStatus=p.turn.status;
    if (p.turn.error) failure=p.turn.error.message;
    finish('turn-completed');
  } else if(message.method==='flowkit/profile/identity' && profile==='isolated') {
    const reported=p;
    try {
      assert.equal(isolatedIdentity,undefined);
      assert.ok(Number.isSafeInteger(reported.pid) && reported.pid>1);
      if (process.platform==='linux') {
        assert.equal(reported.uid,Number(process.env.FLOWKIT_MODEL_UID));
        assert.equal(reported.gid,Number(process.env.FLOWKIT_MODEL_GID));
        assert.ok(reported.groups.every(group=>group===reported.gid));
        assert.match(reported.capabilities,/^0+$/);
        assert.equal(reported.noNewPrivs,'1');
      } else {
        assert.equal(reported.modelSid,process.env.FLOWKIT_MODEL_SID);
        assert.equal(reported.modelElevated,false);
        assert.equal(reported.stdioAllowlist,true);
      }
      isolatedIdentity=reported;
      journal('isolated-identity',{...reported,hostUid:process.getuid?.(),hostGid:process.getgid?.(),hostSid,
        ...(hostSid?{hostElevated:false}:{})});
      recordIdentity();
    } catch(error) {failure=error.message;finish('identity-error');}
  }
});
let isolatedIdentity;

async function run() {
  if (profile==='isolated') await identityReady;
  if (!size) key=await prepareFlowKit();
  if (worker) {
    const {runId}=JSON.parse(await readFile(path.join(fixture,runRecord),'utf8'));
    currentTask=await host.getPublicAgentTask({runId});
    frame=store.load(runId);
  }
  await request('initialize',{clientInfo:{name:'flowkit-acceptance',title:'FlowKit acceptance',version:'0.1.0'},
    capabilities:{experimentalApi:true}});
  send({method:'initialized'});
  const {data}=await request('model/list',{limit:30,includeHidden:false});
  const model=data.find(entry=>entry.isDefault)?.model ?? data[0]?.model;
  const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
    multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},
    dynamicTools:worker?specs.filter(spec=>fallback?spec.name!=='flowkit_continue':spec.name==='flowkit_submit'):specs});
  threadId=thread.id;
  const prompt=worker&&fallback
    ? 'Call flowkit_start with nonce "'+nonce+'". Read its fileReference and call flowkit_submit_file once with its exact id and requestId. Then finish.'
    : worker
    ? 'Call the dynamic tool flowkit_submit exactly once with requestId "'+currentTask.requestId
      +'" and answer "'+answer+'". Use the dynamic tool, then finish.'
    : size
    ? `Call flowkit_inline exactly once with nonce "${nonce}" and payload containing exactly ${bodyLength} uppercase ASCII A characters as one JSON string. Supply complete inline JSON, without using files, references, code, other tools or a placeholder. If impossible, say so and finish.`
    : fallback
      ? `Call flowkit_start with nonce "${nonce}". Take fileReference.id and fileReference.requestId from its reply, then call flowkit_submit_file with those exact two values. Call flowkit_continue with the returned runId. Use only those three tools.`
      : `Only call the three FlowKit tools. Call flowkit_start with nonce "${nonce}". Read its public question and call flowkit_submit using its exact requestId and the answer. Then call flowkit_continue with the runId returned by submit and finish.`;
  const {turn}=await request('turn/start',{threadId,input:[{type:'text',text:prompt}]});
  turnId=turn.id;
  journal('turn',{model,threadId,turnId,requestedBytes:size,pid:isolatedIdentity?.pid??child.pid,
    launcherPid:child.pid,observerPid:process.pid});
  return finished;
}
try {
  if (offline) await runOutboxOffline();
  else {
  const outcome=await Promise.race([run(),finished]);
  const expected=worker?(fallback?['flowkit_start','flowkit_submit_file']:['flowkit_submit'])
    :size?['flowkit_inline']:['flowkit_start',fallback?'flowkit_submit_file':'flowkit_submit','flowkit_continue'];
  const passed=outcome==='turn-completed' && turnStatus==='completed' && !failure
    && JSON.stringify(successful)===JSON.stringify(expected) && completed.size===expected.length
    && (profile==='direct'||!!isolatedIdentity);
  console.log(JSON.stringify({passed,outcome,turnStatus,requestedBytes:size,artifactSize,profile,successful,inlineObserved,failure}));
  if(!passed)process.exitCode=1;
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {
  clearTimeout(timer);
  child?.stdin.end();
  if (child&&child.exitCode===null && child.signalCode===null) {
    if (profile==='isolated') {
      // The external launcher owns cleanup across OS identities.
      journal('launcher-cleanup',{pid:child.pid,method:'stdio-eof'});
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    } else child.kill();
  }
  handoff?.close();
  outbox?.close();
  store?.close();
  if(fixture&&!scenario) await rm(fixture,{recursive:true,force:true});
  if (worker&&process.connected) process.disconnect();
}

async function runOutboxOffline() {
  await prepareFlowKit();
  if (requested==='outbox-setup'||requested==='outbox-next') {
    frame=await host.start({programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,
      startKey:nonce,state:{question:'Submit the assigned answer.'}});
    const task=await host.getPublicAgentTask({runId:frame.runId});
    await writeFile(path.join(fixture,runRecord),JSON.stringify({runId:frame.runId,requestId:task.requestId}),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({runId:frame.runId,requestId:task.requestId,revision:frame.revision}));
    return;
  }
  const {runId,requestId}=JSON.parse(await readFile(path.join(fixture,runRecord),'utf8'));
  const before=store.load(runId);
  const beforeReceipt=store.getReceipt(runId,requestId);
  if (requested==='outbox-replay') {
    const replay=await outbox.deliver(answer);
    console.log(JSON.stringify({runId:replay.runId,acceptedRevision:replay.acceptedRevision,
      receipt:store.getReceipt(runId,requestId),status:replay.status}));
    return;
  }
  const recovered=await outbox.recover(runId);
  assert.deepEqual(await outbox.recover(runId),[]);
  const after=store.load(runId);
  console.log(JSON.stringify({runId,before:{status:before.status,revision:before.revision,receipt:beforeReceipt},
    recovered,after:{status:after.status,revision:after.revision,answer:after.state.answer,
      journalRows:store.listJournal(runId).length,receipt:store.getReceipt(runId,requestId)}}));
}
