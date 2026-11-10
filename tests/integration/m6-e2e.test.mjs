import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,mkdir,writeFile,readFile,chmod,rm,
} from 'node:fs/promises';
import {generateKeyPairSync} from 'node:crypto';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileInteractive,createSqliteCheckpointStore} from '../../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {run,isControlSignal,evalWhen} from '../../src/index.mjs';

const hostScript=fileURLToPath(new URL('./m6-host.mjs',import.meta.url));
const workerScript=fileURLToPath(new URL('./m6-worker.mjs',import.meta.url));
const roots=[];
after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true})});

const workflowText=[
  "import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';",
  "export default defineWorkflow({id:'m6-acceptance',version:'1.0.0',name:'Acceptance',nodes:[",
  "condition('gate',{name:'Gate',branches:[{when:'ready',next:'worker'},{when:'true',next:'declined'}]}),",
  "node('worker',{name:'Worker',skill:'skills/writer.md',inputs:['message'],",
  "  output:{type:'object',properties:{answer:{type:'string'}}},retries:2,next:'done'}),",
  "terminal('done',{name:'Done',status:'succeeded'}),",
  "terminal('declined',{name:'Declined',status:'failed'})]});",
].join('\n');

const privateSentinel='HOST_PRIVATE_SENTINEL';
async function fixture(t,{stageBudget=128,ready=true,allowedInputKeys=['message'],osIsolation=false}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'flowkit-m6-realhost-'));
  roots.push(root);
  await chmod(root,0o755); // allow low-privilege model worker to traverse public ancestors
  const privateRoot=path.join(root,'host-private');
  const skillDir=path.join(root,'skills');
  await mkdir(privateRoot,{mode:0o700});
  await mkdir(skillDir,{mode:0o755});
  await chmod(privateRoot,0o700);
  const skillPath=path.join(skillDir,'writer.md');
  await writeFile(skillPath,'Review and return a JSON answer.',{mode:0o644});
  const sourcePath=path.join(root,'acceptance.workflow.js');
  await writeFile(sourcePath,workflowText,{mode:0o644});
  const compiled=await compileInteractive(sourcePath,{
    output:'memory',featureStage:'P0-A',
  });
  assert.equal(compiled.diagnostics.filter(x=>x.severity==='error').length,0,
    JSON.stringify(compiled.diagnostics));
  assert.ok(compiled.programIdentity?.artifactHash);
  const identityPath=path.join(privateRoot,'manifest.json');
  const programPath=path.join(privateRoot,'accepted.interactive.mjs');
  const storePath=path.join(privateRoot,'run.db');
  const privateKeyPath=path.join(privateRoot,'signing-key.pem');
  const configPath=path.join(privateRoot,'host-config.json');
  const pair=generateKeyPairSync('ed25519');
  await writeFile(programPath,compiled.code,{mode:0o600});
  await writeFile(identityPath,JSON.stringify(compiled.programIdentity),{mode:0o600});
  await writeFile(privateKeyPath,
    pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const config={
    namespace:'m6-reference-host',runId:'run-m6-test',
    startKey:'m6-acceptance-start',storePath,programPath,identityPath,
    privateKeyPath,skillPath,sourcePath,skillHash:sha256Bytes(await readFile(skillPath)),workerPath:workerScript,
    state:{ready,message:'hello',secret:privateSentinel},
    allowedInputKeys,stageBudget,osIsolation,
  };
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  await chmod(privateRoot,0o700);
  const readStore=()=>{
    const store=createSqliteCheckpointStore(storePath,{namespace:config.namespace});
    try {
      const cp=store.load(config.runId);
      return {cp,journal:store.listJournal(config.runId),
        artifact:cp&&store.getArtifact(cp.artifactHash)};
    } finally {store.close()}
  };
  return {
    root,sourcePath,configPath,config,compiled,readStore,
    async updateConfig(update) {
      Object.assign(config,update);
      await writeFile(configPath,JSON.stringify(config),{mode:0o600});
    },
    async standardResult() {
      const host={
        isControlSignal,evalWhen,
        runAgent:async step=>({answer:'external-worker-processed:'+step.input.message}),
        validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['bad answer'],
      };
      return run(sourcePath,host,{...config.state},{projectRoot:root,skillCheck:true});
    },
  };
}
function readEvents(stdout) {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>{
    let event=JSON.parse(line);
    if(typeof event.event!=='string') throw new TypeError('Malformed Host event');
    return event;
  });
}
async function invoke(fixture,mode='start',cut='none') {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[hostScript,fixture.configPath,mode,cut],
      {stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',length=0;
    const timeout=setTimeout(()=>{child.kill();reject(new Error('M6 Host timeout'))},60000);
    child.stdout.on('data',b=>{
      length+=b.length;
      if(length>512*1024) {child.kill();reject(new RangeError('Host trace exceeds limit'))}
      else stdout+=b.toString();
    });
    child.stderr.on('data',b=>{if(stderr.length<2048)stderr+=b.toString().slice(0,2048-stderr.length)});
    child.on('error',e=>{clearTimeout(timeout);reject(e)});
    child.on('close',(code,signal)=>{
      clearTimeout(timeout);
      try {
        const events=readEvents(stdout);
        resolve({code,signal,events,stderr,stdout});
      } catch(e) {reject(e)}
    });
  });
}
function assertContinuousJournal(snapshot) {
  assert.deepEqual(snapshot.journal.map(item=>item.revision),
    Array.from({length:snapshot.cp.revision+1},(_,i)=>i));
  assert.equal(snapshot.journal.at(-1).checkpointHash,
    sha256Bytes(canonicalBytes(snapshot.cp)));
  for(let i=1;i<snapshot.journal.length;i++)
    assert.equal(snapshot.journal[i].previousHash,snapshot.journal[i-1].entryHash);
}
function assertModelNeverSawSecret(run) {
  for(const event of run.events) {
    assert.equal(JSON.stringify(event).includes(privateSentinel),false);
    for(const key of ['signingKey','privateKey','state','secret','signature','policyHash','artifactHash']) {
      assert.equal(Object.hasOwn(event,key),false,'Host trace should not leak '+key);
    }
  }
}
test('M6: real compiler artifact -> Node Host -> separately spawned worker -> authenticated receipt -> terminal matches Standard',async t=>{
  const f=await fixture(t,{osIsolation:process.env.FLOWKIT_M6_ISOLATION==='1'});
  const host=await invoke(f);
  assert.equal(host.code,0,host.stderr);
  assertModelNeverSawSecret(host);
  assert.deepEqual(host.events.map(x=>x.event),[
    'host-start','task-published','worker-exited','receipt-accepted','host-terminal',
  ]);
  assert.equal(host.events[0].status,'waiting');
  assert.equal(host.events.at(-1).status,'succeeded');
  const persisted=f.readStore();
  assertContinuousJournal(persisted);
  assert.equal(persisted.cp.status,'succeeded');
  assert.equal(persisted.cp.state.secret,privateSentinel);
  assert.equal(persisted.cp.state.answer,'external-worker-processed:hello');
  assert.equal(persisted.cp.receipts.length,1);
  assert.equal(persisted.cp.receipts[0].acceptedRevision,
    host.events.find(x=>x.event==='receipt-accepted').acceptedRevision);
  assert.equal(persisted.cp.artifactHash,f.compiled.programIdentity.artifactHash);
  assert.ok(persisted.artifact.bytes.equals(Buffer.from(f.compiled.code)));
  const standard=await f.standardResult();
  assert.equal(standard.terminal,'done');
  assert.equal(sha256Bytes(canonicalBytes(standard.state)),
    sha256Bytes(canonicalBytes(persisted.cp.state)));
  const replay=await invoke(f,'resume');
  assert.equal(replay.code,0);
  assert.deepEqual(replay.events.map(x=>x.event),['host-start','host-terminal']);
  assert.equal(replay.events.at(-1).revision,persisted.cp.revision);
});

test('M6: after Pending publish, killing Host and reopening only persisted Program/Store preserves requestId exactly',async t=>{
  const f=await fixture(t,{osIsolation:process.env.FLOWKIT_M6_ISOLATION==='1'});
  const killed=await invoke(f,'start','after-pending');
  assert.notEqual(killed.code,0,'fault must terminate Host');
  assert.ok(killed.events.some(e=>e.event==='fault-injected'));
  assertModelNeverSawSecret(killed);
  const prior=f.readStore();
  assert.equal(prior.cp.status,'waiting');
  assert.equal(prior.cp.pending.requestId,
    killed.events.find(e=>e.event==='task-published').requestId);
  const revision=prior.cp.revision;
  // No source DSL is needed for resume: Program bytes are retained in Store.
  await rm(f.sourcePath);
  const recovered=await invoke(f,'resume');
  assert.equal(recovered.code,0,recovered.stderr);
  assert.equal(recovered.events.find(x=>x.event==='task-published').requestId,
    prior.cp.pending.requestId);
  assert.ok(recovered.events.find(x=>x.event==='receipt-accepted').acceptedRevision>revision);
  const done=f.readStore();
  assert.equal(done.cp.status,'succeeded');
  assert.equal(done.cp.receipts.length,1);
  assertContinuousJournal(done);
});

test('M6: worker finished but Host crashed before durable receipt; retry preserves Pending identity, not exactly-once provider execution',async t=>{
  const f=await fixture(t);
  const killed=await invoke(f,'start','after-worker');
  assert.notEqual(killed.code,0);
  assert.ok(killed.events.some(e=>e.event==='worker-exited'));
  const before=f.readStore();
  assert.equal(before.cp.status,'waiting');
  assert.equal(before.cp.receipts.length,0);
  const sameRequest=before.cp.pending.requestId;
  const resumed=await invoke(f,'resume');
  assert.equal(resumed.code,0,resumed.stderr);
  assert.equal(resumed.events.find(x=>x.event==='task-published').requestId,sameRequest);
  assert.equal(f.readStore().cp.receipts.length,1);
  assert.equal(f.readStore().cp.state.answer,'external-worker-processed:hello');
});

test('M6: budget 1 versus budget 128 reaches byte-equal terminal State, with monotonic CAS and no fake waiting',async t=>{
  const a=await fixture(t,{stageBudget:1});
  const b=await fixture(t,{stageBudget:128});
  const [fast,slow]=await Promise.all([invoke(a),invoke(b)]);
  assert.equal(fast.code,0,fast.stderr);
  assert.equal(slow.code,0,slow.stderr);
  for(const f of [a,b]) assertContinuousJournal(f.readStore());
  const left=a.readStore(),right=b.readStore();
  assert.equal(sha256Bytes(canonicalBytes(left.cp.state)),
    sha256Bytes(canonicalBytes(right.cp.state)));
  assert.equal(left.cp.status,'succeeded');
  assert.equal(right.cp.status,'succeeded');
  assert.ok(left.cp.revision>=right.cp.revision);
  for(const run of [fast,slow]) {
    assert.equal(run.events.filter(x=>x.event==='task-published').length,1);
    assert.equal(run.events.at(-1).status,'succeeded');
  }
});

test('M6: changed Host disclosure policy denies resume with no journal/CAS mutation',async t=>{
  const f=await fixture(t);
  const killed=await invoke(f,'start','after-pending');
  assert.notEqual(killed.code,0);
  const original=f.readStore();
  const bytes=canonicalBytes(original.cp);
  await f.updateConfig({allowedInputKeys:[]});
  const denied=await invoke(f,'resume');
  assert.notEqual(denied.code,0);
  assert.equal(denied.events.some(x=>x.event==='worker-exited'),false);
  assert.deepEqual(canonicalBytes(f.readStore().cp),bytes);
  assert.equal(f.readStore().journal.length,original.journal.length);
});

test('M6: false Condition chooses failure Terminal without launching worker and equals Standard',async t=>{
  const f=await fixture(t,{ready:false});
  const host=await invoke(f);
  assert.equal(host.code,0,host.stderr);
  assert.equal(host.events.at(-1).status,'failed');
  assert.equal(host.events.some(x=>x.event==='task-published'),false);
  assert.equal(f.readStore().cp.receipts.length,0);
  const standard=await f.standardResult();
  assert.equal(standard.terminal,'declined');
  assert.equal(sha256Bytes(canonicalBytes(standard.state)),
    sha256Bytes(canonicalBytes(f.readStore().cp.state)));
});

test('M6: tampered SQLite artifact byte is rejected before worker dispatch; never silently repaired',async t=>{
  const f=await fixture(t);
  const killed=await invoke(f,'start','after-pending');
  assert.notEqual(killed.code,0);
  const before=f.readStore();
  // External DB corruption is tested through raw SQLite only in this adversarial test.
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(f.config.storePath);
  try {
    db.prepare('UPDATE fk_i_artifacts SET program_bytes = ? WHERE namespace = ? AND artifact_hash = ?')
      .run(Buffer.from('tampered'),f.config.namespace,before.cp.artifactHash);
  } finally {db.close()}
  const attempted=await invoke(f,'resume');
  assert.notEqual(attempted.code,0);
  assert.equal(attempted.events.some(x=>x.event==='worker-exited'),false);
  const cpSnapshot=(()=>{
    const s=createSqliteCheckpointStore(f.config.storePath,{namespace:f.config.namespace});
    try{return s.load(f.config.runId)}finally{s.close()}
  })();
  assert.deepEqual(canonicalBytes(cpSnapshot),canonicalBytes(before.cp));
});

test('M6: model worker with empty inherited environment receives only public task and cannot read Host secret files on isolated Linux',async t=>{
  if(process.env.FLOWKIT_M6_ISOLATION!=='1')return t.skip('Dedicated Linux isolation job runs this proof');
  const f=await fixture(t,{osIsolation:true});
  const run=await invoke(f);
  assert.equal(run.code,0,run.stderr);
  assert.equal(run.events.filter(e=>e.event==='worker-exited').length,1);
  assertModelNeverSawSecret(run);
  assert.equal(f.readStore().cp.status,'succeeded');
});


test('M6 S06: source/Program/Skill bytes changing while waiting fail closed without another Pending',async t=>{
  const cases=[
    {kind:'source',mutate:async f=>writeFile(f.sourcePath,
      workflowText+'\n// unauthorized source edit\n')},
    {kind:'Program artifact',mutate:async f=>writeFile(f.config.programPath,
      Buffer.concat([await readFile(f.config.programPath),Buffer.from('\n// unauthorized artifact edit')]))},
    {kind:'Skill instruction',mutate:async f=>writeFile(f.config.skillPath,
      'Modified Skill instruction after Agent Pending was published')},
  ];
  for(const scenario of cases) {
    const f=await fixture(t);
    const crashed=await invoke(f,'start','after-pending');
    assert.notEqual(crashed.code,0,scenario.kind);
    const before=f.readStore();
    assert.equal(before.cp.status,'waiting');
    const original=canonicalBytes(before.cp);
    await scenario.mutate(f);
    const rejected=await invoke(f,'resume');
    assert.notEqual(rejected.code,0,scenario.kind);
    assert.equal(rejected.events.some(e=>e.event==='worker-exited'),false,scenario.kind);
    assert.deepEqual(canonicalBytes(f.readStore().cp),original,scenario.kind);
    assert.equal(f.readStore().journal.length,before.journal.length,scenario.kind);
  }
});

test('M6 S01: missing Condition input yields persistent FK_R002 error, not waiting or a model task',async t=>{
  const f=await fixture(t);
  await f.updateConfig({state:{message:'hello',secret:privateSentinel}});
  const run=await invoke(f);
  assert.equal(run.code,2,run.stderr);
  assert.equal(run.events.at(-1)?.status,'errored');
  assert.equal(run.events.some(x=>x.event==='worker-exited'),false);
  const persisted=f.readStore();
  assert.equal(persisted.cp.status,'errored');
  assert.equal(persisted.cp.terminal.causeCode,'FK_R002');
  const history=persisted.journal.length;
  const resume=await invoke(f,'resume');
  assert.equal(resume.code,2);
  assert.equal(f.readStore().journal.length,history);
  await assert.rejects(f.standardResult(),{code:'FK_R002'});
});
