import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCodexOsAccess} from '../../examples/interactive/codex-os-access.mjs';
import {serveCodexOsSession} from '../../examples/interactive/codex-os-stdio.mjs';
import {compileInteractive,createSqliteCheckpointStore,createTrustedInteractiveHost} from '../../src/interactive/index.mjs';

const [mode,root,policyFile]=process.argv.slice(2);
const ownIdentity=()=>process.platform==='win32'
  ?execFileSync(path.join(process.env.SystemRoot,'System32','whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-5-(?:\d+-)+\d+/)?.[0]
  :String(process.getuid());
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
const incoming=createInterface({input:process.stdin,crlfDelay:Infinity});
const identity=ownIdentity();
assert.ok(identity);
write({identity,pid:process.pid});

if (mode==='linux-supervisor') {
  incoming.close();
  assert.equal(process.getuid(),0);
  const config=JSON.parse(await readFile(policyFile,'utf8'));
  const entry=fileURLToPath(import.meta.url);
  const children=[];
  const launch=async(uid,...args)=>{
    const child=spawn('/usr/bin/setpriv',['--reuid',uid,'--regid',uid,'--clear-groups','--no-new-privs',
      process.execPath,entry,...args],{stdio:['pipe','pipe','inherit']});
    const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    children.push({child,closed});
    const output=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const read=async()=>JSON.parse((await output.next()).value);
    const peer=await read();
    assert.deepEqual(peer,{identity:uid,pid:child.pid});
    write({started:uid,pid:peer.pid});
    return async command=>{
      child.stdin.write(JSON.stringify(command)+'\n');
      const reply=await read();
      write({peer:uid,command,reply});
      return reply;
    };
  };
  try {
    const host=await launch(config.host,'host',root,policyFile);
    const [a,b,auditor]=config.bindings.map(entry=>entry.identity);
    const peers=new Map();
    async function connect(id,uid) {
      peers.set(id,await launch(uid,'peer'));
      assert.deepEqual(await host({op:'open',id,identity:uid}),{opened:id});
    }
    async function command(id,value) {
      const peer=peers.get(id);
      const {command}=await peer(value);
      return (await host({op:'data',id,command})).response;
    }
    for (const [id,uid] of [['a',a],['b',b],['audit',auditor]]) await connect(id,uid);
    await exerciseOsSessions({host,command,connect,operator:a,auditor});
  } finally {
    for (const {child} of children) child.stdin.end();
    for (const {closed} of children) assert.equal(await closed,0);
  }
} else if (mode==='peer') {
  // The privileged launcher reads this process's stdout and sends the bytes to
  // the Host using the session ID allocated at OS process creation.
  for await (const line of incoming) write({command:JSON.parse(line)});
} else {
  assert.equal(mode,'host');
  assert.ok(path.isAbsolute(root) && path.isAbsolute(policyFile));
  await mkdir(root,{mode:0o700});
  const bindings=JSON.parse((await readFile(policyFile,'utf8')).replace(/^\uFEFF/,'')).bindings;
  const access=createCodexOsAccess(bindings);
  const filename=path.join(root,'session.workflow.js');
  await writeFile(filename,`import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'os-session',version:'1.0.0',name:'OS session',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});`);
  const program=await compileInteractive(filename,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(program.programIdentity,JSON.stringify(program.diagnostics));
  const stores=new Map(),sessions=new Map();
  const publicKey=generateKeyPairSync('ed25519').publicKey;
  function storeFor(namespace) {
    if (!stores.has(namespace)) stores.set(namespace,createSqliteCheckpointStore(path.join(root,'run.sqlite'),{namespace}));
    return stores.get(namespace);
  }
  async function dispatch(session,command) {
    const {action,namespace}=command;
    const store=storeFor(namespace);
    const host=createTrustedInteractiveHost({store,trustedPublicKeys:{proof:publicKey},
      trustedArtifacts:[program.programIdentity.artifactHash],allowedInputKeys:[],disclosurePolicyId:'os-session-r5',
      runtime:{skillResolver:async()=> 'unused',validateResult:()=>[]},authorizeDisclosure:()=>false,
      authorizeTerminalAccess:request=>access.authorize(session,request.action,request.namespace)});
    if (action==='run:create') {
      access.authorize(session,action,namespace);
      const frame=await host.start({runId:command.runId,startKey:command.runId,
        programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,state:{privateMarker:namespace}});
      return {runId:frame.runId,revision:frame.revision,status:frame.status};
    }
    assert.equal(action,'result:read');
    return host.readTrustedTerminalResult({resultRef:command.resultRef});
  }
  try {
    for await (const line of incoming) {
      const message=JSON.parse(line);
      const {op,id}=message;
      if (op==='open') {
        assert.ok(!sessions.has(id));
        const input=new PassThrough(),output=new PassThrough();
        const responses=createInterface({input:output})[Symbol.asyncIterator]();
        const running=serveCodexOsSession({access,identity:message.identity,input,output,dispatch});
        sessions.set(id,{input,output,responses,running});
        write({opened:id});
      } else if (op==='data') {
        const {input,responses}=sessions.get(id);
        input.write(JSON.stringify(message.command)+'\n');
        const response=JSON.parse((await responses.next()).value);
        write({id,response});
      } else if (op==='reload') {
        access.replaceBindings(bindings.filter(binding=>!message.revoked.includes(binding.identity)));
        write({reloaded:true});
      } else {
        assert.equal(op,'inspect');
        const state=[...stores].map(([namespace,store])=>({namespace,runs:message.runIds.map(runId=>({
          runId,revision:store.load(runId)?.revision??null,journalRows:store.listJournal(runId).length,
        }))}));
        write({state});
      }
    }
  } finally {
    for (const {input} of sessions.values()) input.end();
    for (const {running,output} of sessions.values()) {await running;output.end();}
    for (const store of stores.values()) store.close();
  }
}

async function exerciseOsSessions({host,command,connect,operator,auditor}) {
  const denied={ok:false,code:'FK_I_HOST_DENIED'};
  const start=(namespace,runId)=>({action:'run:create',namespace,runId});
  const created=await command('a',start('tenant-a','shared'));
  assert.equal(created.result.status,'succeeded');
  assert.deepEqual(await command('b',start('tenant-b','shared')),created);
  const resultRef={runId:'shared',revision:created.result.revision,projectionVersion:1};
  const audit=namespace=>({action:'result:read',namespace,resultRef});
  assert.deepEqual(await command('a',audit('tenant-a')),denied);
  assert.deepEqual(await command('audit',audit('tenant-b')),denied);
  const readable=await command('audit',audit('tenant-a'));
  assert.equal(readable.result.state.privateMarker,'tenant-a');
  const inspect={op:'inspect',runIds:['shared','revoked']};
  const before=await host(inspect);
  await host({op:'reload',revoked:[operator,auditor]});
  assert.deepEqual(await command('a',start('tenant-a','revoked')),denied);
  assert.deepEqual(await command('audit',audit('tenant-a')),denied);
  await host({op:'reload',revoked:[]});
  assert.deepEqual(await command('a',start('tenant-a','revoked')),denied);
  assert.deepEqual(await command('audit',audit('tenant-a')),denied);
  assert.deepEqual(await host(inspect),before);
  await connect('new-a',operator);
  await connect('new-audit',auditor);
  assert.deepEqual(await command('new-audit',audit('tenant-a')),readable);
  assert.equal((await command('new-a',start('tenant-a','new'))).result.status,'succeeded');
  write({verified:true,oldOperatorDenied:true,oldAuditorDenied:true,unchanged:true});
}
