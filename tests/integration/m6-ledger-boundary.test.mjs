/**
 * M6 S07 positive regression after scoped PR #8: a near-2MiB waiting
 * Checkpoint is rejected before mutation, so a valid Agent result from the
 * previous safely admitted Pending still reaches a terminal state.
 */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createInteractiveCoordinator} from '../../src/interactive/coordinator.mjs';
import {canonicalBytes,MAX_CHECKPOINT_BYTES} from '../../src/interactive/canonical.mjs';

const roots=[];
after(async()=>{for(const dir of roots)await rm(dir,{recursive:true,force:true})});
const workflow=[
  "import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';",
  "export default defineWorkflow({id:'m6-ledger-boundary',version:'1.0.0',name:'Ledger',nodes:[",
  "node('worker',{name:'Worker',agent:'writer',inputs:['message'],",
  "output:{type:'object',properties:{answer:{type:'string'}}},retries:0,next:'done'}),",
  "terminal('done',{name:'Done',status:'succeeded'})]});",
].join('\n');

test('M6 S07: near-hard-limit waiting mutation fails before CAS; valid 64-KiB receipt reaches terminal',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-m6-ledger-'));
  roots.push(dir);
  const store=createSqliteCheckpointStore(path.join(dir,'store.db'),{namespace:'m6-s07'});
  try {
    const analysis=await analyzeSource(workflow,{
      filename:'m6-ledger-boundary.workflow.js',projectRoot:dir,skillCheck:false,
    });
    assert.equal(analysis.diagnostics.some(d=>d.severity==='error'),false,
      JSON.stringify(analysis.diagnostics));
    const lowered=lowerInteractive(analysis);
    assert.ok(lowered.ir,JSON.stringify(lowered.diagnostics));
    const compiled=emitInteractive(lowered.ir);
    assert.ok(compiled.code,JSON.stringify(compiled.diagnostics));
    const api=createInteractiveCoordinator({
      store,
      runtime:{
        skillResolver:async()=> 'Write a valid answer',
        validateResult:(_schema,result)=>
          typeof result?.answer==='string'?[]:['Expected string answer'],
      },
    });
    const started=await api.start({
      programBytes:Buffer.from(compiled.code),
      programIdentity:compiled.programIdentity,
      runId:'s07-near-limit',startKey:'s07-near-limit',state:{message:'hello'},
    });
    assert.equal(started.status,'waiting');
    const old=store.load(started.runId);
    const candidate={
      ...old,revision:old.revision+1,state:{...old.state,filler:''},
    };
    const headroom=75;
    const baseSize=canonicalBytes(candidate).byteLength;
    candidate.state.filler='x'.repeat(MAX_CHECKPOINT_BYTES-baseSize-headroom);
    const beforeBytes=canonicalBytes(old);
    const beforeJournal=store.listJournal(started.runId);
    assert.ok(canonicalBytes(candidate).byteLength>MAX_CHECKPOINT_BYTES-128);
    await assert.rejects(async()=>store.compareAndSwap({
      runId:started.runId,expectedRevision:old.revision,
      nextCheckpoint:candidate,transitionId:'m6-s07-too-big-before-publish',
      journalEntry:{kind:'m6-s07-reject-large-State'},
    }),{code:'FK_I_CHECKPOINT_CAPACITY'});
    assert.deepEqual(canonicalBytes(store.load(started.runId)),beforeBytes);
    assert.deepEqual(store.listJournal(started.runId),beforeJournal);
    const receipt={
      runId:started.runId,requestId:started.pending.requestId,
      nodeId:started.pending.nodeId,attempt:started.pending.attempt,
      result:{answer:'x'.repeat(64*1024)},
    };
    const completed=await api.complete(receipt);
    assert.equal(completed.status,'succeeded');
    assert.equal(completed.state.answer.length,64*1024);
    assert.equal(store.getReceipt(started.runId,receipt.requestId).acceptedRevision,
      completed.acceptedRevision);
    assert.equal(store.listJournal(started.runId).length,completed.revision+1);
    console.log('M6_S07_LEDGER_CAPACITY_FIXED '+JSON.stringify({
      schemaVersion:1,checkpointLimitBytes:MAX_CHECKPOINT_BYTES,
      unsafeMutationRejected:true,unchangedOnRejection:true,
      validReceiptAccepted:true,ended:completed.status,
    }));
  }finally{store.close()}
});
