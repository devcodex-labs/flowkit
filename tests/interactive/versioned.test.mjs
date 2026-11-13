import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {
  compileInteractive,complete,createInteractiveAdminContext,createInteractiveHostContext,
  createSqliteCheckpointStore,createSqliteInteractivePersistence,resume,start,
} from '../../src/interactive/index.mjs';

const ns='p0a-compatible';
const runtime={
  skillResolver:{id:'skill',version:'1',mode:'trusted-read',implementation:async reference=>'Skill: '+reference},
  validateResult:{id:'schema',version:'1',mode:'pure-local',implementation:(_schema,result)=>
    typeof result.answer==='string'?[]:['Expected answer']},
};
const policy={
  id:'compatibility-test',version:'1',disclosePolicyId:'input-allowlist',capabilityStage:'P0-A',
  canonicalizationVersion:'jcs-rfc8785-v1',bindingManifest:{
    skillResolver:{id:'skill',version:'1',mode:'trusted-read'},
    validateResult:{id:'schema',version:'1',mode:'pure-local'},
  },
};
const source=`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'compat',name:'Compat',version:'1.0.0',nodes:[
node('agent',{name:'Agent',agent:'writer',inputs:['message'],
output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})
]});`;
const bare=`import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'pure',name:'Pure',version:'1.0.0',nodes:[
terminal('done',{name:'Done',status:'succeeded'})
]});`;
function context(overrides={}) {
  return createInteractiveHostContext({namespace:ns,subjectId:'test-host',
    authorize:()=>true,authorizeTask:({task})=>Object.keys(task.input).every(key=>key==='message'),...overrides});
}
async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-compat-'));
  const file=path.join(dir,'cp.sqlite');
  const persistence=createSqliteInteractivePersistence(file,{namespace:ns});
  const raw=createSqliteCheckpointStore(file,{namespace:ns});
  t.after(async()=>{persistence.close();raw.close();await rm(dir,{recursive:true,force:true});});
  const script=path.join(dir,'agent.workflow.js');
  await writeFile(script,source);
  const compiled=await compileInteractive(script,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
  const program=await persistence.programRegistry.putImmutable(Buffer.from(compiled.code),compiled.programIdentity);
  return {dir,file,raw,persistence,compiled,program,options:{...persistence,policy,auth:context(),startKey:'new'}};
}
const submission=(frame,result={answer:'yes'})=>({
  runId:frame.runId,requestId:frame.pending[0].requestId,kind:'agent',outcome:'succeeded',result,
});

test('R5 uses the same persisted envelope in SQLite and the asynchronous Store',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello',secret:'private'},f.options);
  assert.equal(waiting.protocolVersion,1);
  assert.equal(waiting.pending.length,1);
  assert.deepEqual(waiting.pending[0].task.input,{message:'hello'});
  assert.equal(waiting.pending[0].activation,1);
  assert.ok(!JSON.stringify(waiting).includes('private'));
  const idem=await start(f.program,runtime,{message:'hello',secret:'private'},f.options);
  assert.deepEqual(idem,waiting);
  await assert.rejects(start(f.program,runtime,{message:'hello',secret:'private'},
    {...f.options,auth:context({authorize:({action})=>action==='run:create'})}),{code:'FK_I_HOST_DENIED'});
  const envelope=await f.options.store.load(waiting.runId);
  const db=new DatabaseSync(f.file,{readOnly:true});
  try {
    const row=db.prepare('SELECT checkpoint_json,checkpoint_hash FROM fk_i_runs WHERE run_id=?').get(waiting.runId);
    assert.deepEqual(JSON.parse(row.checkpoint_json),envelope);
    assert.equal(row.checkpoint_hash,sha256Bytes(canonicalBytes(envelope)));
    assert.equal(envelope.execution.phase,'awaiting');
    assert.equal(envelope.pending[0].issuedRevision,waiting.revision);
    assert.equal(envelope.policyIdentity.id,policy.id);
    assert.equal(envelope.program.artifactHash,f.program.artifactHash);
    assert.equal(Object.hasOwn(envelope,'artifactHash'),false);
  } finally {db.close();}
  await assert.rejects(start(f.program,runtime,{message:'changed'},f.options),{code:'FK_I_START_CONFLICT'});
  const denied={...f.options,auth:context({authorize:({action})=>action!=='run:complete'})};
  await assert.rejects(complete(submission(waiting),runtime,denied),{code:'FK_I_HOST_DENIED'});
  const forged={...f.options,auth:{...f.options.auth}};
  await assert.rejects(resume(waiting.runId,runtime,forged),{code:'FK_I_HOST_DENIED'});
  await assert.rejects(resume(waiting.runId,runtime,{...f.options,auth:context({authorizeTask:()=>false})}),
    {code:'FK_I_HOST_DENIED'});
  const final=await complete(submission(waiting),runtime,f.options);
  assert.equal(final.status,'succeeded');
  assert.deepEqual(final.pending,[]);
  assert.deepEqual(final.resultRef,{runId:final.runId,revision:final.revision,projectionVersion:1});
  assert.equal(Object.hasOwn(final,'state'),false);
  const privateResult=await f.options.auth.readTerminalResult(final.resultRef,f.options);
  assert.equal(privateResult.state.secret,'private');
  await assert.rejects(context({authorize:({action})=>action!=='result:read'})
    .readTerminalResult(final.resultRef,f.options),{code:'FK_I_HOST_DENIED'});
  const journal=f.raw.listJournal(final.runId);
  for(const row of journal) {
    const transition=await f.options.store.loadTransition(final.runId,row.transitionId);
    assert.equal(transition.transitionId,sha256Bytes(canonicalBytes([
      ns,final.runId,transition.fromRevision,transition.fromBlockId,transition.eventDigest,
      transition.programHash,transition.proposalDigest,
    ])));
  }
  const receipt=await f.options.store.loadReceipt(final.runId,waiting.pending[0].requestId);
  assert.equal(receipt.submissionDigest,sha256Bytes(canonicalBytes(submission(waiting))));
  assert.equal(receipt.acceptedRevision,final.acknowledgement.acceptedRevision);
  assert.equal((await f.options.store.loadTransition(final.runId,receipt.transitionId)).toRevision,receipt.acceptedRevision);
  const wrongTenant=createSqliteInteractivePersistence(f.file,{namespace:'other'});
  try {
    assert.equal(await wrongTenant.store.load(final.runId),null);
    assert.equal(await wrongTenant.store.loadReceipt(final.runId,waiting.pending[0].requestId),null);
    assert.equal(await wrongTenant.store.loadTransition(final.runId,receipt.transitionId),null);
  } finally {wrongTenant.close();}
  await assert.rejects(f.options.programRegistry.release(final.runId,f.program.artifactHash),{code:'FK_I_ARTIFACT_IN_USE'});
});

test('R5 CAS recovers from a lost response only with durable transition evidence',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello'},f.options);
  let lose=true, recoveredId;
  const dropping={...f.options.store,
    async compareAndSwap(runId,revision,tx) {
      const result=await f.options.store.compareAndSwap(runId,revision,tx);
      if(lose && tx.receipt && result.committed) {
        lose=false;
        recoveredId=tx.transition.transitionId;
        throw new Error('lost response');
      }
      return result;
    },
  };
  const result=await complete(submission(waiting),runtime,{...f.options,store:dropping});
  assert.equal(result.status,'succeeded');
  assert.equal((await f.options.store.loadTransition(result.runId,recoveredId)).toRevision,
    result.acknowledgement.acceptedRevision);
  const before=f.raw.listJournal(result.runId);
  const replay=await complete(submission(waiting),runtime,f.options);
  assert.equal(replay.acknowledgement.repeated,true);
  assert.deepEqual(f.raw.listJournal(result.runId),before);

  const second=await start(f.program,runtime,{message:'again'},{...f.options,startKey:'uncertain'});
  const stale=await f.options.store.load(second.runId);
  let attempted=0;
  const unusable={...f.options.store,
    async load(){return stale;},
    async compareAndSwap(){attempted++;throw new Error('database unavailable');},
    async loadTransition(){return null;},
  };
  await assert.rejects(complete(submission(second),runtime,{...f.options,store:unusable}),
    {code:'FK_I_STORE_UNCERTAIN'});
  assert.equal(attempted,1);
  assert.deepEqual(await f.options.store.load(second.runId),stale);
});

test('R5 file source works without Agent bindings and honors pre-aborted operations',async t=>{
  const f=await fixture(t);
  const file=path.join(f.dir,'terminal.workflow.js');
  await writeFile(file,bare);
  const opts={...f.options,policy:{...policy,bindingManifest:{}},startKey:'pure'};
  await assert.rejects(start(file,{}, {},{...opts,signal:AbortSignal.abort()}),{name:'AbortError'});
  const result=await start(file,{}, {secret:'private'},opts);
  assert.equal(result.status,'succeeded');
  assert.equal(Object.hasOwn(result,'state'),false);
  assert.equal(result.terminal.nodeId,'done');
});

test('S12-A creates its audit table in a fresh R5 database and atomically terminates without the Program',async t=>{
  const f=await fixture(t);
  const waiting=await start(f.program,runtime,{message:'hello'},f.options);
  const before=f.raw.load(waiting.runId);
  const journal=f.raw.listJournal(waiting.runId);
  const admin=createInteractiveAdminContext({namespace:ns,subjectId:'ops-1',authorize:()=>true});
  const persisted=f.persistence;
  {
    const db=new DatabaseSync(f.file);
    const audit=()=>db.prepare('SELECT * FROM fk_i_admin_events').all();
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',{...admin}),
        {code:'FK_I_HOST_DENIED'});
      const other=createInteractiveAdminContext({namespace:'another',subjectId:'ops-1',authorize:()=>true});
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',other),{code:'FK_I_HOST_DENIED'});
      assert.deepEqual(audit(),[]);
      db.exec(`CREATE TRIGGER force_audit_failure BEFORE INSERT ON fk_i_admin_events
        BEGIN SELECT RAISE(ABORT,'audit fixture failure'); END`);
      await assert.rejects(persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',admin),/audit fixture failure/);
      assert.deepEqual(f.raw.load(waiting.runId),before);
      assert.deepEqual(f.raw.listJournal(waiting.runId),journal);
      assert.deepEqual(audit(),[]);
      db.exec('DROP TRIGGER force_audit_failure');
      // A deliberately broken test fixture models an unavailable artifact.
      // The management action must not open or verify Program bytes.
      db.prepare('UPDATE fk_i_artifacts SET program_bytes=? WHERE namespace=? AND artifact_hash=?')
        .run(Buffer.from('unavailable'),ns,before.artifactHash);
      const result=await persisted.adminController.adminTerminate(waiting.runId,'OPERATOR',admin);
      assert.equal(result.status,'cancelled');
      assert.equal(result.revision,before.revision+1);
      assert.deepEqual(result.pending,[]);
      assert.equal(Object.hasOwn(result,'state'),false);
      const opts={...f.options,...persisted};
      assert.deepEqual(await resume(waiting.runId,runtime,opts),result);
      await assert.rejects(complete(submission(waiting),runtime,opts),{code:'FK_I_STALE_RECEIPT'});
      assert.deepEqual(await persisted.adminController.adminTerminate(waiting.runId,'REPEATED',admin),result);
      const [record]=audit();
      assert.equal(record.admin_subject_id,'ops-1');
      assert.equal(record.reason_code,'OPERATOR');
      assert.equal((await persisted.store.loadTransition(waiting.runId,record.transition_id)).toRevision,result.revision);
      assert.equal(audit().length,1);
    } finally {db.close();}
  }
});

test('S12-A terminal completion and management termination have a single final transition',async t=>{
  const f=await fixture(t);
  const migrated=createSqliteInteractivePersistence(f.file,{namespace:ns});
  try {
    const opts={...f.options,...migrated};
    const waiting=await start(f.program,runtime,{message:'hello'},opts);
    let entered;
    const gate=new Promise(resolve=>{entered=resolve;});
    let release;
    const hold=new Promise(resolve=>{release=resolve;});
    const controlled={...opts,store:{...opts.store,async compareAndSwap(runId,revision,tx) {
      if (tx.next.status==='succeeded') {
        entered();
        await hold;
      }
      return opts.store.compareAndSwap(runId,revision,tx);
    }}};
    const completing=complete(submission(waiting),runtime,controlled);
    await Promise.race([gate,completing.then(()=>assert.fail('terminal barrier not reached'))]);
    try {
      const admin=createInteractiveAdminContext({namespace:ns,subjectId:'ops-1',authorize:()=>true});
      const ended=await migrated.adminController.adminTerminate(waiting.runId,'OPERATOR',admin);
      assert.equal(ended.status,'cancelled');
      release();
      assert.equal((await completing).status,'cancelled');
      assert.equal(f.raw.listJournal(waiting.runId).at(-1).entry.kind,'admin-terminate');
      assert.equal(f.raw.listJournal(waiting.runId).filter(row=>row.entry.kind==='admin-terminate').length,1);
      const another=await start(f.program,runtime,{message:'hello'},{...opts,startKey:'completion-first'});
      const completed=await complete(submission(another),runtime,opts);
      const before=f.raw.listJournal(another.runId);
      assert.equal((await migrated.adminController.adminTerminate(another.runId,'OPERATOR',admin)).status,'succeeded');
      assert.equal(completed.revision,before.at(-1).revision);
      assert.deepEqual(f.raw.listJournal(another.runId),before);
    } finally {release(); await completing.catch(()=>{});}
  } finally {migrated.close();}
});
