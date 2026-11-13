import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {
  compileInteractive,createAgentReceiptStatement,createSqliteCheckpointStore,
  createTrustedInteractiveHost,encodeAgentReceiptStatement,
} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const [exe,cwd,out,requested='loop',profile='direct']=process.argv.slice(2);
const size=requested==='loop'?0:Number(requested);
assert.ok(path.isAbsolute(exe) && path.isAbsolute(cwd) && path.isAbsolute(out));
assert.ok([0,65536,262144,2093056].includes(size));
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
  tool('flowkit_submit','Submit the answer for the exact current FlowKit request',objectSchema({requestId:str,answer:str})),
  tool('flowkit_continue','Read the public terminal state of the provisioned Run',objectSchema({runId:str})),
];
const fixture=size?null:await mkdtemp(path.join(tmpdir(),'flowkit-codex-evidence-'));
let store,host,program,frame,currentTask;
const appArgs=['app-server','--listen','stdio://','-c','web_search="disabled"'];
let command=exe,args=appArgs;
if (profile==='isolated') {
  const node=process.execPath;
  // A pre-authorized, fixture-only launcher must enforce the model uid/gid and
  // pass only stdio. This probe never acquires or transfers account credentials.
  command=process.env.FLOWKIT_CODEX_LAUNCHER;
  assert.ok(path.isAbsolute(command));
  if (process.platform==='linux') {
    const modelUid=Number(process.env.FLOWKIT_MODEL_UID), modelGid=Number(process.env.FLOWKIT_MODEL_GID);
    const hostUid=Number(process.env.FLOWKIT_HOST_UID), hostGid=Number(process.env.FLOWKIT_HOST_GID);
    assert.ok([hostUid,hostGid,modelUid,modelGid].every(id=>Number.isSafeInteger(id)&&id>0));
    assert.notEqual(hostUid,modelUid);
    assert.notEqual(hostGid,modelGid);
    assert.equal(process.getuid(),hostUid);
    assert.equal(process.getgid(),hostGid);
    args=[node,fileURLToPath(new URL('./codex-model-identity.mjs',import.meta.url)),String(modelUid),String(modelGid),exe,...appArgs];
  } else {
    assert.equal(process.platform,'win32');
    assert.ok(process.env.FLOWKIT_HOST_SID && process.env.FLOWKIT_MODEL_SID
      && process.env.FLOWKIT_HOST_SID!==process.env.FLOWKIT_MODEL_SID);
    args=[exe,...appArgs];
  }
}
const child=spawn(command,args,
  {cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});
child.stdin.on('error',()=>{});
const pending=new Map(),starts=new Map(),completed=new Set(),successful=[];
let seq=0,threadId,turnId,turnStatus,failure,inlineObserved;
let finish;
const finished=new Promise(resolve=>{finish=resolve;});
child.on('error',error=>{failure=error.message;finish('spawn-error');});
child.on('close',code=>{journal('exit',{code});finish('closed');});
child.stdout.on('data',buffer=>record('app-server.stdout.ndjson',buffer));
child.stderr.on('data',buffer=>record('app-server.stderr',buffer));
const timer=setTimeout(()=>{finish('timeout');child.kill();},size?95000:65000);

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
  await writeFile(file,`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'codex-probe',version:'1.0.0',name:'Codex probe',nodes:[
node('review',{name:'Review',agent:'reviewer',inputs:['question'],
output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`);
  program=await compileInteractive(file,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(program.programIdentity,JSON.stringify(program.diagnostics));
  store=createSqliteCheckpointStore(path.join(fixture,'run.sqlite'),{namespace:'codex-proof'});
  const keys=generateKeyPairSync('ed25519');
  host=createTrustedInteractiveHost({
    store, runtime:{skillResolver:async()=> 'Read the public question and submit its requested answer.',
      validateResult:(_schema,value)=>value.answer==='ready'?[]:['Expected ready']},
    trustedPublicKeys:{proof:keys.publicKey},trustedArtifacts:[program.programIdentity.artifactHash],
    allowedInputKeys:['question'],disclosurePolicyId:'probe-v1',authorizeDisclosure:()=>true,
    authorizeTerminalAccess:({action})=>action==='run:read',
  });
  return keys.privateKey;
}

let key;
async function handleTool(name,args,identity) {
  if (size) {
    const canonical=canonicalBytes(args);
    inlineObserved={expected:size,received:canonical.byteLength,matched:canonical.equals(expectedBytes),
      expectedDigest:sha256Bytes(expectedBytes),receivedDigest:sha256Bytes(canonical)};
    journal('inline-comparison',inlineObserved);
    assert.ok(inlineObserved.matched,'complete inline JSON differs from exact target');
    return {bytes:canonical.byteLength};
  }
  if (name==='flowkit_start') {
    assert.equal(args.nonce,nonce);
    assert.equal(frame,undefined);
    frame=await host.start({programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,
      startKey:nonce,state:{question:'Return the word ready.',privateMarker:'host-only synthetic marker'}});
    currentTask=await host.getPublicAgentTask({runId:frame.runId});
    journal('pending', {runId:frame.runId,requestId:currentTask.requestId,revision:frame.revision,
      programHash:program.programIdentity.artifactHash,taskDigest:sha256Bytes(canonicalBytes(currentTask))});
    return currentTask;
  }
  if (name==='flowkit_submit') {
    assert.equal(frame?.status,'waiting');
    assert.equal(args.requestId,currentTask.requestId);
    const receipt={runId:currentTask.runId,requestId:currentTask.requestId,nodeId:currentTask.nodeId,
      attempt:currentTask.attempt,kind:'agent-result',result:{answer:args.answer}};
    const issuedAt=Date.now();
    const statement=createAgentReceiptStatement({run:store.load(receipt.runId),receipt,keyId:'proof',
      proofId:identity.callId,issuedAt,expiresAt:issuedAt+30000});
    const statementBytes=encodeAgentReceiptStatement(statement);
    journal('signing', {callId:identity.callId,requestId:receipt.requestId,toolInputDigest:identity.digest,
      statementDigest:sha256Bytes(statementBytes)});
    const signature=sign(null,statementBytes,key).toString('base64url');
    frame=await host.accept({receipt,attestation:{statement,signature}});
    journal('accepted',{acceptedRevision:frame.acceptedRevision,revision:frame.revision,runId:frame.runId,
      receipt:store.getReceipt(frame.runId,receipt.requestId)});
    return {runId:frame.runId,acceptedRevision:frame.acceptedRevision};
  }
  assert.equal(name,'flowkit_continue');
  assert.equal(args.runId,frame?.runId);
  const final=await host.getPublicTerminalFrame({runId:args.runId});
  assert.equal(final.status,'succeeded');
  assert.equal(frame.state.answer,'ready');
  const rows=store.listJournal(frame.runId);
  assert.equal(rows.length,frame.revision+1);
  journal('terminal',{status:final.status,revision:final.revision,journalRows:rows.length,
    checkpointHash:rows.at(-1).checkpointHash});
  return final;
}

const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
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
        const result=await handleTool(p.tool,p.arguments,identity);
        successful.push(p.tool);
        send({id:message.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]}});
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
      if (process.platform==='linux') {
        assert.equal(reported.uid,Number(process.env.FLOWKIT_MODEL_UID));
        assert.equal(reported.gid,Number(process.env.FLOWKIT_MODEL_GID));
        assert.ok(reported.groups.every(group=>group===reported.gid));
        assert.match(reported.capabilities,/^0+$/);
        assert.equal(reported.noNewPrivs,'1');
      } else {
        assert.equal(reported.hostSid,process.env.FLOWKIT_HOST_SID);
        assert.equal(reported.modelSid,process.env.FLOWKIT_MODEL_SID);
        assert.equal(reported.hostElevated,false);
        assert.equal(reported.modelElevated,false);
      }
      isolatedIdentity=reported;
      journal('isolated-identity',{hostUid:process.getuid?.(),hostGid:process.getgid?.(),...reported});
    } catch(error) {failure=error.message;finish('identity-error');}
  }
});
let isolatedIdentity;

async function run() {
  if (!size) key=await prepareFlowKit();
  await request('initialize',{clientInfo:{name:'flowkit-acceptance',title:'FlowKit acceptance',version:'0.1.0'},
    capabilities:{experimentalApi:true}});
  send({method:'initialized'});
  const {data}=await request('model/list',{limit:30,includeHidden:false});
  const model=data.find(entry=>entry.isDefault)?.model ?? data[0]?.model;
  const {thread}=await request('thread/start',{cwd,model,ephemeral:true,approvalPolicy:'never',sandbox:'read-only',
    multiAgentMode:'explicitRequestOnly',config:{mcp_servers:{}},dynamicTools:specs});
  threadId=thread.id;
  const prompt=size
    ? `Call flowkit_inline exactly once with nonce "${nonce}" and payload containing exactly ${bodyLength} uppercase ASCII A characters as one JSON string. Supply complete inline JSON, without using files, references, code, other tools or a placeholder. If impossible, say so and finish.`
    : `Only call the three FlowKit tools. Call flowkit_start with nonce "${nonce}". Read its public question and call flowkit_submit using its exact requestId and the answer. Then call flowkit_continue with the runId returned by submit and finish.`;
  const {turn}=await request('turn/start',{threadId,input:[{type:'text',text:prompt}]});
  turnId=turn.id;
  journal('turn',{model,threadId,turnId,requestedBytes:size,pid:child.pid,observerPid:process.pid});
  return finished;
}
try {
  const outcome=await Promise.race([run(),finished]);
  const expected=size?['flowkit_inline']:['flowkit_start','flowkit_submit','flowkit_continue'];
  const passed=outcome==='turn-completed' && turnStatus==='completed' && !failure
    && JSON.stringify(successful)===JSON.stringify(expected) && completed.size===expected.length
    && (profile==='direct'||!!isolatedIdentity);
  console.log(JSON.stringify({passed,outcome,turnStatus,requestedBytes:size,profile,successful,inlineObserved,failure}));
  if(!passed)process.exitCode=1;
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  store?.close();
  if(fixture) await rm(fixture,{recursive:true,force:true});
}
