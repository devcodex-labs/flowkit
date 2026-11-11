/**
 * M6 real Node Host process fixture. It uses the production FlowKit
 * compiler artifact, SQLite Store and Ed25519 Trusted Host, then exchanges
 * JSON with a distinct scripted worker process over stdin/stdout.
 *
 * It is intentionally not a Codex/Claude/Grok provider integration.
 * No endpoint allows worker/model stdin to invoke complete() or sign receipts.
 */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {
  createPrivateKey,createPublicKey,sign,randomUUID,
} from 'node:crypto';
import process from 'node:process';

const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function drift(message){return Object.assign(new Error('FK_I_POLICY_MISMATCH: '+message),{code:'FK_I_POLICY_MISMATCH'});}
import {
  createSqliteCheckpointStore,createTrustedInteractiveHost,
  createAgentReceiptStatement,encodeAgentReceiptStatement,
} from '../../src/interactive/index.mjs';

function trace(event, fields={}) {
  process.stdout.write(JSON.stringify({event,...fields})+'\n');
}
function onlyAllowedConfig(cfg) {
  if (!cfg || typeof cfg!=='object' || Array.isArray(cfg)) throw new TypeError('Expected trusted Host config');
  for(const field of ['namespace','runId','startKey','storePath','programPath','identityPath','privateKeyPath','skillPath','workerPath','skillHash']) {
    if(typeof cfg[field]!=='string' || !cfg[field]) throw new TypeError('Missing Host config '+field);
  }
  if (!cfg.state || typeof cfg.state!=='object' || !Array.isArray(cfg.allowedInputKeys)) {
    throw new TypeError('Invalid Host start configuration');
  }
}
async function spawnScriptedWorker(cfg,task) {
  let command=process.execPath;
  let args=[cfg.workerPath];
  if(cfg.osIsolation===true && process.platform!=='linux') {
    throw new Error('Cross-UID mode requires a Linux Host');
  }
  if(cfg.osIsolation===true) {
    args.push(cfg.privateKeyPath,cfg.storePath);
    if(process.getuid?.()===0) {
      // Set in spawn options below, do not inherit Host UID or GID.
    } else {
      command='sudo';
      args=['-n','-u','nobody','--',process.execPath,...args];
    }
  }
  // Deliberately do not inherit process.env: it might contain Host secrets.
  const env={
    PATH:process.env.PATH||'',
    ...(process.platform==='win32'?{
      SystemRoot:process.env.SystemRoot||'C:\\Windows',
      TEMP:process.env.TEMP||'',TMP:process.env.TMP||'',
    }:{HOME:'/tmp'}),
  };
  const options={
    cwd:process.cwd(),env,stdio:['pipe','pipe','pipe'],
    ...(cfg.osIsolation===true && process.getuid?.()===0
      ? {uid:65534,gid:65534} : {}),
  };
  const child=spawn(command,args,options);
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',bytes=0;
    const timeout=setTimeout(()=>{child.kill();reject(new Error('M6 worker timeout'))},15000);
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>128*1024) {
        child.kill();
        reject(new Error('M6 worker output limit exceeded'));
      } else stdout+=chunk.toString('utf8');
    });
    child.stderr.on('data',chunk=>{
      if(stderr.length<2048)stderr+=chunk.toString('utf8').slice(0,2048-stderr.length);
    });
    child.on('error',error=>{clearTimeout(timeout);reject(error)});
    child.on('close',code=>{
      clearTimeout(timeout);
      if(code!==0) {
        reject(new Error('M6 external worker exited '+code+': '+stderr.slice(0,300)));
        return;
      }
      try {
        if(stdout.trim().split(/\r?\n/).length!==1) {
          throw new TypeError('Worker must send one JSON response');
        }
        const data=JSON.parse(stdout);
        const keys=Object.keys(data).sort();
        if(keys.join(',')!=='kind,requestId,result' || data.kind!=='agent-result'
          || data.requestId!==task.requestId
          || !data.result || typeof data.result.answer!=='string'
          || Object.keys(data.result).join(',')!=='answer') {
          throw new TypeError('Uncertified worker response envelope');
        }
        resolve(data);
      } catch(error) {reject(error)}
    });
    child.stdin.on('error',()=>{}); // close errors handled through child's close result
    child.stdin.end(JSON.stringify(task));
  });
}

const [configPath,mode='start',cut='none']=process.argv.slice(2);
if(!configPath || !['start','resume'].includes(mode)
  || !['none','after-pending','after-worker'].includes(cut)) {
  throw new TypeError('Usage: m6-host.mjs <trusted-config-path> start|resume none|after-pending|after-worker');
}
const config=JSON.parse(await readFile(configPath,'utf8'));
onlyAllowedConfig(config);
const programBytes=await readFile(config.programPath);
const programIdentity=JSON.parse(await readFile(config.identityPath,'utf8'));
if(digest(programBytes)!==programIdentity.artifactHash) throw drift('Program artifact bytes changed');
async function checkSkill(){
  if(digest(await readFile(config.skillPath))!==config.skillHash)
    throw drift('Skill instruction bytes changed');
}
await checkSkill();
// Source is optional after compiling; when still present it MUST match pinned
// source identity. Deleting source cannot change the immutable saved Program.
if(config.sourcePath){
  let existingSource;
  try {existingSource=await readFile(config.sourcePath)}
  catch(e){if(e.code!=='ENOENT')throw e}
  if(existingSource && digest(existingSource)!==programIdentity.sourceHash)
    throw drift('Original source bytes changed');
}
const privateKey=createPrivateKey(await readFile(config.privateKeyPath));
const publicKey=createPublicKey(privateKey);
const store=createSqliteCheckpointStore(config.storePath,{namespace:config.namespace});
try {
  const host=createTrustedInteractiveHost({
    store,
    runtime:{
      skillResolver:async()=>{await checkSkill();return readFile(config.skillPath,'utf8')}, 
      validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['Expected a string answer'],
    },
    policy:{testHostId:'m6-isolated-node-host-v1',skillManifestHash:config.skillHash}, 
    trustedPublicKeys:{'m6-host-key':publicKey},
    trustedArtifacts:[programIdentity.artifactHash],
    allowedInputKeys:config.allowedInputKeys,
    disclosurePolicyId:'m6-explicit-input-allowlist',
    authorizeDisclosure:async({task})=>(
      Object.keys(task.input).every(key=>config.allowedInputKeys.includes(key))
      && task.missing.every(key=>config.allowedInputKeys.includes(key))
    ),
    maxStagesPerCall:config.stageBudget??128,
  });
  let frame=mode==='start'
    ? await host.start({
      programBytes,programIdentity,startKey:config.startKey,
      runId:config.runId,state:config.state,
    })
    : await host.resume({runId:config.runId});
  trace('host-start',{status:frame.status,runId:frame.runId,revision:frame.revision});
  let loops=0;
  while(loops++<1000) {
    if(frame.status==='paused') {
      if(frame.pauseReason!=='stage-budget') throw new Error('Unexpected durable pause');
      frame=await host.resume({runId:config.runId});
      continue;
    }
    if(frame.status!=='waiting')break;
    await checkSkill();
    const task=await host.getPublicAgentTask({runId:frame.runId});
    if(!task || task.requestId!==frame.pending?.requestId) {
      throw new TypeError('Published task and Store Pending differ');
    }
    trace('task-published',{runId:task.runId,requestId:task.requestId,nodeId:task.nodeId,
      revision:frame.revision,attempt:task.attempt});
    if(cut==='after-pending') {
      trace('fault-injected',{where:'after-pending',requestId:task.requestId});
      process.kill(process.pid,'SIGKILL');
    }
    const external=await spawnScriptedWorker(config,task);
    await checkSkill();
    trace('worker-exited',{requestId:external.requestId});
    if(cut==='after-worker') {
      trace('fault-injected',{where:'after-worker',requestId:task.requestId});
      process.kill(process.pid,'SIGKILL');
    }
    // Host constructs this envelope. The worker cannot select run identity,
    // proof ID, policy, destination node or the signer.
    const receipt={
      kind:'agent-result',runId:task.runId,requestId:task.requestId,
      nodeId:task.nodeId,attempt:task.attempt,result:external.result,
    };
    const issuedAt=Date.now();
    const statement=createAgentReceiptStatement({
      run:store.load(task.runId),receipt,keyId:'m6-host-key',
      proofId:'host-process:'+randomUUID(),
      issuedAt,expiresAt:issuedAt+60000,
    });
    const signature=sign(null,encodeAgentReceiptStatement(statement),privateKey)
      .toString('base64url');
    frame=await host.accept({receipt,attestation:{statement,signature}});
    trace('receipt-accepted',{requestId:task.requestId,
      acceptedRevision:frame.acceptedRevision,duplicate:frame.duplicate});
  }
  if(loops>=1000) throw new Error('M6 stage budget made no progress');
  trace('host-terminal',{status:frame.status,runId:frame.runId,revision:frame.revision});
  if(frame.status==='errored')process.exitCode=2;
  else if(!['succeeded','failed'].includes(frame.status))process.exitCode=3;
} finally {
  store.close();
}
