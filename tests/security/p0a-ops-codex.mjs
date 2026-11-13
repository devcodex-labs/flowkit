import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {openCodexOutbox} from '../../examples/interactive/codex-outbox.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';
import {compileOpsWorkflow,opsRuntime,opsStart} from './p0a-ops-fixture.mjs';

const [executable,cwd,out,mode='retry']=process.argv.slice(2);
assert.ok(['retry','disconnect','interrupt'].includes(mode));
assert.ok([executable,cwd,out].every(value=>value&&path.isAbsolute(value)));
mkdirSync(out,{recursive:false,mode:0o700});
const appArgs=['app-server','--listen','stdio://','-c','web_search="disabled"'];
const launcher=process.env.FLOWKIT_CODEX_LAUNCHER;
const sshConfig=process.env.FLOWKIT_CODEX_SSH_CONFIG;
assert.ok(launcher&&path.isAbsolute(launcher));
let args,checkIdentity;
if (process.platform==='win32') {
  const helper=process.env.FLOWKIT_CODEX_WINDOWS_IDENTITY;
  assert.ok(helper&&path.isAbsolute(helper));
  const hostSid=execFileSync(helper,['--host-identity'],{encoding:'utf8',timeout:5000,windowsHide:true}).trim();
  assert.equal(hostSid,process.env.FLOWKIT_HOST_SID);
  assert.notEqual(hostSid,process.env.FLOWKIT_MODEL_SID);
  args=[executable,...appArgs];
  checkIdentity=identity=>{
    assert.equal(identity.modelSid,process.env.FLOWKIT_MODEL_SID);
    assert.equal(identity.modelElevated,false);
    assert.equal(identity.stdioAllowlist,true);
    return {hostSid,...identity};
  };
} else {
  assert.equal(process.platform,'linux');
  const hostUid=Number(process.env.FLOWKIT_HOST_UID),hostGid=Number(process.env.FLOWKIT_HOST_GID);
  const modelUid=Number(process.env.FLOWKIT_MODEL_UID),modelGid=Number(process.env.FLOWKIT_MODEL_GID);
  assert.ok([hostUid,hostGid,modelUid,modelGid].every(id=>Number.isSafeInteger(id)&&id>0));
  assert.notEqual(hostUid,modelUid);
  assert.notEqual(hostGid,modelGid);
  assert.equal(process.getuid(),hostUid);
  assert.equal(process.getgid(),hostGid);
  const modelExec=process.env.FLOWKIT_CODEX_LINUX_EXEC;
  if (!sshConfig) assert.ok(modelExec&&path.isAbsolute(modelExec));
  args=[process.execPath,fileURLToPath(new URL('./codex-model-identity.mjs',import.meta.url)),
    String(modelUid),String(modelGid),modelExec,executable,...appArgs];
  checkIdentity=identity=>{
    assert.equal(identity.uid,modelUid);
    assert.equal(identity.gid,modelGid);
    assert.ok(identity.groups.every(group=>group===modelGid));
    assert.match(identity.capabilities,/^0+$/);
    assert.equal(identity.noNewPrivs,'1');
    return {hostUid,hostGid,...identity};
  };
}
if (sshConfig) {
  assert.ok(path.isAbsolute(sshConfig)&&['ssh','ssh.exe'].includes(path.basename(launcher).toLowerCase()));
  args=['-F',sshConfig,'-T','-o','HostName=127.0.0.1','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    '-o','IdentitiesOnly=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',
    '-o','ProxyCommand=none','-o','ProxyJump=none','-o','ControlMaster=no','-o','ControlPath=none','flowkit-model'];
}

const write=(file,text)=>appendFileSync(path.join(out,file),text);
const event=(kind,details)=>write('observer.ndjson',JSON.stringify({kind,at:Date.now(),...details})+'\n');
const program=await compileOpsWorkflow(out);
const store=createSqliteCheckpointStore(path.join(out,'run.sqlite'),{namespace:'p0a-ops'});
const keys=generateKeyPairSync('ed25519');
writeFileSync(path.join(out,'proof.public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
const host=createTrustedInteractiveHost({store,runtime:opsRuntime,
  trustedPublicKeys:{proof:keys.publicKey},trustedArtifacts:[program.programIdentity.artifactHash],
  allowedInputKeys:['question'],disclosurePolicyId:'p0a-ops',authorizeDisclosure:()=>true,
  authorizeTerminalAccess:({action})=>action==='result:read'});
const outbox=openCodexOutbox({database:path.join(out,'outbox.sqlite'),store,host});
const child=spawn(launcher,args,{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
const lines=createInterface({input:child.stdout});
let fail,identify,sequence=0,identity,active;
const failed=new Promise((_,reject)=>{fail=reject;});
const identified=new Promise(resolve=>{identify=resolve;});
const requests=new Map(),observations=new Map();
const timer=setTimeout(()=>fail(new Error('App Server run timed out')),120000);
child.once('error',fail);
let closingForTest=false;
child.once('close',code=>{
  if (!closingForTest) fail(new Error(`App Server channel closed early (${code})`));
});
child.stdin.on('error',fail);
child.stdout.on('data',chunk=>write('app-server.stdout.ndjson',chunk));
child.stderr.on('data',chunk=>write('app-server.stderr',chunk));

function send(message) {
  const line=JSON.stringify(message)+'\n';
  write('app-server.requests.ndjson',line);
  child.stdin.write(line);
}

function request(method,params) {
  const id=++sequence;
  return new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});send({id,method,params});});
}

async function submit(message) {
  const p=message.params;
  const started=observations.get(p.callId);
  observations.delete(p.callId);
  assert.ok(active && identity && started && !active.callId);
  assert.equal(p.threadId,active.threadId);
  assert.equal(p.turnId,active.turnId);
  assert.equal(p.tool,'flowkit_submit');
  assert.deepEqual(started,{threadId:p.threadId,turnId:p.turnId,tool:p.tool,callId:p.callId,args:p.arguments});
  const {runId,requestId,nodeId,attempt}=active.task;
  assert.deepEqual(p.arguments,{requestId,answer:active.answer});
  active.callId=p.callId;
  const receipt={runId,requestId,nodeId,attempt,kind:'agent-result',result:{answer:p.arguments.answer}};
  const proofId=await outbox.record({task:active.task,started,callback:started,modelPid:identity.pid},receipt,keys.privateKey);
  const result=await outbox.deliver(proofId);
  const ack=outbox.describe(proofId);
  assert.equal(ack.state,'ACKED');
  assert.equal(ack.receiptHash,sha256Bytes(canonicalBytes(receipt)));
  assert.equal(store.getReceipt(runId,requestId).acceptedRevision,ack.acceptedRevision);
  active.result=result;
  event('receipt',{case:active.label,modelPid:identity.pid,threadId:p.threadId,turnId:p.turnId,callId:p.callId,
    runId,requestId,attempt,answer:active.answer,ack,status:result.status,revision:result.revision});
  send({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:'Recorded.'}]}});
}

lines.on('line',line=>{
  try {
    const message=JSON.parse(line),p=message.params;
    if (!message.method && requests.has(message.id)) {
      const waiter=requests.get(message.id);
      requests.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else {
        if (message.result?.turn && active) active.turnId=message.result.turn.id;
        waiter.resolve(message.result);
      }
    } else if (message.method==='flowkit/profile/identity') {
      assert.equal(identity,undefined);
      assert.ok(Number.isSafeInteger(p.pid)&&p.pid>1);
      identity=p;
      event('identity',checkIdentity(p));
      identify();
    } else if (message.method==='item/started'&&p.item.type==='dynamicToolCall') {
      observations.set(p.item.id,{threadId:p.threadId,turnId:p.turnId,tool:p.item.tool,callId:p.item.id,args:p.item.arguments});
    } else if (message.method==='item/tool/call') {
      if (mode==='interrupt') {
        const started=observations.get(p.callId);
        assert.ok(active && identity && started && !active.callId);
        assert.equal(p.threadId,active.threadId);
        assert.equal(p.turnId,active.turnId);
        assert.equal(p.tool,'probe_hold');
        assert.deepEqual(started,{threadId:p.threadId,turnId:p.turnId,tool:p.tool,callId:p.callId,args:p.arguments});
        assert.deepEqual(p.arguments,{});
        active.callId=p.callId;
        // Keep the real model turn waiting on a read-only probe until the client interrupts it.
        event('turn-held',{threadId:p.threadId,turnId:p.turnId,callId:p.callId});
        active.held();
      } else void submit(message).catch(fail);
    } else if (message.method==='turn/completed'&&active&&p.threadId===active.threadId) {
      assert.equal(p.turn.id,active.turnId);
      active.done(p.turn);
    } else if (message.id!==undefined&&message.method) {
      send({id:message.id,error:{code:-32601,message:'Unexpected server request'}});
    }
  } catch (error) {fail(error);}
});

async function runCase(model,label,answers) {
  const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
    multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},dynamicTools:[{type:'function',name:'flowkit_submit',
      description:'Submit the exact answer for the current FlowKit fixture task',inputSchema:{type:'object',
        properties:{requestId:{type:'string'},answer:{type:'string'}},required:['requestId','answer'],additionalProperties:false}}]});
  let frame=await host.start(opsStart(program,label));
  const runId=frame.runId;
  const requestIds=[];
  for (const answer of answers) {
    assert.equal(frame.status,'waiting');
    const task=await host.getPublicAgentTask({runId});
    assert.equal(task.attempt,requestIds.length+1);
    requestIds.push(task.requestId);
    const completed=new Promise(done=>{active={label,threadId:thread.id,task,answer,done};});
    const prompt=`Synthetic workflow validation test. Call the dynamic tool flowkit_submit exactly once with requestId "${task.requestId}" and answer "${answer}". Use the exact strings, then finish after the tool response without retrying.`;
    await request('turn/start',{threadId:thread.id,input:[{type:'text',text:prompt}]});
    const turn=await completed;
    assert.equal(turn.status,'completed');
    assert.ok(active.callId&&active.result);
    frame=active.result;
    active=undefined;
    if (answer!=='ready') assert.equal(store.load(runId).state.answer,undefined);
  }
  assert.equal(new Set(requestIds).size,2);
  const result=await host.readTrustedTerminalResult({resultRef:{runId,revision:frame.revision,projectionVersion:1}});
  const journal=store.listJournal(runId);
  assert.equal(store.load(runId).receiptCount,2);
  assert.equal(journal.length,frame.revision+1);
  if (label==='recover') {
    assert.equal(frame.status,'succeeded');
    assert.equal(result.state.answer,'ready');
  } else {
    assert.equal(frame.status,'errored');
    assert.equal(result.causeCode,'FK_R004');
    assert.equal(result.state.answer,undefined);
  }
  event('case',{case:label,runId,requestIds,modelTurns:2,receiptCount:2,status:frame.status,
    causeCode:result.causeCode,revision:frame.revision,journal});
  return frame.status;
}

async function run() {
  await identified;
  await request('initialize',{clientInfo:{name:'flowkit-ops',title:'FlowKit operations acceptance',version:'0.1.0'},
    capabilities:{experimentalApi:true}});
  send({method:'initialized'});
  const {data}=await request('model/list',{limit:30,includeHidden:false});
  const model=data.find(entry=>entry.isDefault)?.model??data[0]?.model;
  assert.ok(model);
  if (mode==='disconnect' || mode==='interrupt') {
    const interrupt=mode==='interrupt';
    const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
      multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},...(interrupt?{dynamicTools:[{
        type:'function',name:'probe_hold',description:'Read-only synthetic test barrier',
        inputSchema:{type:'object',properties:{},additionalProperties:false},
      }]}:{})});
    const {runId}=await host.start(opsStart(program,'transport-disconnect'));
    const snapshot=()=>({checkpoint:store.load(runId),journal:store.listJournal(runId),outbox:outbox.usage()});
    const before=snapshot();
    assert.equal(before.checkpoint.status,'waiting');
    assert.equal(before.checkpoint.receiptCount,0);
    assert.equal(before.outbox.records,0);
    let turn;
    if (interrupt) {
      active={threadId:thread.id};
      const held=new Promise(resolve=>{active.held=resolve;});
      const completed=new Promise(resolve=>{active.done=resolve;});
      await request('turn/start',{threadId:thread.id,input:[{type:'text',
        text:'Synthetic integration test. Immediately call the probe_hold tool exactly once with an empty object. Wait for its reply.'}]});
      await Promise.race([held,completed.then(()=>{throw new Error('Model turn completed before the test barrier');})]);
      assert.deepEqual(snapshot(),before);
      await request('turn/interrupt',{threadId:thread.id,turnId:active.turnId});
      turn=await completed;
      assert.equal(turn.status,'interrupted');
      event('turn-interrupted',{threadId:thread.id,turnId:turn.id,callId:active.callId,status:turn.status});
      active=undefined;
    }
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    closingForTest=true;
    child.stdin.end();
    const exit=await closed;
    assert.deepEqual(snapshot(),before);
    const resumed=await host.resume({runId});
    assert.equal(resumed.pending.requestId,before.checkpoint.pending.requestId);
    assert.deepEqual(snapshot(),before);
    assert.equal(exit.code,0);
    const result={passed:true,mode,threadId:thread.id,runId,exit,unchanged:true,receiptCount:0,
      ...(turn?{turnId:turn.id,turnStatus:turn.status}:{})};
    event('transport-closed',result);
    return result;
  }
  const recover=await runCase(model,'recover',['invalid','ready']);
  const exhausted=await runCase(model,'exhausted',['invalid','invalid']);
  return {passed:true,model,recover,exhausted,modelTurns:4};
}

try {console.log(JSON.stringify(await Promise.race([run(),failed])));}
catch (error) {console.error(error.stack);process.exitCode=1;}
finally {
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  outbox.close();
  store.close();
}
