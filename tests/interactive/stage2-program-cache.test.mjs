import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {canonicalBytes} from '../../src/interactive/canonical.mjs';

const roots=[];
after(async()=>{for(const x of roots)await rm(x,{recursive:true,force:true})});
const src=[
  "import {defineWorkflow,condition,terminal} from '@devcodex-labs/flowkit/dsl';",
  "export default defineWorkflow({id:'s2-cache',version:'1.0.0',name:'Cache',nodes:[",
  "condition('gate',{name:'Gate',branches:[{when:'ready',next:'done'},{when:'true',next:'fail'}]}),",
  "terminal('done',{name:'Done',status:'succeeded'}),",
  "terminal('fail',{name:'Fail',status:'failed'})]});",
].join('\n');
async function fixture(t,maxStagesPerCall=1){
  const dir=await mkdtemp(path.join(tmpdir(),'fk-s2-cache-'));
  roots.push(dir);
  const analysis=await analyzeSource(src,{filename:'cache.workflow.js',
    projectRoot:dir,skillCheck:false});
  assert.equal(analysis.diagnostics.some(x=>x.severity==='error'),false,
    JSON.stringify(analysis.diagnostics));
  const ir=lowerInteractive(analysis);
  assert.ok(ir.ir,JSON.stringify(ir.diagnostics));
  const compiled=emitInteractive(ir.ir);
  assert.ok(compiled.code);
  const program={
    programBytes:Buffer.from(compiled.code),
    programIdentity:compiled.programIdentity,
  };
  const store=createSqliteCheckpointStore(path.join(dir,'cache.sqlite'),{namespace:'s2-cache'});
  t.after(()=>store.close());
  let corruption=null,artifactReads=0;
  const verifiedStore={
    ...store,
    getArtifact(hash){
      artifactReads++;
      const saved=store.getArtifact(hash);
      if(!saved)return saved;
      if(corruption==='missing')return null;
      if(corruption==='bytes'){
        const changed=Buffer.from(saved.bytes);
        changed[0]^=1;
        return {...saved,bytes:changed};
      }
      if(corruption==='identity')return {
        ...saved,programIdentity:{...saved.programIdentity,compilerVersion:'spoofed-version'},
      };
      return saved;
    },
  };
  const api=createInteractiveCoordinator({
    store:verifiedStore,runtime:{checkStep:()=>true},
    maxStagesPerCall,
  });
  return {
    store,api,program,
    setCorruption(value){corruption=value},
    get reads(){return artifactReads},
  };
}
async function complete(api,frame){
  for(let i=0;i<25 && frame.status==='paused';i++){
    frame=await api.resume({runId:frame.runId});
  }
  assert.equal(frame.status,'succeeded');
  return frame;
}

test('Stage2 Program cache is never trusted before re-reading exact Store bytes/identity/policy',async t=>{
  const f=await fixture(t,1);
  const frame=await f.api.start({...f.program,runId:'cache-run',startKey:'cache-run',
    state:{ready:true,checkpoint:'keep'}});
  assert.equal(frame.status,'paused');
  assert.ok(f.reads>=1);
  const baseline=canonicalBytes(f.store.load(frame.runId));
  const beforeJournal=f.store.listJournal(frame.runId);
  for(const mode of ['missing','bytes','identity']){
    const beforeReads=f.reads;
    f.setCorruption(mode);
    await assert.rejects(f.api.resume({runId:frame.runId}),error=>
      error.code==='FK_I_PROGRAM_MISMATCH' || /Program manifest mismatch|compiled Program/.test(error.message));
    assert.ok(f.reads>beforeReads,'Store must be consulted even with a warm cache');
    assert.deepEqual(canonicalBytes(f.store.load(frame.runId)),baseline);
    assert.deepEqual(f.store.listJournal(frame.runId),beforeJournal);
  }
  f.setCorruption(null);
  const completed=await complete(f.api,frame);
  assert.deepEqual(completed.state,{ready:true,checkpoint:'keep'});
  assert.equal(f.store.listJournal(frame.runId).length,completed.revision+1);
});

test('Stage2 repeated safe loads keep original phase/Journaling invariants',async t=>{
  const f=await fixture(t,1);
  const frame=await f.api.start({...f.program,runId:'cache-repeat',startKey:'cache-repeat',
    state:{ready:true}});
  assert.equal(frame.status,'paused');
  const result=await complete(f.api,frame);
  assert.ok(f.reads>=3,'Program bytes are re-read and checked at each phase');
  assert.equal(result.state.ready,true);
  assert.equal((await f.api.load({runId:result.runId})).revision,result.revision);
  assert.equal((await f.api.resume({runId:result.runId})).status,'succeeded');
  assert.equal(f.store.listJournal(result.runId).length,result.revision+1);
});
