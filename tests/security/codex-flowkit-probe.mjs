import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {
  compileInteractive,createAgentReceiptStatement,createSqliteCheckpointStore,
  createTrustedInteractiveHost,encodeAgentReceiptStatement,
} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {createCodexOsAccess} from '../../examples/interactive/codex-os-access.mjs';

const [exe,cwd,out,requested='loop',profile='direct',scenarioDir,answer,cut,scenarioBytes]=process.argv.slice(2);
const scenario=['outbox-worker','outbox-recover','outbox-setup','outbox-next','outbox-replay',
  'outbox-check-revocation','release-check','release-revoke','release-clean','ops-clean'].includes(requested);
const worker=requested==='outbox-worker';
const offline=scenario&&!worker;
const osEntry=['os-stdio','os-file'].includes(requested);
const entry=requested==='entry-r5'||osEntry;
const branch=requested.startsWith('branch-')?requested.slice(7):null;
assert.ok(branch===null || ['approved','refused','closed','missing'].includes(branch));
const rotation=['rotate-old','rotate-new','rotate-old-next'].includes(cut);
const revoked=['revoked-old','revoked-pending','revoked-new'].includes(cut);
const nextSigner=cut==='rotate-new'||cut==='revoked-new';
const runRecord=['rotate-new','rotate-old-next','revoked-pending','release-cap-next','release-byte-next'].includes(cut)?'run-next.json'
  :cut==='revoked-new'?'run-new.json':'run.json';
const osFile=requested==='os-file';
const fallback=requested.startsWith('file-') || (scenario && scenarioBytes!==undefined);
const clearArtifact=cut==='ops-clear';
const artifactSize=fallback?Number(scenario?scenarioBytes:requested.slice(5)):0;
const size=requested==='loop'||fallback||scenario||branch||entry?0:Number(requested);
assert.ok(path.isAbsolute(exe) && path.isAbsolute(cwd) && path.isAbsolute(out));
assert.ok([0,65536,262144,2093056].includes(size));
assert.ok(!fallback||[262144,2093056].includes(artifactSize));
assert.ok(['direct','isolated'].includes(profile));
if (entry) assert.equal(profile,'isolated');
mkdirSync(out,{recursive:false});
const nonce=randomUUID();
const bodyLength=size===0?0:size-Buffer.byteLength(JSON.stringify({nonce,payload:''}));
const expectedBytes=size===0?null:canonicalBytes({nonce,payload:'A'.repeat(bodyLength)});
const record=(file,data)=>appendFileSync(path.join(out,file),data);
const journal=(event,details={})=>record('observer.ndjson',JSON.stringify({event,at:Date.now(),...details})+'\n');
const objectSchema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'};
const tool=(name,description,inputSchema)=>({type:'function',name,description,inputSchema});
const branchFields={requirementId:str,designId:str,planId:str,reviewApproved:{type:'boolean'}};
const branchNodes=['requirements','design','plan','review'];
const branchInputKeys=['request','requirementId','designId','planId'];
const branchOutputs={requirementId:'REQ-001',designId:'DES-001',planId:'PLAN-001',reviewApproved:branch==='approved'};
const branchMarker='HOST-PRIVATE-BRANCH-FIXTURE';
const specs=size ? [tool('flowkit_inline','Measure an inline synthetic payload',objectSchema({nonce:str,payload:str}))] : [
  tool('flowkit_start','Start the one provisioned synthetic FlowKit Run and return the current public task',objectSchema({nonce:str})),
  fallback?tool('flowkit_submit_file','Submit the Host-issued artifact reference for the exact current FlowKit request',
    objectSchema({requestId:str,id:str}))
    :tool('flowkit_submit','Submit the result for the exact current FlowKit request',objectSchema(branch
      ?{requestId:str,result:objectSchema(branchFields,[])}:{requestId:str,answer:str})),
  tool('flowkit_continue',branch?'Read the next public task or terminal frame':'Read the public terminal state of the provisioned Run',objectSchema({runId:str})),
];
const osTools=osFile?[
  tool('flowkit_file_task','Get the current Host-provisioned file task',objectSchema({})),
  tool('flowkit_submit_file','Submit the exact file reference returned by the Host',objectSchema({requestId:str,id:str})),
]:specs.filter(spec=>spec.name==='flowkit_submit');
const fixture=scenario?scenarioDir:size?null:await mkdtemp(path.join(tmpdir(),'flowkit-codex-evidence-'));
if (scenario) assert.ok(path.isAbsolute(fixture));
if (worker) assert.ok(process.send && ['alpha','beta','ready'].includes(answer)
  && (!cut || ['after-cas','before-sign','expire','rotate-old','rotate-new','rotate-old-next','revoked-new',
    'release-cap','release-cap-next','release-byte-next','release-after-receipt','ops-file','ops-clear'].includes(cut)));
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
let branchTurnDone,branchAccess='model',branchNegative;
const branchReceipts=[];
const entrySessions=new Map(),entryResources=new Map(),entryObservations=new Map();
let entryCase,entryDenial,entryDone,entryDelay,entryDatabase,entryObservationReady;
let entrySignatures=0;
let osAccess,osAuditSession,osFileDb;
const osTurns=new Map();
let osOverlap;
const observationWaitMs=500;
let finish;
const finished=new Promise(resolve=>{finish=resolve;});
let recordIdentity;
const identityReady=new Promise(resolve=>{recordIdentity=resolve;});
child?.on('error',error=>{failure=error.message;finish('spawn-error');});
child?.on('close',code=>{journal('exit',{code});finish('closed');});
child?.stdout.on('data',buffer=>record('app-server.stdout.ndjson',buffer));
child?.stderr.on('data',buffer=>record('app-server.stderr',buffer));
const timer=offline?null:setTimeout(()=>finish('timeout'),branch||entry?240000:size?95000:65000);

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
  if (branch) {
    const agents=branchNodes.map((id,index)=>{
      const field=Object.keys(branchFields)[index];
      return `node('${id}',{name:'${id}',agent:'${id}',inputs:['${branchInputKeys[index]}'],
        output:{type:'object',properties:{${field}:{type:'${branchFields[field].type}'}}},
        retries:0,next:'${branchNodes[index+1]??'decision'}'})`;
    });
    await writeFile(file,`import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'codex-branch-probe',version:'1.0.0',name:'Codex branch probe',nodes:[
condition('gate',{name:'Gate',branches:[{when:'ready',next:'requirements'},{when:'true',next:'declined'}]}),
${agents.join(',\n')},
condition('decision',{name:'Decision',branches:[{when:'reviewApproved',next:'done'},{when:'true',next:'declined'}]}),
terminal('done',{name:'Done',status:'succeeded'}),terminal('declined',{name:'Declined',status:'failed'})]});`);
  } else if (!scenario || requested==='outbox-setup') await writeFile(file,`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'codex-probe',version:'1.0.0',name:'Codex probe',nodes:[
node('review',{name:'Review',agent:'reviewer',inputs:['question'],
    output:{type:'object',properties:${fallback||osFile?'{artifact:{type:"object"}}':"{answer:{type:'string'}}"}},retries:0,next:'${cut==='ops-file'?'clear':'done'}'}),
${cut==='ops-file'?"node('clear',{name:'Clear completed reference',agent:'reviewer',inputs:['question'],output:{type:'object',properties:{artifact:{type:'null'}}},retries:0,next:'done'}),":''}
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  program=await compileInteractive(file,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(program.programIdentity,JSON.stringify(program.diagnostics));
  if (entry) return;
  store=createSqliteCheckpointStore(path.join(fixture,'run.sqlite'),{namespace:'codex-proof'});
  let publicKey,privateKey;
  if (!scenario || (requested==='outbox-setup' && cut!=='release-shared')) {
    ({publicKey,privateKey}=generateKeyPairSync('ed25519'));
    if (scenario) {
      await writeFile(path.join(fixture,'proof.public.pem'),publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
      await writeFile(path.join(fixture,'proof.private.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
  } else {
    publicKey=createPublicKey(await readFile(path.join(fixture,'proof.public.pem')));
    if (worker) privateKey=createPrivateKey(await readFile(path.join(fixture,
      nextSigner?'next.private.pem':'proof.private.pem')));
  }
  const trustedPublicKeys={proof:publicKey};
  if (rotation || revoked) {
    if (requested==='outbox-setup') {
      const next=generateKeyPairSync('ed25519');
      await writeFile(path.join(fixture,'next.public.pem'),next.publicKey.export({type:'spki',format:'pem'}),{mode:0o600,flag:'wx'});
      await writeFile(path.join(fixture,'next.private.pem'),next.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});
    }
    trustedPublicKeys.next=createPublicKey(await readFile(path.join(fixture,'next.public.pem')));
    if (revoked) delete trustedPublicKeys.proof;
  }
  if (fallback) {
    const inbox=path.join(fixture,'inbox');
    await mkdir(inbox,{mode:0o700,recursive:true});
    handoff=createFileHandoff({inbox,database:path.join(fixture,'file-handoff.sqlite'),
      validateArtifact:value=>Object.keys(value).length===1 && typeof value.answer==='string'});
  }
  host=createTrustedInteractiveHost({
    store, runtime:{skillResolver:async({nodeId})=>branch
      ?branchInstruction(nodeId):'Read the public question and submit its requested answer.',
      validateResult(schema,value) {
        if (branch) {
          const fields=Object.keys(schema.properties);
          return Object.keys(value).length===fields.length && fields.every(field=>Object.hasOwn(value,field)
            && value[field]===branchOutputs[field])?[]:['Unexpected branch result'];
        }
        if (worker && cut==='release-after-receipt') {
          journal('release-validation-barrier',{runId:currentTask.runId,requestId:currentTask.requestId});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
          throw new Error('Supervisor did not terminate Host at the validation barrier');
        }
        return clearArtifact ? (value.artifact===null?[]:['Expected cleared reference'])
          : fallback ? validateArtifactResult(value)
          : (scenario?['alpha','beta','ready'].includes(value.answer):value.answer==='ready')?[]:['Unexpected answer'];
      }},
    trustedPublicKeys,trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:branch?branchInputKeys:['question'],disclosurePolicyId:'probe-v1',authorizeDisclosure:()=>true,
    authorizeTerminalAccess:({action})=>action==='run:read'
      || (branch!==null && branchAccess==='auditor' && action==='result:read'),
    authorizeReceiptAudit:({action})=>offline && action==='receipt:read-history',
    authorizeKeyRevocation:({action})=>requested==='release-revoke' && cut!=='denied' && action==='host:revoke-key',
  });
  if (branch) await writeFile(path.join(out,'proof.public.pem'),publicKey.export({type:'spki',format:'pem'}));
  let cleanupHandoff=handoff;
  if (requested==='ops-clean' && cut==='after-unlink') {
    cleanupHandoff={...handoff,reclaimAcknowledged(...args) {
      assert.equal(handoff.reclaimAcknowledged(...args),true);
      stopAtCleanupCut();
    }};
  }
  if (scenario) outbox=openCodexOutbox({database:path.join(fixture,'outbox.sqlite'),store,host,handoff:cleanupHandoff,
    ...(cut.startsWith('release-cap') || requested==='release-clean'?{maxRecords:1,retentionMs:1}:{}),
    ...(requested==='ops-clean'?{retentionMs:1}:{}),
    ...(cut==='release-byte-next'?{maxRecords:100,maxBytes:1}:{}),
    authorizeCleanup:({subjectId})=>({allowed:['release-clean','ops-clean'].includes(requested) && subjectId==='operator',
      heldRunIds:cut==='held'?[answer]:[],
      ...(requested==='ops-clean'?{canDeleteSnapshot:({artifact,checkpoint})=>{
        if (cut==='after-queue') stopAtCleanupCut();
        return checkpoint?.status==='succeeded' && checkpoint.state.artifact===null
          && artifact.byteLength===artifactSize;
      }}:{}),
    }),
    onCapacity:usage=>journal('outbox-capacity-alert',usage),
  });
  return privateKey;
}

let key;
function branchInstruction(nodeId) {
  const index=branchNodes.indexOf(nodeId);
  assert.ok(index>=0);
  const field=Object.keys(branchFields)[index];
  const input=branchInputKeys[index];
  return `Verify ${input} is ${JSON.stringify(index===0?'software task':branchOutputs[input])}. If it matches, submit result ${JSON.stringify({[field]:branchOutputs[field]})}.`;
}
function stopAtCleanupCut() {
  process.send({event:'cleanup-cut',cut,hostPid:process.pid});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
  throw new Error('Supervisor did not stop cleanup at '+cut);
}
function validateArtifactResult(value) {
  if (!scenario && !osFile) return value.artifact?.id===staged?.id?[]:['Expected staged reference'];
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
  if (branch) {
    const indexed=store.getReceipt(frame.runId,receipt.requestId);
    assert.equal(indexed.acceptedRevision,frame.acceptedRevision);
    const proof={receipt,statement,signature,indexed,callId:identity.callId,threadId:identity.threadId,turnId:identity.turnId};
    branchReceipts.push(proof);
    journal('branch-proof',proof);
  }
  journal('accepted',{acceptedRevision:frame.acceptedRevision,revision:frame.revision,runId:frame.runId,
    receipt:store.getReceipt(frame.runId,receipt.requestId)});
  return {runId:frame.runId,acceptedRevision:frame.acceptedRevision};
}

async function deliverCandidate(result,name,args,identity,started) {
  const receipt={runId:currentTask.runId,requestId:currentTask.requestId,nodeId:currentTask.nodeId,
    attempt:currentTask.attempt,kind:'agent-result',result};
  const details={threadId,turnId,callId:identity.callId,hostPid:process.pid,
    modelPid:isolatedIdentity?.pid??child.pid,requestId:currentTask.requestId};
  let proofId;
  try {proofId=await outbox.record({task:currentTask,modelPid:details.modelPid,
    started:{...started,callId:identity.callId,args:started.arguments},
    callback:{...identity,tool:name,args}},receipt,key,{
    keyId:nextSigner?'next':'proof',
    ttlMs:cut==='expire'?3000:cut==='rotate-old'?15000:120000,
    afterObserve:cut==='before-sign'?async observed=>{
      journal('outbox-before-sign',{...details,...observed});
      process.send({event:'observed',...details,...observed});
      await new Promise(()=>{});
    }:undefined,
  });} catch(error) {
    if (!['release-cap-next','release-byte-next'].includes(cut) || error.code!=='FK_OUTBOX_CAPACITY') throw error;
    journal('release-capacity-rejected',{...details,code:error.code,usage:outbox.usage()});
    process.send({event:'capacity-rejected',...details,code:error.code,usage:outbox.usage()});
    return {conflict:true,code:error.code};
  }
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

function branchState() {
  const checkpoint=store.load(frame.runId);
  const journalRows=store.listJournal(frame.runId);
  return {checkpoint,journalRows,indexed:currentTask?store.getReceipt(frame.runId,currentTask.requestId):null};
}

async function branchView() {
  if (frame.status!=='waiting') return host.getPublicTerminalFrame({runId:frame.runId});
  currentTask=await host.getPublicAgentTask({runId:frame.runId});
  const index=branchReceipts.length;
  const field=branchInputKeys[index];
  assert.equal(currentTask.nodeId,branchNodes[index]);
  assert.equal(currentTask.runId,frame.runId);
  assert.deepEqual(currentTask.missing,[]);
  assert.deepEqual(currentTask.input,{[field]:index===0?'software task':branchOutputs[field]});
  assert.ok(!JSON.stringify(currentTask).includes(branchMarker));
  journal('branch-pending',{runId:currentTask.runId,requestId:currentTask.requestId,nodeId:currentTask.nodeId,
    revision:frame.revision,input:currentTask.input});
  return currentTask;
}

async function branchTool(name,args,identity) {
  if (name==='flowkit_start') {
    assert.equal(args.nonce,nonce);
    assert.equal(frame,undefined);
    const state={request:'software task',privateMarker:branchMarker};
    if (branch!=='missing') state.ready=branch!=='closed';
    frame=await host.start({programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,
      startKey:nonce,state});
    return branchView();
  }
  if (name==='flowkit_continue') {
    assert.equal(args.runId,frame.runId);
    return branchView();
  }
  assert.equal(name,'flowkit_submit');
  const before=branchState();
  if (args.requestId!==currentTask?.requestId) {
    assert.equal(branchNegative,'request');
    assert.deepEqual(branchState(),before);
    journal('branch-request-denied',{runId:frame.runId,callId:identity.callId,
      revision:before.checkpoint.revision,receiptCount:before.checkpoint.receiptCount,unchanged:true});
    return {conflict:true,code:'REQUEST_DENIED'};
  }
  assert.equal(branchNegative,undefined);
  assert.equal(frame.status,'waiting');
  const field=Object.keys(branchFields)[branchReceipts.length];
  assert.deepEqual(args.result,{[field]:branchOutputs[field]});
  return acceptResult(args.result,identity);
}

function denyEntry(code) {
  throw Object.assign(new Error(code),{code});
}

function captureEntryStart(p) {
  const observation={threadId:p.threadId,turnId:p.turnId,tool:p.item.tool,arguments:p.item.arguments};
  const callId=p.item.id;
  if (entryCase==='timeout') return;
  if (entryCase==='late') {
    entryDelay=()=>new Promise(resolve=>setTimeout(()=>{
      journal('entry-late-observation',{callId,threadId:p.threadId,turnId:p.turnId,discarded:true});
      resolve();
    },25));
    return;
  }
  if (entryCase==='mismatch') observation.arguments={...observation.arguments,answer:'different-fixture-value'};
  entryObservations.set(callId,observation);
  entryObservationReady?.();
}

async function submitEntry(p) {
  const context=entrySessions.get(p.threadId);
  if (!context || context.modelPid!==isolatedIdentity?.pid || p.threadId!==threadId || p.turnId!==turnId
    || p.tool!=='flowkit_submit' || completed.has(p.callId)) denyEntry('SESSION_DENIED');
  const target=entryResources.get(p.arguments.requestId);
  if (!target || target.namespace!==context.namespace || target.subject!==context.subject) denyEntry('TARGET_DENIED');
  const {store,task}=target;
  const checkpoint=store.load(task.runId);
  if (checkpoint.status!=='waiting' || checkpoint.pending?.requestId!==task.requestId) denyEntry('TARGET_DENIED');
  if (!entryObservations.has(p.callId)) {
    const begin=performance.now();
    await new Promise(resolve=>{
      const deadline=setTimeout(resolve,observationWaitMs);
      entryObservationReady=()=>{clearTimeout(deadline);resolve();};
    });
    entryObservationReady=undefined;
    if (!entryObservations.has(p.callId) || performance.now()-begin>=observationWaitMs) {
      journal('entry-observation-deadline',{callId:p.callId,waitedMs:performance.now()-begin,limitMs:observationWaitMs});
      denyEntry('OBSERVATION_TIMEOUT');
    }
  }
  const observed=entryObservations.get(p.callId);
  if (observed.threadId!==p.threadId || observed.turnId!==p.turnId || observed.tool!==p.tool
    || !canonicalBytes(observed.arguments).equals(canonicalBytes(p.arguments))) denyEntry('OBSERVATION_MISMATCH');
  assert.deepEqual(p.arguments,{requestId:task.requestId,answer:'ready'});
  return signEntry(target,p.callId,{answer:p.arguments.answer});
}

async function signEntry(target,callId,value) {
  const {store,task,host,key,publicKey}=target;
  const checkpoint=store.load(task.runId);
  const receipt={runId:task.runId,requestId:task.requestId,nodeId:task.nodeId,attempt:task.attempt,
    kind:'agent-result',result:value};
  const issuedAt=Date.now();
  const statement=createAgentReceiptStatement({run:checkpoint,receipt,keyId:'proof',proofId:callId,issuedAt,expiresAt:issuedAt+30000});
  const statementBytes=encodeAgentReceiptStatement(statement);
  const signature=sign(null,statementBytes,key);
  entrySignatures++;
  journal('entry-signed',{callId,subject:target.subject,namespace:target.namespace,receipt,statement,
    signature:signature.toString('base64url'),publicKey});
  const result=await host.accept({receipt,attestation:{statement,signature:signature.toString('base64url')}});
  const indexed=store.getReceipt(task.runId,task.requestId);
  assert.ok(verify(null,statementBytes,publicKey,signature));
  assert.equal(indexed.digest,statement.receiptHash);
  assert.equal(indexed.acceptedRevision,result.acceptedRevision);
  assert.equal(result.status,'succeeded');
  assert.equal(result.state.tenantMarker,target.namespace);
  journal('entry-accepted',{callId,subject:target.subject,namespace:target.namespace,indexed,revision:result.revision});
  return {accepted:true,revision:result.acceptedRevision,acceptedRevision:result.acceptedRevision};
}

async function osEntryCallback(message) {
  const p=message.params;
  const turn=osTurns.get(p.threadId);
  const context=entrySessions.get(p.threadId);
  const started=entryObservations.get(p.callId);
  assert.ok(turn && context?.modelPid===isolatedIdentity.pid && turn.id===p.turnId && started
    && started.threadId===p.threadId && started.turnId===p.turnId && started.tool===p.tool
    && !completed.has(p.callId) && canonicalBytes(started.arguments).equals(canonicalBytes(p.arguments)));
  entryObservations.delete(p.callId);
  turn.calls.push(p.tool);
  const target=entryResources.get(p.arguments.requestId);
  let result;
  try {
    if (p.tool==='flowkit_file_task') {
      osAccess.authorize(context.grant,'task:dispatch',turn.target.namespace);
      assert.equal(turn.target.subject,context.subject);
      const {store,task}=turn.target;
      const checkpoint=store.load(task.runId);
      const sourceId=randomUUID();
      const bytes=canonicalBytes({answer:'A'.repeat(262144-13)});
      assert.equal(bytes.length,262144);
      const source=path.join(fixture,'inbox',sourceId+'.json');
      await writeFile(source,bytes,{flag:'wx',mode:0o600});
      try {
        turn.ref=await handoff.stage({sourceId,byteLength:bytes.length,sha256:sha256Bytes(bytes),
          binding:{namespace:turn.target.namespace,runId:task.runId,requestId:task.requestId,nodeId:task.nodeId,
            attempt:task.attempt,threadId:p.threadId,turnId:p.turnId,programHash:checkpoint.artifactHash,policyHash:checkpoint.policyHash}});
      } finally {await rm(source);}
      result={accepted:true,...turn.ref};
    } else {
      if (!target || target.subject!==context.subject) denyEntry('FK_I_HOST_DENIED');
      osAccess.authorize(context.grant,'run:complete',target.namespace);
      assert.equal(target,turn.target);
      journal('os-ready-to-accept',{namespace:target.namespace,subject:context.subject,callId:p.callId});
      await osOverlap();
      if (osFile) {
        assert.equal(p.tool,'flowkit_submit_file');
        result=await handoff.consume({started:{...started,callId:p.callId},callback:{...p,arguments:p.arguments},
          loadPending:target.store.load,signAndAccept:({artifact})=>signEntry(target,p.callId,{artifact})});
      } else {
        assert.equal(p.tool,'flowkit_submit');
        assert.deepEqual(p.arguments,{requestId:target.task.requestId,answer:'ready'});
        result=await signEntry(target,p.callId,{answer:p.arguments.answer});
      }
    }
    assert.equal(turn.denial,false);
  } catch(error) {
    if (!turn.denial || error.code!=='FK_I_HOST_DENIED') throw error;
    result={accepted:false,code:'REQUEST_DENIED'};
    journal('os-entry-rejected',{case:turn.label,callId:p.callId,subject:context.subject,namespace:context.namespace,
      targetSubject:target?.subject,targetNamespace:target?.namespace,tool:p.tool});
  }
  send({id:message.id,result:{success:result.accepted,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
}

async function handleEntryCallback(message) {
  const p=message.params;
  const begin=performance.now();
  journal('entry-callback',{case:entryCase,callId:p.callId,threadId:p.threadId,turnId:p.turnId});
  let result;
  try {
    result=await submitEntry(p);
    assert.equal(entryDenial,undefined);
  } catch(error) {
    if (entryDenial===undefined || error.code!==entryDenial) {
      failure=error.message;
      journal('entry-unexpected',{callId:p.callId,code:error.code,detail:error.message});
    }
    journal('entry-rejected',{case:entryCase,callId:p.callId,code:error.code,elapsedMs:performance.now()-begin});
    result={accepted:false,code:'REQUEST_DENIED'};
  } finally {
    entryObservations.delete(p.callId);
  }
  assert.equal(entryDone,undefined);
  entryDone=result;
  successful.push(p.tool);
  send({id:message.id,result:{success:result.accepted,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
}

async function handleTool(name,args,identity,started) {
  if (branch) return branchTool(name,args,identity);
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
    if (clearArtifact) {
      assert.deepEqual(args,{requestId:currentTask.requestId,answer:'ready'});
      return acceptResult({artifact:null},identity);
    }
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
    if (entry) {captureEntryStart(p);return;}
    if (branchNegative!=='observation' || p.item.tool!=='flowkit_submit') {
      starts.set(p.item.id,{threadId:p.threadId,turnId:p.turnId,tool:p.item.tool,arguments:p.item.arguments});
    } else journal('branch-start-withheld',{callId:p.item.id,threadId:p.threadId,turnId:p.turnId});
    journal('tool-start',{callId:p.item.id,threadId:p.threadId,turnId:p.turnId,tool:p.item.tool});
  } else if(message.method==='item/completed' && p.item.type==='dynamicToolCall') {
    completed.add(p.item.id);
  } else if (message.method==='item/tool/call') {
    if (osEntry) {void osEntryCallback(message).catch(error=>{failure=error.message;finish('entry-error');});return;}
    if (entry) {void handleEntryCallback(message).catch(error=>{failure=error.message;finish('entry-error');});return;}
    void (async()=>{
      const started=starts.get(p.callId);
      try {
        assert.ok((profile==='direct'||isolatedIdentity) && !completed.has(p.callId) && p.threadId===threadId && p.turnId===turnId);
        assert.ok(started,'Missing Host observation');
        assert.ok(
          started.threadId===threadId && started.turnId===turnId && started.tool===p.tool);
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
        if (branchNegative==='observation' && p.tool==='flowkit_submit' && error.message==='Missing Host observation'
          && p.arguments.requestId===currentTask.requestId) {
          journal('branch-observation-denied',{callId:p.callId,threadId,turnId,requestId:currentTask.requestId});
          successful.push(p.tool);
          send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'Missing Host observation'}]}});
          return;
        }
        failure=error.message;
        journal('rejected',{callId:p.callId,code:error.code,detail:error.message});
        send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:'Rejected fixture submission'}]}});
      }
    })();
  } else if(message.id!==undefined && message.method) {
    send({id:message.id,error:{code:-32601,message:'Unexpected server request'}});
  } else if(message.method==='turn/completed') {
    if (osEntry) {osTurns.get(p.threadId)?.resolve(p.turn);return;}
    turnStatus=p.turn.status;
    if (p.turn.error) failure=p.turn.error.message;
    if (branch||entry) branchTurnDone();
    else finish('turn-completed');
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

async function branchTurn(model,prompt,tools) {
  const start=successful.length;
  const done=new Promise(resolve=>{branchTurnDone=resolve;});
  const {turn}=await request('turn/start',{threadId,input:[{type:'text',text:prompt}]});
  turnId=turn.id;
  journal('turn',{model,threadId,turnId,pid:isolatedIdentity?.pid??child.pid,observerPid:process.pid});
  await done;
  assert.equal(turnStatus,'completed');
  assert.equal(failure,undefined);
  assert.deepEqual(successful.slice(start),tools);
  assert.equal(completed.size,successful.length);
}

function entrySnapshot() {
  const db=new DatabaseSync(entryDatabase,{readOnly:true});
  try {
    return {
      runs:db.prepare('SELECT * FROM fk_i_runs ORDER BY namespace,run_id').all(),
      journal:db.prepare('SELECT * FROM fk_i_journal ORDER BY namespace,run_id,revision').all(),
      receipts:db.prepare('SELECT * FROM fk_i_receipt_index ORDER BY namespace,run_id,request_id').all(),
    };
  } finally {db.close();}
}

async function openEntrySession(binding,model) {
  const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
    multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},
    dynamicTools:osEntry?osTools:specs.filter(spec=>spec.name==='flowkit_submit')});
  const session=Object.freeze({...binding,threadId:thread.id,modelPid:isolatedIdentity.pid});
  entrySessions.set(thread.id,session);
  journal('entry-session',session);
  return session;
}

async function bindEntrySubject(binding,model) {
  if (osEntry) osAccess.authorize(binding.grant,'run:create',binding.namespace);
  const store=createSqliteCheckpointStore(entryDatabase,{namespace:binding.namespace});
  let writes=0;
  const instrumentedStore={...store,compareAndSwap(input){writes++;return store.compareAndSwap(input);}};
  const pair=generateKeyPairSync('ed25519');
  const publicKey=pair.publicKey.export({type:'spki',format:'pem'});
  const host=createTrustedInteractiveHost({store:instrumentedStore,
    runtime:{skillResolver:async()=> 'Submit ready for the current task.',
      validateResult:(_schema,value)=>osFile?validateArtifactResult(value):value.answer==='ready'?[]:['Expected ready']},
    trustedPublicKeys:{proof:pair.publicKey},trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:['question'],disclosurePolicyId:'entry-r5-fixture',
    authorizeDisclosure:osEntry?({namespace})=>osAccess.authorize(binding.grant,'task:dispatch',namespace):()=>true,
    ...(osEntry?{authorizeTerminalAccess:({action,namespace,runId,revision})=>{
      let allowed=false;
      try {allowed=osAccess.authorize(osAuditSession,action,namespace);return allowed;}
      finally {journal('os-result-audit',{identity:osAuditSession.identity,action,namespace,runId,revision,allowed});}
    }}:{}),
  });
  const frame=await host.start({runId:'entry-shared-run',startKey:'entry-shared-start',
    programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,
    state:{question:'Return ready.',tenantMarker:binding.namespace}});
  assert.equal(frame.status,'waiting');
  const task=await host.getPublicAgentTask({runId:frame.runId});
  assert.deepEqual(task.input,{question:'Return ready.'});
  const session=await openEntrySession(binding,model);
  const target={...binding,store,host,task,key:pair.privateKey,publicKey,writes:()=>writes};
  assert.ok(!entryResources.has(task.requestId));
  entryResources.set(task.requestId,target);
  journal('entry-binding',{...session,runId:task.runId,requestId:task.requestId,revision:frame.revision});
  return {session,target};
}

async function osTurn(session,target,label,prompt,denial=false) {
  const calls=[];
  const done=new Promise(resolve=>osTurns.set(session.threadId,{label,resolve,target,denial,calls}));
  const current=osTurns.get(session.threadId);
  const {turn}=await request('turn/start',{threadId:session.threadId,input:[{type:'text',text:prompt}]});
  current.id=turn.id;
  journal('os-turn',{label,threadId:session.threadId,turnId:turn.id,subject:session.subject,namespace:session.namespace});
  assert.equal((await done).status,'completed');
  osTurns.delete(session.threadId);
  assert.deepEqual(calls,osFile&&!denial?['flowkit_file_task','flowkit_submit_file']:[osFile?'flowkit_submit_file':'flowkit_submit']);
  return current.ref;
}

function osSnapshot() {
  const state=entrySnapshot();
  if (!osFile) return state;
  const db=new DatabaseSync(osFileDb,{readOnly:true});
  try {return {...state,files:db.prepare('SELECT id,namespace,request_id,sha256,size,state,call_id,accepted_revision FROM file_handoff ORDER BY id').all()};}
  finally {db.close();}
}

async function runOsEntry(model) {
  const policyPath=process.env.FLOWKIT_OS_ACCESS_FIXTURE;
  assert.ok(policyPath && path.isAbsolute(policyPath));
  const policy=JSON.parse((await readFile(policyPath,'utf8')).replace(/^\uFEFF/,''));
  osAccess=createCodexOsAccess(policy.bindings);
  const grants=policy.bindings.map(binding=>osAccess.bind(binding.identity));
  const operators=grants.filter(grant=>grant.role==='operator');
  const auditors=grants.filter(grant=>grant.role==='auditor');
  assert.equal(operators.length,2);
  assert.equal(auditors.length,1);
  assert.notEqual(operators[0].namespace,operators[1].namespace);
  assert.equal(auditors[0].namespace,operators[0].namespace);
  for (const grant of grants) assert.notEqual(grant.identity,String(isolatedIdentity.modelSid??isolatedIdentity.uid));
  journal('os-provisioned-policy',{bindings:grants});
  entryDatabase=path.join(fixture,'entry.sqlite');
  if (osFile) {
    osFileDb=path.join(fixture,'handoff.sqlite');
    const inbox=path.join(fixture,'inbox');
    await mkdir(inbox,{mode:0o700});
    handoff=createFileHandoff({database:osFileDb,inbox,
      validateArtifact:value=>Object.keys(value).length===1 && typeof value.answer==='string'});
  }
  const a=await bindEntrySubject({subject:operators[0].identity,namespace:operators[0].namespace,grant:operators[0]},model);
  const b=await bindEntrySubject({subject:operators[1].identity,namespace:operators[1].namespace,grant:operators[1]},model);
  const auditor=await openEntrySession({subject:auditors[0].identity,namespace:auditors[0].namespace,grant:auditors[0]},model);
  const pendingBefore=osSnapshot();
  const pendingWrites=[a.target.writes(),b.target.writes()];
  const negative=(target,ref)=>{
    const args=osFile?ref:{requestId:target.task.requestId,answer:'ready'};
    return `Synthetic negative test. Call ${osFile?'flowkit_submit_file':'flowkit_submit'} once with ${JSON.stringify(args)}. Finish after the response without retrying.`;
  };
  const probeRef={requestId:a.target.task.requestId,id:randomUUID()};
  await osTurn(b.session,a.target,'wrong-tenant',negative(a.target,probeRef),true);
  await osTurn(auditor,a.target,'wrong-subject',negative(a.target,probeRef),true);
  assert.equal(entrySignatures,0);
  assert.deepEqual(pendingWrites,[a.target.writes(),b.target.writes()]);
  assert.deepEqual(pendingBefore,osSnapshot());
  journal('os-pending-denials-verified',{deniedSignatures:0,deniedCas:0,unchanged:true});
  let ready=0,release;
  const overlap=new Promise(resolve=>{release=resolve;});
  osOverlap=()=>{if (++ready===2) release();return overlap;};
  const positive=({target})=>osFile
    ?'Call flowkit_file_task once with {}. From its tool reply use the exact requestId and id to call flowkit_submit_file once. Then finish.'
    :`Call flowkit_submit once with requestId "${target.task.requestId}" and answer "ready". Then finish.`;
  const refs=await Promise.all([a,b].map(pair=>osTurn(pair.session,pair.target,'valid',positive(pair))));
  assert.equal(ready,2);
  assert.equal(entrySignatures,2);
  const before=osSnapshot();
  const counts=[a.target.writes(),b.target.writes()];
  if (osFile) await osTurn(b.session,a.target,'wrong-tenant-reference',negative(a.target,refs[0]),true);
  const resultRef={runId:a.target.task.runId,revision:9,projectionVersion:1};
  osAuditSession=operators[0];
  await assert.rejects(a.target.host.readTrustedTerminalResult({resultRef}),{code:'FK_I_HOST_DENIED'});
  osAuditSession=auditors[0];
  const result=await a.target.host.readTrustedTerminalResult({resultRef});
  assert.equal(result.state.tenantMarker,operators[0].namespace);
  await assert.rejects(b.target.host.readTrustedTerminalResult({resultRef}),{code:'FK_I_HOST_DENIED'});
  assert.equal(entrySignatures,2);
  assert.deepEqual(counts,[a.target.writes(),b.target.writes()]);
  assert.deepEqual(before,osSnapshot());
  assert.deepEqual(before.runs.map(row=>row.revision),[9,9]);
  assert.deepEqual(before.receipts.map(row=>row.accepted_revision),[4,4]);
  if (osFile) assert.deepEqual(before.files.map(row=>[row.size,row.state,row.accepted_revision]),
    [[262144,'acked',4],[262144,'acked',4]]);
  journal('os-entry-verified',{tool:requested,snapshot:before,signatures:entrySignatures,concurrentReady:ready,
    deniedSignatures:0,deniedCas:0,unchanged:true,programHash:program.programIdentity.artifactHash});
  return 'entry-completed';
}

async function entryTurn(model,session,target,test,expectedDenial) {
  threadId=session.threadId;
  entryCase=test;
  entryDenial=expectedDenial;
  entryDone=undefined;
  entryDelay=undefined;
  const before=entrySnapshot();
  const signedBefore=entrySignatures;
  const counts=()=>[...entryResources.values()].map(resource=>resource.writes());
  const beforeWrites=counts();
  const requestId=target.task.requestId;
  await branchTurn(model,`Synthetic fixture. Call flowkit_submit exactly once with requestId "${requestId}" and answer "ready". `
    +'After the tool response, finish without retrying.', ['flowkit_submit']);
  assert.equal(entryDone?.accepted,expectedDenial===undefined);
  if (test==='late') assert.ok(entryDelay);
  await entryDelay?.();
  const after=entrySnapshot();
  assert.equal(entrySignatures-signedBefore,expectedDenial?0:1);
  if (expectedDenial) {
    assert.deepEqual(before,after);
    assert.deepEqual(beforeWrites,counts());
  }
  journal('entry-case',{case:test,subject:session.subject,namespace:session.namespace,targetNamespace:target.namespace,
    targetSubject:target.subject,requestId,accepted:entryDone.accepted,signatures:entrySignatures-signedBefore,
    beforeWrites,afterWrites:counts(),
    before:sha256Bytes(canonicalBytes(before)),after:sha256Bytes(canonicalBytes(after))});
}

async function runEntry(model) {
  entryDatabase=path.join(fixture,'entry.sqlite');
  const a=await bindEntrySubject({subject:'tester-a',namespace:'tenant-a'},model);
  const b=await bindEntrySubject({subject:'tester-b',namespace:'tenant-b'},model);
  const peer=await openEntrySession({subject:'tester-b',namespace:'tenant-a'},model);
  await entryTurn(model,peer,a.target,'wrong-subject','TARGET_DENIED');
  await entryTurn(model,peer,b.target,'wrong-tenant','TARGET_DENIED');
  await entryTurn(model,a.session,a.target,'mismatch','OBSERVATION_MISMATCH');
  await entryTurn(model,a.session,a.target,'timeout','OBSERVATION_TIMEOUT');
  await entryTurn(model,a.session,a.target,'late','OBSERVATION_TIMEOUT');
  await entryTurn(model,a.session,a.target,'valid-a');
  await entryTurn(model,b.session,b.target,'valid-b');
  const end=entrySnapshot();
  assert.deepEqual(end.runs.map(row=>[row.namespace,row.run_id,row.start_key,row.revision]),
    [['tenant-a','entry-shared-run','entry-shared-start',9],['tenant-b','entry-shared-run','entry-shared-start',9]]);
  assert.deepEqual(end.receipts.map(row=>[row.namespace,row.request_id,row.accepted_revision]),
    [['tenant-a',a.target.task.requestId,4],['tenant-b',b.target.task.requestId,4]]);
  for (const {store,task} of [a.target,b.target]) assert.equal(store.listJournal(task.runId).length,10);
  journal('entry-verified',{snapshot:end,programHash:program.programIdentity.artifactHash});
  return 'entry-completed';
}

async function runBranch(model) {
  const active=['approved','refused'].includes(branch);
  await branchTurn(model,`Call flowkit_start exactly once with nonce "${nonce}". Use no other tool in this turn.`,['flowkit_start']);
  assert.equal(frame.status,active?'waiting':branch==='missing'?'errored':'failed');
  if (branch==='approved') {
    const before=branchState();
    const signed=branchReceipts.length;
    branchNegative='request';
    await branchTurn(model,'Fixture negative test: call flowkit_submit once with requestId "unbound-fixture-request" '
      +'and result {"requirementId":"REQ-001"}. After the expected rejection finish without retrying.', ['flowkit_submit']);
    assert.deepEqual(branchState(),before);
    assert.equal(branchReceipts.length,signed);
    branchNegative='observation';
    await branchTurn(model,`Fixture negative test: call flowkit_submit once with requestId "${currentTask.requestId}" `
      +'and result {"requirementId":"REQ-001"}. After the expected rejection finish without retrying.', ['flowkit_submit']);
    branchNegative=undefined;
    assert.deepEqual(branchState(),before);
    assert.equal(branchReceipts.length,signed);
  }
  if (active) {
    const runId=frame.runId;
    for (const nodeId of branchNodes) {
      await branchTurn(model,`Call flowkit_continue with runId "${runId}". It returns the public ${nodeId} task. `
        +'Read its input and instruction. Call flowkit_submit exactly once using its requestId and the result required by the instruction. Then finish.',
      ['flowkit_continue','flowkit_submit']);
      assert.equal(frame.runId,runId);
    }
  }
  const expectedStatus=branch==='approved'?'succeeded':branch==='missing'?'errored':'failed';
  assert.equal(frame.status,expectedStatus);
  await branchTurn(model,`Call flowkit_continue once with runId "${frame.runId}" to read its public status. Then finish.`,['flowkit_continue']);
  const before=branchState();
  const publicFrame=await host.getPublicTerminalFrame({runId:frame.runId});
  assert.equal(Object.hasOwn(publicFrame,'state'),false);
  assert.ok(!JSON.stringify(publicFrame).includes(branchMarker));
  await assert.rejects(host.readTrustedTerminalResult({resultRef:publicFrame.resultRef}),{code:'FK_I_HOST_DENIED'});
  branchAccess='auditor';
  const trusted=await host.readTrustedTerminalResult({resultRef:publicFrame.resultRef});
  assert.equal(trusted.state.privateMarker,branchMarker);
  if (active) assert.deepEqual(trusted.state,{ready:true,request:'software task',privateMarker:branchMarker,...branchOutputs});
  if (branch==='missing') assert.equal(trusted.causeCode,'FK_R002');
  assert.deepEqual(branchState(),before);
  assert.equal(before.checkpoint.receiptCount,active?4:0);
  assert.equal(new Set(branchReceipts.map(p=>p.receipt.requestId)).size,active?4:0);
  assert.equal(before.journalRows.length,frame.revision+1);
  assert.equal(before.journalRows.filter(row=>row.entry.kind==='publish-pending').length,active?4:0);
  for (const [revision,row] of before.journalRows.entries()) {
    assert.equal(row.revision,revision);
    if (revision>0) assert.equal(row.previousHash,before.journalRows[revision-1].entryHash);
  }
  journal('branch-verified',{branch,programHash:program.programIdentity.artifactHash,publicFrame,trusted,
    journalRows:before.journalRows,receipts:branchReceipts.length,protectedRead:true,unchanged:true});
  return 'branch-completed';
}

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
  if (osEntry) return runOsEntry(model);
  if (entry) return runEntry(model);
  const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
    multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},
    dynamicTools:worker?specs.filter(spec=>fallback?spec.name!=='flowkit_continue':spec.name==='flowkit_submit'):specs});
  threadId=thread.id;
  if (branch) return runBranch(model);
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
  const passed=(entry?outcome==='entry-completed':branch?outcome==='branch-completed':outcome==='turn-completed' && turnStatus==='completed' && !failure
    && JSON.stringify(successful)===JSON.stringify(expected) && completed.size===expected.length)
    && (profile==='direct'||!!isolatedIdentity);
  console.log(JSON.stringify({passed,outcome,turnStatus,requestedBytes:size,artifactSize,profile,successful,inlineObserved,failure,branch,entry}));
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
  for (const resource of entryResources.values()) resource.store.close();
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
  if (requested==='release-revoke') {
    const pem=createPublicKey(await readFile(path.join(fixture,'proof.public.pem')));
    const keyHash=sha256Bytes(pem.export({type:'spki',format:'der'}));
    if (cut==='denied') {
      await assert.rejects(host.revokeKey(keyHash),{code:'FK_I_HOST_DENIED'});
      console.log(JSON.stringify({runId,keyHash,revoked:false,code:'FK_I_HOST_DENIED'}));
      return;
    }
    assert.equal(await host.revokeKey(keyHash),true);
    assert.equal(await host.revokeKey(keyHash),false);
    console.log(JSON.stringify({runId,keyHash,revoked:true}));
    return;
  }
  if (requested==='release-check') {
    const beforeJournal=store.listJournal(runId);
    if (cut==='active') {
      assert.equal((await host.load({runId})).revision,before.revision);
    } else {
      await assert.rejects(host.load({runId}),{code:'FK_I_HOST_DENIED'});
      await assert.rejects(host.resume({runId}),{code:'FK_I_HOST_DENIED'});
      if (answer) await assert.rejects(outbox.deliver(answer),{code:'FK_I_PROVENANCE_REJECTED'});
    }
    let ack=null;
    if (beforeReceipt) {
      const query={namespace:store.namespace,runId,requestId,nodeId:beforeReceipt.nodeId,
        attempt:beforeReceipt.attempt,receiptHash:beforeReceipt.digest};
      await assert.rejects(host.readHistoricalAck({...query,receiptHash:'sha256:'+'0'.repeat(64)}),{code:'FK_I_HOST_DENIED'});
      await assert.rejects(host.readHistoricalAck({...query,namespace:'other'}),{code:'FK_I_HOST_DENIED'});
      ack=await host.readHistoricalAck(query);
      assert.equal(ack.acceptedRevision,beforeReceipt.acceptedRevision);
    }
    assert.deepEqual(store.load(runId),before);
    assert.deepEqual(store.listJournal(runId),beforeJournal);
    console.log(JSON.stringify({runId,revision:before.revision,active:cut==='active',ack,unchanged:true}));
    return;
  }
  if (requested==='ops-clean') {
    const beforeJournal=store.listJournal(runId);
    const result=await outbox.cleanup({namespace:store.namespace,subjectId:'operator',reasonCode:'RETENTION'});
    assert.deepEqual(store.load(runId),before);
    assert.deepEqual(store.listJournal(runId),beforeJournal);
    assert.deepEqual(store.getReceipt(runId,requestId),beforeReceipt);
    const ack=await host.readHistoricalAck({namespace:store.namespace,runId,requestId,nodeId:beforeReceipt.nodeId,
      attempt:beforeReceipt.attempt,receiptHash:beforeReceipt.digest});
    console.log(JSON.stringify({result,ack,usage:outbox.usage(),unchanged:true}));
    return;
  }
  if (requested==='release-clean') {
    const db=new DatabaseSync(path.join(fixture,'outbox.sqlite'));
    const beforeUsage=outbox.usage();
    const beforeJournal=store.listJournal(runId);
    const request={namespace:store.namespace,subjectId:'operator',reasonCode:'RETENTION'};
    try {
      await assert.rejects(outbox.cleanup({...request,subjectId:'unauthorized'}),{code:'FK_OUTBOX_DENIED'});
      if (cut==='abort-audit') {
        db.exec("CREATE TRIGGER acceptance_abort BEFORE INSERT ON cleanup_audit BEGIN SELECT RAISE(ABORT,'audit interruption'); END");
        try {await assert.rejects(outbox.cleanup(request),/audit interruption/);}
        finally {db.exec('DROP TRIGGER acceptance_abort');}
        assert.deepEqual(outbox.usage(),beforeUsage);
      } else {
        const result=await outbox.cleanup(request);
        assert.equal(result.deleted,cut==='held'?0:1);
        if (result.operationId) assert.equal(db.prepare('SELECT deleted_count FROM cleanup_audit WHERE operation_id=?')
          .get(result.operationId).deleted_count,1);
      }
      assert.deepEqual(store.load(runId),before);
      assert.deepEqual(store.listJournal(runId),beforeJournal);
      assert.deepEqual(store.getReceipt(runId,requestId),beforeReceipt);
      console.log(JSON.stringify({runId,cut,beforeUsage,afterUsage:outbox.usage(),receipt:beforeReceipt,unchanged:true}));
    } finally {db.close();}
    return;
  }
  if (requested==='outbox-check-revocation') {
    assert.ok(revoked && before.policyHash!==host.policyHash);
    const rejected={};
    for (const [name,action,code] of [
      ['load',()=>host.load({runId}),'FK_I_HOST_DENIED'],
      ['resume',()=>host.resume({runId}),'FK_I_HOST_DENIED'],
      ['delivery',()=>beforeReceipt?outbox.deliver(answer):outbox.recover(runId),'FK_I_PROVENANCE_REJECTED'],
    ]) {
      await assert.rejects(action,error=>{
        rejected[name]=error.code;
        return error.code===code;
      });
    }
    assert.deepEqual(store.load(runId),before);
    assert.deepEqual(store.getReceipt(runId,requestId),beforeReceipt);
    console.log(JSON.stringify({runId,requestId,rejected,receipt:beforeReceipt,runPolicyHash:before.policyHash,
      configuredPolicyHash:host.policyHash,outbox:outbox.describe(answer)}));
    return;
  }
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
