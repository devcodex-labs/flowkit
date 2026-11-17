/** Reproducible local workload; reports measurements, never claims model or production validation. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {run,isControlSignal} from '../src/index.mjs';
import * as host from '../src/host.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'flowkit-capacity-'));
const source=id=>`import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'capacity-${id}',version:'1.0.0',name:'Capacity',nodes:[
terminal('done',{name:'Done',status:'succeeded'})]});`;
const options={maxEntries:32,maxBytes:1048576,ttlMs:60000,maxModuleIdentities:256};
if (host.configureCompilationCache) host.configureCompilationCache(options);
const observations={schemaVersion:1,node:process.version,platform:process.platform,arch:process.arch,
  execution:'LOCAL_SCRIPTED_WORKLOAD',workload:{uniqueWorkflows:128,repeatedRuns:128},budget:options};
global.gc?.();const before=process.memoryUsage();
try {
  const filename=path.join(directory,'load.workflow.js');
  let started=performance.now();
  for(let i=0;i<128;i++) {await writeFile(filename,source(i));const result=await run(filename,{isControlSignal});
    if(result.status!=='succeeded') throw new Error('Wrong workload result');}
  observations.uniqueMs=performance.now()-started;started=performance.now();
  for(let i=0;i<128;i++) await run(filename,{isControlSignal});
  observations.repeatedMs=performance.now()-started;
  observations.cache=host.compilationCacheStatus?.() ?? {implementation:'unbounded-map',inferredEntries:128};
  global.gc?.();const after=process.memoryUsage();
  observations.memory={before,after,heapDelta:after.heapUsed-before.heapUsed,rssDelta:after.rss-before.rss};
  host.clearCompilationCache?.();
  observations.afterClear=host.compilationCacheStatus?.() ?? null;
  observations.passed=true;
  const output=process.argv[2];
  if(output) await writeFile(path.resolve(output),JSON.stringify(observations,null,2)+'\n');
  process.stdout.write(JSON.stringify(observations)+'\n');
} finally {await rm(directory,{recursive:true,force:true});}
