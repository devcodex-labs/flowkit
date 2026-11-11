import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';

const roots=[];
after(async()=>{for(const dir of roots)await rm(dir,{recursive:true,force:true})});
const dsl="import {defineWorkflow,node,condition,terminal} from '@devcodex-labs/flowkit/dsl';\n";
const named=(agent,extra="")=>dsl+
  "export default defineWorkflow({id:'stage2-contract',version:'1.0.0',name:'Stage2',nodes:["+
  "node('worker',{name:'Worker',"+agent+",inputs:[],output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'"+
  extra+"}),terminal('done',{name:'Done',status:'succeeded'})]});";
const pure=dsl+"export default defineWorkflow({id:'stage2-pure',version:'1.0.0',name:'Pure',nodes:["+
  "condition('gate',{name:'Gate',branches:[{when:'ready',next:'done'},{when:'true',next:'fail'}]}),"+
  "terminal('done',{name:'Done',status:'succeeded'}),"+
  "terminal('fail',{name:'Fail',status:'failed'})]});";
async function project(){
  const root=await mkdtemp(path.join(tmpdir(),'fk-stage2-'));
  roots.push(root);
  const workflows=path.join(root,'workflows');
  await mkdir(workflows,{recursive:true});
  await writeFile(path.join(root,'package.json'),'{"type":"module","private":true}');
  return {root,workflows};
}
async function runStore(t,root){
  const store=createSqliteCheckpointStore(path.join(root,'run.sqlite'),{namespace:'stage2'});
  t.after(()=>store.close());
  return store;
}
function hasError(compiled){return compiled.diagnostics.some(x=>x.severity==='error')}
function minimalRuntime(){
  return {
    skillResolver:async()=>'write an answer',
    validateResult:(_schema,result)=>typeof result?.answer==='string'?[]:['answer required'],
  };
}

test('S2 nested project: Interactive and original Standard analyzer use same nearest package.json root',async()=>{
  const {root,workflows}=await project();
  await mkdir(path.join(root,'skills'));
  await writeFile(path.join(root,'skills','writer.md'),'# Stable writer');
  const file=path.join(workflows,'task.workflow.js');
  const text=named("agent:'writer'");
  await writeFile(file,text);
  const options={output:'memory',featureStage:'P0-A'};
  const compiled=await compileInteractive(file,options);
  assert.equal(hasError(compiled),false,JSON.stringify(compiled.diagnostics));
  assert.equal(compiled.programIdentity.implementedStage,'P0-A');
  assert.ok(compiled.code.includes('writer'));
  const standard=await analyzeSource(Buffer.from(text),{filename:file});
  assert.deepEqual(compiled.diagnostics,standard.diagnostics);
  const same=await compileInteractive(file,{...options,projectRoot:root});
  assert.equal(compiled.code,same.code);
  assert.deepEqual(compiled.programIdentity,same.programIdentity);
  // An explicitly incorrect root gives the same original diagnostic as Standard.
  const wrong=await compileInteractive(file,{...options,projectRoot:workflows});
  assert.ok(wrong.diagnostics.some(x=>x.code==='FK_C051'));
  const original=await analyzeSource(Buffer.from(text),{
    filename:file,projectRoot:workflows,
  });
  assert.deepEqual(wrong.diagnostics,original.diagnostics);
});

test('S2 custom skillsRoot and skillCheck match Standard static checks, no runtime Skill fetching',async()=>{
  const {root,workflows}=await project();
  const file=path.join(workflows,'custom.workflow.ts');
  const text=named("agent:'writer'").replace("status:'succeeded'","status:'succeeded' as const");
  await writeFile(file,text);
  const base={output:'memory',featureStage:'P0-A'};
  const missing=await compileInteractive(file,base);
  assert.ok(missing.diagnostics.some(d=>d.code==='FK_C051'));
  const unchecked=await compileInteractive(file,{...base,skillCheck:false});
  assert.equal(hasError(unchecked),false,JSON.stringify(unchecked.diagnostics));
  await mkdir(path.join(root,'custom-skills'));
  await writeFile(path.join(root,'custom-skills','writer.md'),'# Writer v2');
  const configured=await compileInteractive(file,{...base,skillsRoot:'custom-skills'});
  assert.equal(hasError(configured),false,JSON.stringify(configured.diagnostics));
  const standard=await analyzeSource(Buffer.from(text),{
    filename:file,skillsRoot:'custom-skills',
  });
  assert.deepEqual(configured.diagnostics,standard.diagnostics);
  const wrong=await compileInteractive(file,{...base,skillsRoot:'does-not-exist'});
  assert.ok(wrong.diagnostics.some(x=>x.code==='FK_C051'));
  assert.deepEqual(wrong.diagnostics,(await analyzeSource(Buffer.from(text),{
    filename:file,skillsRoot:'does-not-exist',
  })).diagnostics);
});

test('S2 HTTPS Skill allowlist and integrity match Standard analyzer; no network access',async()=>{
  const {root,workflows}=await project();
  const file=path.join(workflows,'remote.workflow.js');
  const integrity='sha256-'+Buffer.alloc(32,5).toString('base64');
  const text=named("skill:'https://skills.example.test/writer.md'",",integrity:'"+integrity+"'");
  await writeFile(file,text);
  const base={output:'memory',featureStage:'P0-A'};
  const refused=await compileInteractive(file,base);
  assert.ok(refused.diagnostics.some(x=>x.code==='FK_C057'));
  const allowed=await compileInteractive(file,{...base,remoteSkillHosts:['skills.example.test']});
  assert.equal(hasError(allowed),false,JSON.stringify(allowed.diagnostics));
  assert.equal(allowed.diagnostics.some(x=>x.code==='FK_C059'),false);
  const standard=await analyzeSource(Buffer.from(text),{
    filename:file,remoteSkillHosts:['skills.example.test'],
  });
  assert.deepEqual(allowed.diagnostics,standard.diagnostics);
  await assert.rejects(compileInteractive(file,{
    ...base,remoteSkillHosts:'skills.example.test',
  }),/Invalid option type: remoteSkillHosts/);
  const withoutIntegrity=text.replace(",integrity:'"+integrity+"'","");
  await writeFile(file,withoutIntegrity);
  const warn=await compileInteractive(file,{...base,remoteSkillHosts:['skills.example.test']});
  assert.equal(hasError(warn),false);
  assert.ok(warn.diagnostics.some(x=>x.code==='FK_C059'&&x.severity==='warning'));
});

test('S2 compiler refuses unrelated Standard options and accessors before any write',async()=>{
  const {root,workflows}=await project();
  const file=path.join(workflows,'simple.workflow.js');
  await writeFile(file,pure);
  const base={output:'memory',featureStage:'P0-A'};
  await assert.rejects(compileInteractive(file,{...base,trace:true}),/Unknown Interactive/);
  await assert.rejects(compileInteractive(file,{...base,mermaid:false}),/Unknown Interactive/);
  await assert.rejects(compileInteractive(file,{...base,projectRoot:42}),/Invalid option type: projectRoot/);
  await assert.rejects(compileInteractive(file,{...base,skillCheck:'yes'}),/Invalid option type: skillCheck/);
  const accessor={...base};
  Object.defineProperty(accessor,'skillsRoot',{enumerable:true,get(){throw Error('should not run')}});
  await assert.rejects(compileInteractive(file,accessor),/accessors forbidden/i);
  const bad={...base};
  bad.remoteSkillHosts=[null];
  await assert.rejects(compileInteractive(file,bad),/Invalid option type: remoteSkillHosts/);
  const out=await compileInteractive(file,base);
  assert.equal(hasError(out),false);
  const disk=await compileInteractive(file,{...base,output:'file',outDir:root});
  assert.equal(await readFile(disk.artifactPath,'utf8'),out.code);
});

test('S2 harmless shared Host checkStep does not block pure Condition/Terminal, but Agent remains fail-closed',async t=>{
  const {root,workflows}=await project();
  const pureFile=path.join(workflows,'pure.workflow.js');
  await writeFile(pureFile,pure);
  const pureProgram=await compileInteractive(pureFile,{output:'memory',featureStage:'P0-A'});
  assert.equal(hasError(pureProgram),false);
  const store=await runStore(t,root);
  const sharedRuntime={checkStep:async()=>true};
  const pureCoordinator=createInteractiveCoordinator({store,runtime:sharedRuntime});
  const succeeded=await pureCoordinator.start({
    programBytes:Buffer.from(pureProgram.code),
    programIdentity:pureProgram.programIdentity,
    runId:'shared-pure',startKey:'shared-pure',state:{ready:true},
  });
  assert.equal(succeeded.status,'succeeded');
  assert.equal((await pureCoordinator.resume({runId:succeeded.runId})).revision,succeeded.revision);
  assert.deepEqual(succeeded.state,{ready:true});
  const agentFile=path.join(workflows,'agent.workflow.js');
  await writeFile(agentFile,named("agent:'writer'"));
  const agentProgram=await compileInteractive(agentFile,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.equal(hasError(agentProgram),false);
  const agentCoordinator=createInteractiveCoordinator({store,runtime:{
    ...minimalRuntime(),checkStep:()=>true,
  }});
  await assert.rejects(agentCoordinator.start({
    programBytes:Buffer.from(agentProgram.code),
    programIdentity:agentProgram.programIdentity,
    runId:'shared-agent',startKey:'shared-agent',
  }),{code:'FK_I_UNSUPPORTED_GRAPH'});
  assert.equal(store.load('shared-agent'),null);
});

test('S2 Host-declared bindingVersions in existing policy hash prohibit drift on resume with no mutation',async t=>{
  const {root,workflows}=await project();
  const file=path.join(workflows,'agent.workflow.js');
  await writeFile(file,named("agent:'writer'"));
  const compiled=await compileInteractive(file,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.equal(hasError(compiled),false);
  const store=await runStore(t,root);
  const versions={
    'runtime.skillResolver':'writer-skill/v1.sha256:a',
    'runtime.validateResult':'validator/v1.sha256:b',
  };
  const runtime=minimalRuntime();
  const initialPolicy={deploymentId:'stage2',bindingVersions:versions};
  const api=createInteractiveCoordinator({store,runtime,policy:initialPolicy});
  const started=await api.start({
    programBytes:Buffer.from(compiled.code),
    programIdentity:compiled.programIdentity,
    runId:'version-pinned',startKey:'version-pinned',
  });
  assert.equal(started.status,'waiting');
  const original=canonicalBytesFor(store.load(started.runId));
  const journal=store.listJournal(started.runId);
  const evolved=createInteractiveCoordinator({store,runtime:{
    ...runtime,validateResult:()=>['new behavior'],
  },policy:{
    deploymentId:'stage2',bindingVersions:{...versions,
      'runtime.validateResult':'validator/v2.sha256:c'},
  }});
  await assert.rejects(evolved.resume({runId:started.runId}),{code:'FK_I_POLICY_MISMATCH'});
  await assert.rejects(evolved.complete({
    runId:started.runId,requestId:started.pending.requestId,
    nodeId:started.pending.nodeId,attempt:started.pending.attempt,
    result:{answer:'x'},
  }),{code:'FK_I_POLICY_MISMATCH'});
  assert.deepEqual(canonicalBytesFor(store.load(started.runId)),original);
  assert.deepEqual(store.listJournal(started.runId),journal);
  const reconnected=createInteractiveCoordinator({store,runtime,policy:{
    deploymentId:'stage2',bindingVersions:{...versions},
  }});
  const completed=await reconnected.complete({
    runId:started.runId,requestId:started.pending.requestId,
    nodeId:started.pending.nodeId,attempt:started.pending.attempt,
    result:{answer:'x'},
  });
  assert.equal(completed.status,'succeeded');
  assert.equal(completed.state.answer,'x');
});
function canonicalBytesFor(value){
  // JSON serialization is sufficient for unmodified reference Store load
  // byte comparisons here; test only equality, not a schema-level hash.
  return Buffer.from(JSON.stringify(value));
}
