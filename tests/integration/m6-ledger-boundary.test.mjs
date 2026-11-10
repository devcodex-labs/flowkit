/**
 * M6 S07 adversarial capacity probe. This records the *currently unresolved*
 * liveness boundary instead of silently declaring the 2 MiB ledger gate PASS:
 * a legitimate Pending can fit in the Store while accepting its receipt cannot.
 * The Store must at least reject atomically (never half-accept a result).
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

test('M6 S07: near-2MiB waiting Checkpoint rejects an otherwise valid receipt atomically; liveness gate remains unresolved',async()=>{
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
        validateResult:()=>[],
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
      ...old,revision:old.revision+1,
      state:{...old.state,filler:''},
    };
    // Near the actual 2 MiB persisted Checkpoint limit without exceeding it.
    const headroom=75;
    const baseSize=canonicalBytes(candidate).byteLength;
    assert.ok(baseSize+headroom<MAX_CHECKPOINT_BYTES);
    candidate.state.filler='x'.repeat(MAX_CHECKPOINT_BYTES-baseSize-headroom);
    const grown=store.compareAndSwap({
      runId:started.runId,expectedRevision:old.revision,
      nextCheckpoint:candidate,transitionId:'m6-s07-boundary-seed',
      journalEntry:{kind:'m6-s07-capacity-test-seed'},
    });
    assert.equal(grown.committed,true);
    const before=store.load(started.runId);
    const beforeBytes=canonicalBytes(before);
    const beforeJournal=store.listJournal(started.runId);
    assert.ok(beforeBytes.byteLength<=MAX_CHECKPOINT_BYTES);
    assert.ok(MAX_CHECKPOINT_BYTES-beforeBytes.byteLength<=headroom+1);
    assert.equal(before.status,'waiting');
    const receipt={
      runId:started.runId,requestId:started.pending.requestId,
      nodeId:started.pending.nodeId,attempt:started.pending.attempt,
      result:{answer:'ok'},
    };
    for(let i=0;i<2;i++){
      await assert.rejects(api.complete(receipt),/Canonical JSON exceeds maximum bytes/);
      assert.deepEqual(canonicalBytes(store.load(started.runId)),beforeBytes);
      assert.deepEqual(store.listJournal(started.runId),beforeJournal);
    }
    const recovered=await api.resume({runId:started.runId});
    assert.equal(recovered.status,'waiting');
    assert.equal(recovered.pending.requestId,started.pending.requestId);
    console.log('M6_S07_LEDGER_SATURATION_BLOCKER '+JSON.stringify({
      schemaVersion:1,checkpointBytes:beforeBytes.byteLength,
      maximumBytes:MAX_CHECKPOINT_BYTES,receiptAccepted:false,
      journalUnchanged:true,pendingReplayable:true,livenessResolved:false,
    }));
  }finally{store.close()}
});
