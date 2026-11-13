import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {compileInteractive,createInteractiveCoordinator,createSqliteCheckpointStore}
  from '../src/interactive/index.mjs';
import {canonicalBytes,sha256Bytes} from '../src/interactive/canonical.mjs';

const dir=await mkdtemp(path.join(tmpdir(),'flowkit-ledger-measure-'));
const agents=300;
const nodes=Array.from({length:agents},(_,index)=>{
  const next=index+1===agents?'done':'agent'+(index+1);
  return `node('agent${index}',{name:'Agent ${index}',agent:'writer',inputs:[],
    output:{type:'object',properties:{answer${index}:{type:'string'}}},retries:0,next:'${next}'})`;
});
const source=`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'m6-ledger',name:'Ledger measurement',version:'1.0.0',nodes:[
${nodes.join(',\n')},
terminal('done',{name:'Done',status:'succeeded'})
]});`;
const runtime={
  skillResolver:async()=> 'Write one bounded answer',
  validateResult:(schema,result)=>Object.keys(result).length===1
    && Object.keys(schema.properties).every(key=>typeof result[key]==='string')?[]:['Expected one string answer'],
};

async function fileBytes(file) {
  try {return (await stat(file)).size;}
  catch (error) {if (error.code==='ENOENT') return 0; throw error;}
}

function latency(samples) {
  const sorted=[...samples].sort((a,b)=>a-b);
  const percentile=p=>Number(sorted[Math.ceil(p*sorted.length)-1].toFixed(3));
  return {p50:percentile(.50),p95:percentile(.95),p99:percentile(.99)};
}

async function measure(program,maxStagesPerCall) {
  const database=path.join(dir,'ledger-'+maxStagesPerCall+'.sqlite');
  const namespace='ledger-measure';
  const runId='ledger';
  const receipts=[];
  const samples=[];
  const bytes={checkpointSerializedTotal:0,checkpointLargest:0,walHighWaterSample:0};
  let casAttempts=0,casCommitted=0,pauseCalls=0;
  let finalStateHash,stats,firstReceipt;
  const store=createSqliteCheckpointStore(database,{namespace});
  try {
    const instrumented={
      ...store,
      compareAndSwap(args) {
        const size=canonicalBytes(args.nextCheckpoint).byteLength;
        const result=store.compareAndSwap(args);
        casAttempts++;
        if (result.committed) {
          casCommitted++;
          bytes.checkpointSerializedTotal+=size;
          bytes.checkpointLargest=Math.max(bytes.checkpointLargest,size);
        }
        return result;
      },
    };
    const api=createInteractiveCoordinator({store:instrumented,runtime,maxStagesPerCall});
    async function settle(frame) {
      while (frame.status==='paused') {
        assert.equal(frame.pauseReason,'stage-budget');
        assert.ok(++pauseCalls<20000,'unexpected budget loop');
        frame=await api.resume({runId});
      }
      return frame;
    }
    const started=performance.now();
    let frame=await settle(await api.start({
      programBytes:Buffer.from(program.code),programIdentity:program.programIdentity,runId,startKey:runId,
    }));
    for (let index=0;index<agents;index++) {
      assert.equal(frame.status,'waiting');
      assert.equal(frame.pending.nodeId,'agent'+index);
      const input={
        runId,requestId:frame.pending.requestId,nodeId:frame.pending.nodeId,attempt:frame.pending.attempt,
        result:{['answer'+index]:'x'.repeat(128)},
      };
      firstReceipt??=input;
      const begin=performance.now();
      const accepted=await api.complete(input);
      frame=await settle(accepted);
      samples.push(performance.now()-begin);
      receipts.push({requestId:input.requestId,revision:accepted.acceptedRevision});
      bytes.walHighWaterSample=Math.max(bytes.walHighWaterSample,await fileBytes(database+'-wal'));
    }
    const elapsedMs=performance.now()-started;
    assert.equal(frame.status,'succeeded');
    assert.equal(Object.keys(frame.state).length,agents);
    finalStateHash=sha256Bytes(canonicalBytes(frame.state));
    const checkpoint=store.load(runId);
    const journal=store.listJournal(runId);
    assert.ok(casCommitted>=2000);
    assert.equal(casCommitted,checkpoint.revision);
    assert.equal(journal.length,checkpoint.revision+1);
    assert.equal(checkpoint.receiptCount,receipts.length);
    bytes.checkpointFinal=canonicalBytes(checkpoint).byteLength;
    bytes.journalExport=journal.reduce((sum,entry)=>sum+canonicalBytes(entry).byteLength,0);
    const receiptIndex=receipts.map(receipt=>store.getReceipt(runId,receipt.requestId));
    bytes.receiptIndexExport=receiptIndex.reduce((sum,receipt)=>sum+canonicalBytes(receipt).byteLength,0);
    bytes.databaseOpen=await fileBytes(database);
    bytes.walAtTerminal=await fileBytes(database+'-wal');
    stats={elapsedMs:Number(elapsedMs.toFixed(3)),latencyMs:latency(samples),pauseCalls,casAttempts,casCommitted,
      journalRows:journal.length,receiptIndexRows:receiptIndex.length,checkpointReceiptCount:checkpoint.receiptCount};
  } finally {store.close();}
  bytes.databaseClosed=await fileBytes(database);
  bytes.walClosed=await fileBytes(database+'-wal');
  const reopened=createSqliteCheckpointStore(database,{namespace});
  try {
    for (const receipt of receipts) {
      assert.equal(reopened.getReceipt(runId,receipt.requestId)?.acceptedRevision,receipt.revision);
    }
    const cp=reopened.load(runId);
    const api=createInteractiveCoordinator({store:reopened,runtime,maxStagesPerCall});
    const repeated=await api.complete(firstReceipt);
    assert.equal(repeated.duplicate,true);
    assert.equal(repeated.acceptedRevision,receipts[0].revision);
    assert.equal(repeated.revision,cp.revision);
    assert.equal(sha256Bytes(canonicalBytes(repeated.state)),finalStateHash);
  } finally {reopened.close();}
  return {maxStagesPerCall,finalStateHash,bytes,...stats};
}

try {
  const sourcePath=path.join(dir,'ledger.workflow.js');
  await writeFile(sourcePath,source);
  const program=await compileInteractive(sourcePath,{output:'memory',featureStage:'P0-A',skillCheck:false,projectRoot:dir});
  assert.ok(program.code,JSON.stringify(program.diagnostics));
  const results=[];
  for (const budget of [1,128]) {
    const result=await measure(program,budget);
    results.push(result);
    console.log('FLOWKIT_LEDGER_MEASUREMENT '+JSON.stringify({
      platform:process.platform,node:process.version,agents,modelCalls:0,
      programHash:program.programIdentity.artifactHash,...result,
    }));
  }
  assert.equal(results[0].finalStateHash,results[1].finalStateHash);
} finally {await rm(dir,{recursive:true,force:true});}
