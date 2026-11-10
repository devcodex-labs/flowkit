import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';

const dirs=[];
after(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true})});
const runtime={
  skillResolver:async ()=>'Agent instruction',
  validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['invalid answer'],
};
async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-m4-cut-'));
  dirs.push(dir);
  const file=path.join(dir,'state.db');
  const source="import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';\n"+
    "export default defineWorkflow({id:'crash-agent',version:'1.0.0',name:'Crash',nodes:["+
    "node('worker',{name:'Worker',agent:'writer',inputs:['preexisting'],"+
    "output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),"+
    "terminal('done',{name:'Done',status:'succeeded'})]});";
  const analyzed=await analyzeSource(source,{filename:'crash.workflow.js',projectRoot:process.cwd(),skillCheck:false});
  assert.ok(!analyzed.diagnostics.some(x=>x.severity==='error'),JSON.stringify(analyzed.diagnostics));
  const ir=lowerInteractive(analyzed);
  assert.ok(ir.ir,JSON.stringify(ir.diagnostics));
  const emitted=emitInteractive(ir.ir);
  const compiled={bytes:Buffer.from(emitted.code),identity:emitted.programIdentity};
  const db=createSqliteCheckpointStore(file,{namespace:'test-host'});
  t.after(()=>db.close());
  const api=createInteractiveCoordinator({store:db,runtime});
  return {file,compiled,db,api};
}

const moduleStore=new URL('../../src/interactive/sqlite-store.mjs',import.meta.url).href;
const moduleCoordinator=new URL('../../src/interactive/coordinator.mjs',import.meta.url).href;
const childScript=[
  'import {createSqliteCheckpointStore} from '+JSON.stringify(moduleStore)+';',
  'import {createInteractiveCoordinator} from '+JSON.stringify(moduleCoordinator)+';',
  "import {writeSync} from 'node:fs';",
  'const [filename,mode,phase,side,runId,bytes64,identity,receiptJson]=process.argv.slice(1);',
  "const db=createSqliteCheckpointStore(filename,{namespace:'test-host'});",
  'let observed=false;',
  'const kill=()=>{observed=true;writeSync(1,"M4_CUT\\n");process.kill(process.pid,"SIGKILL");};',
  'const store={...db,compareAndSwap(args){',
  '  const isTarget=args.nextCheckpoint.phase===phase &&',
  '    (mode==="start" || args.nextCheckpoint.revision>6);',
  '  if(isTarget && side==="before")kill();',
  '  const answer=db.compareAndSwap(args);',
  '  if(isTarget && answer.committed && side==="after")kill();',
  '  return answer;',
  '}};',
  'const api=createInteractiveCoordinator({store,runtime:{',
  '  skillResolver:async()=>"Agent instruction",',
  '  validateResult:(_schema,r)=>typeof r?.answer==="string"?[]:["invalid answer"],',
  '}});',
  'if(mode==="start")await api.start({',
  '  runId,programBytes:Buffer.from(bytes64,"base64"),programIdentity:JSON.parse(identity),',
  '  startKey:"host-cut",state:{preexisting:"constant"},',
  '});else await api.complete(JSON.parse(receiptJson));',
  'if(!observed)throw new Error("CUT_NOT_HIT");',
].join('\n');

async function spawnAndKill({file,compiled,mode,phase,side,runId,receipt}) {
  const args=['--input-type=module','-e',childScript,
    file,mode,phase,side,runId,compiled.bytes.toString('base64'),
    JSON.stringify(compiled.identity),JSON.stringify(receipt??null)];
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',b=>{stdout+=b});
    child.stderr.on('data',b=>{stderr+=b});
    child.on('error',reject);
    child.on('close',(exitCode,signal)=>{
      if(!stdout.includes('M4_CUT'))return reject(new Error(
        'No forced cut at '+mode+'/'+phase+'/'+side+'; exit='+exitCode+
        ' signal='+signal+'; stderr='+stderr
      ));
      if(exitCode===0)return reject(new Error('Worker survived SIGKILL'));
      resolve({exitCode,signal});
    });
  });
}

test('M4 real process SIGKILL before/after Agent preparation and durable publish resumes once',async t=>{
  for(const side of ['before','after']){
    const {file,compiled,db,api}=await fixture(t);
    const runId='start-'+side;
    await spawnAndKill({file,compiled,mode:'start',phase:'awaiting',side,runId});
    const checkpoint=db.load(runId);
    assert.ok(checkpoint);
    assert.ok(['dispatch-ready','awaiting'].includes(checkpoint.phase));
    const waiting=await api.resume({runId});
    assert.equal(waiting.status,'waiting');
    assert.equal(waiting.pending.attempt,1);
    assert.equal(waiting.pending.nodeId,'worker');
    const again=await api.resume({runId});
    assert.equal(again.pending.requestId,waiting.pending.requestId);
    assert.equal(again.revision,waiting.revision);
    const done=await api.complete({
      runId,requestId:waiting.pending.requestId,nodeId:'worker',attempt:1,
      result:{answer:'complete'},
    });
    assert.equal(done.status,'succeeded');
    assert.equal(done.state.answer,'complete');
    assert.equal(db.load(runId).receipts.length,1);
    assert.deepEqual(db.listJournal(runId).map(x=>x.revision),
      Array.from({length:done.revision+1},(_,i)=>i));
  }
});

test('M4 real process SIGKILL before/after receipt acceptance, validation and state commit',async t=>{
  for(const phase of ['validate','commit','route']){
    for(const side of ['before','after']){
      const {file,compiled,db,api}=await fixture(t);
      const runId='complete-'+phase+'-'+side;
      const waiting=await api.start({
        runId,programBytes:compiled.bytes,programIdentity:compiled.identity,
        startKey:runId,state:{preexisting:'constant'},
      });
      assert.equal(waiting.status,'waiting');
      const receipt={
        runId,requestId:waiting.pending.requestId,nodeId:'worker',attempt:1,
        result:{answer:'once'},
      };
      await spawnAndKill({file,compiled,mode:'complete',phase,side,runId,receipt});
      const observed=db.load(runId);
      assert.ok(['waiting','running'].includes(observed.status));
      let finished;
      if(observed.status==='waiting') finished=await api.complete(receipt);
      else finished=await api.resume({runId});
      assert.equal(finished.status,'succeeded');
      assert.deepEqual(finished.state,{preexisting:'constant',answer:'once'});
      const duplicate=await api.complete(receipt);
      assert.equal(duplicate.duplicate,true);
      assert.equal(duplicate.acceptedRevision,db.load(runId).receipts[0].acceptedRevision);
      assert.equal(duplicate.revision,finished.revision);
      assert.equal(db.load(runId).receipts.length,1);
      assert.deepEqual(db.listJournal(runId).map(x=>x.revision),
        Array.from({length:finished.revision+1},(_,i)=>i));
    }
  }
});
