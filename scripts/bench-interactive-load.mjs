/**
 * Diagnostic-only benchmark, not a correctness/latency gate.
 * Measures repeated exact-byte Program loads and a P0-A multi-stage Run.
 * Never modifies the generated Program, security, or checkpoint semantics.
 *
 * Run after npm ci: node scripts/bench-interactive-load.mjs
 */
import {performance} from 'node:perf_hooks';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeSource} from '../src/compiler/analyze.mjs';
import {lowerInteractive} from '../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../src/compiler/interactive/emit.mjs';
import {loadInteractiveProgram} from '../src/interactive/load.mjs';
import {createSqliteCheckpointStore} from '../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../src/interactive/coordinator.mjs';

const N=16;
const conditions=[];
for(let i=0;i<N;i++){
  conditions.push("condition('gate"+i+"',{name:'Gate "+i+"',branches:["+
    "{when:'true',next:'"+(i===N-1?'done':'gate'+(i+1))+"'}]})");
}
conditions.push("terminal('done',{name:'Done',status:'succeeded'})");
const source=[
  "import {defineWorkflow,condition,terminal} from '@devcodex-labs/flowkit/dsl';",
  "export default defineWorkflow({id:'bench-interactive',version:'1.0.0',name:'Benchmark',nodes:["+
    conditions.join(',')+"]});",
].join('\n');
const analysis=await analyzeSource(source,{filename:'bench.workflow.js',
  projectRoot:process.cwd(),skillCheck:false});
if(analysis.diagnostics.some(x=>x.severity==='error')) throw new Error(
  JSON.stringify(analysis.diagnostics));
const ir=lowerInteractive(analysis);
if(!ir.ir) throw new Error(JSON.stringify(ir.diagnostics));
const emitted=emitInteractive(ir.ir);
if(!emitted.code) throw new Error(JSON.stringify(emitted.diagnostics));
const bytes=Buffer.from(emitted.code);
const hash=emitted.programIdentity.artifactHash;
const samples=[];
for(let i=0;i<32;i++){
  const start=performance.now();
  await loadInteractiveProgram(bytes,hash);
  if(i>=4)samples.push(performance.now()-start);
}
samples.sort((a,b)=>a-b);
const temp=await mkdtemp(path.join(tmpdir(),'fk-stage2-bench-'));
let store;
try{
  store=createSqliteCheckpointStore(path.join(temp,'run.sqlite'),{namespace:'stage2-bench'});
  let artifactReads=0;
  let artifactReadMs=0;
  const decorated={
    ...store,
    getArtifact(digest){
      const start=performance.now();
      const result=store.getArtifact(digest);
      artifactReads++;
      artifactReadMs+=performance.now()-start;
      return result;
    },
  };
  const api=createInteractiveCoordinator({store:decorated,runtime:{}});
  const startedAt=performance.now();
  const completed=await api.start({
    programBytes:bytes,programIdentity:emitted.programIdentity,
    runId:'stage2-bench-1',startKey:'stage2-bench-1',state:{ready:true},
  });
  const totalMs=performance.now()-startedAt;
  if(completed.status!=='succeeded' || completed.state.ready!==true) {
    throw new Error('Benchmark workflow did not reach successful terminal');
  }
  const revisions=store.listJournal(completed.runId).length;
  console.log('STAGE2_PROGRAM_LOAD_BENCH '+JSON.stringify({
    schemaVersion:1,nodeVersion:process.version,os:process.platform,
    programBytes:bytes.length,conditionNodes:N,
    loadSamples:samples.length,
    loadMedianMs:Number(samples[Math.floor(samples.length/2)].toFixed(3)),
    loadP90Ms:Number(samples[Math.floor(samples.length*.9)].toFixed(3)),
    totalRunMs:Number(totalMs.toFixed(3)),
    artifactReads,
    artifactReadTotalMs:Number(artifactReadMs.toFixed(3)),
    journalRevisions:revisions,
    finalStatus:completed.status,
    note:'single-run sampled diagnostics; no production SLA or cache change',
  }));
}finally{
  try{store?.close()}finally{await rm(temp,{force:true,recursive:true})}
}
