/**
 * C01/C02/C03/C04/C10/C11: actual FlowKit Program, trusted Host and SQLite,
 * but Agent results are SCRIPTED, never claim a real model session here.
 */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {analyzeSource} from '../../src/compiler/analyze.mjs';
import {lowerInteractive} from '../../src/compiler/interactive/lower.mjs';
import {emitInteractive} from '../../src/compiler/interactive/emit.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {createAgentReceiptStatement,encodeAgentReceiptStatement}
  from '../../src/interactive/host-attestation.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const roots=[];
after(async()=>{for(const dir of roots) await rm(dir,{recursive:true,force:true})});
const NOW=1794400000000;
const DSL="import {defineWorkflow,condition,node,terminal} from '@devcodex-labs/flowkit/dsl';\n";
const schema=(field,type='string')=>
  "{type:'object',properties:{"+field+":{type:'"+type+"'}}}";
function complexSource(retries=1) {
  return DSL+"export default defineWorkflow({id:'c01-complex',version:'1.0.0',name:'C01 Complex',nodes:["+
    "condition('gate',{name:'Gate',branches:[{when:'ready',next:'requirements'},{when:'true',next:'declined'}]}),"+
    "node('requirements',{name:'Requirements',agent:'analyst',inputs:['request'],output:"+
      schema('requirementId')+",retries:0,next:'design'}),"+
    "node('design',{name:'Design',agent:'designer',inputs:['requirementId'],output:"+
      schema('designId')+",retries:0,next:'plan'}),"+
    "node('plan',{name:'Plan',agent:'planner',inputs:['designId'],output:"+
      schema('planId')+",retries:0,next:'review'}),"+
    "node('review',{name:'Review',agent:'reviewer',inputs:['planId'],output:"+
      schema('reviewApproved','boolean')+",retries:"+retries+",next:'decision'}),"+
    "condition('decision',{name:'Decision',branches:[{when:'reviewApproved',next:'done'},{when:'true',next:'declined'}]}),"+
    "terminal('done',{name:'Done',status:'succeeded'}),"+
    "terminal('declined',{name:'Declined',status:'failed'})]});";
}
function longSource(count=36){
  const nodes=[];
  for(let i=0;i<count;i++){
    const input=i===0?'request':'step'+(i-1);
    nodes.push("node('agent"+i+"',{name:'Agent "+i+"',agent:'worker',inputs:['"+input+"'],"+
      "output:"+schema('step'+i)+",retries:0,next:'"+
      (i===count-1?'done':'agent'+(i+1))+"'})");
  }
  nodes.push("terminal('done',{name:'Done',status:'succeeded'})");
  return DSL+"export default defineWorkflow({id:'c10-long',version:'1.0.0',name:'C10 Long',nodes:["+
    nodes.join(',')+"]});";
}
async function compile(source){
  const a=await analyzeSource(source,{filename:'complex.workflow.js',
    projectRoot:process.cwd(),skillCheck:false});
  assert.equal(a.diagnostics.some(x=>x.severity==='error'),false,
    JSON.stringify(a.diagnostics));
  const ir=lowerInteractive(a);
  assert.ok(ir.ir,JSON.stringify(ir.diagnostics));
  const e=emitInteractive(ir.ir);
  assert.ok(e.code,JSON.stringify(e.diagnostics));
  return {programBytes:Buffer.from(e.code,'utf8'),programIdentity:e.programIdentity};
}
function validator(schema,output){
  if(!output||typeof output!=='object'||Array.isArray(output))return ['not an object'];
  const properties=schema.properties??{};
  const keys=Object.keys(properties).sort();
  if(Object.keys(output).sort().join('|')!==keys.join('|'))return ['wrong fields'];
  for(const k of keys)if(typeof output[k]!==properties[k].type)return ['wrong type: '+k];
  return [];
}
async function fixture(t,{
  source=complexSource(),
  maxStagesPerCall=128,
  allowedInputKeys=['request','requirementId','designId','planId'],
}={}){
  const root=await mkdtemp(path.join(tmpdir(),'fk-complex-'));
  roots.push(root);
  const store=createSqliteCheckpointStore(path.join(root,'run.sqlite'),{
    namespace:'complex-acceptance',
  });
  t.after(()=>store.close());
  const compiled=await compile(source);
  const keys=generateKeyPairSync('ed25519');
  const runtime={
    skillResolver:async({nodeId})=>'Perform declared step '+nodeId,
    validateResult:validator,
  };
  const makeHost=(hostStore=store)=>createTrustedInteractiveHost({
    store:hostStore,runtime,policy:{deploymentId:'complex-c01-c12',bindingVersions:{
      resolver:'v1',validator:'v1',
    }},
    trustedPublicKeys:{'trusted-host':keys.publicKey},
    trustedArtifacts:[compiled.programIdentity.artifactHash],
    allowedInputKeys,
    disclosurePolicyId:'complex-test-public',
    authorizeDisclosure:async()=>true,now:()=>NOW,maxStagesPerCall,
  });
  return {root,store,keys,compiled,makeHost,host:makeHost()};
}
function audit(f,runId){
  const cp=f.store.load(runId),journal=f.store.listJournal(runId);
  assert.equal(journal.length,cp.revision+1);
  for(let i=0;i<journal.length;i++){
    assert.equal(journal[i].revision,i);
    if(i)assert.equal(journal[i].previousHash,journal[i-1].entryHash);
  }
  return {cp,journal};
}
async function settle(host,frame){
  for(let n=0;n<2000&&frame.status==='paused';n++){
    frame=await host.resume({runId:frame.runId});
  }
  assert.notEqual(frame.status,'paused','stage-budget did not advance');
  return frame;
}
async function start(f,{runId='complex-run',state={
  ready:true,request:'software task',
}}={}){
  return settle(f.host,await f.host.start({
    ...f.compiled,runId,startKey:runId,state,
  }));
}
async function task(f,frame){
  assert.equal(frame.status,'waiting');
  const pending=await f.host.getPublicAgentTask({runId:frame.runId});
  assert.equal(pending.requestId,frame.pending.requestId);
  assert.equal(pending.nodeId,frame.pending.nodeId);
  assert.equal(Object.hasOwn(pending,'state'),false);
  assert.equal(Object.hasOwn(pending,'receipts'),false);
  assert.ok(!JSON.stringify(pending).includes('HOST-PRIVATE-DO-NOT-SHARE'));
  return pending;
}
function receiptFor(p,result){
  return {runId:p.runId,requestId:p.requestId,nodeId:p.nodeId,
    attempt:p.attempt,kind:'agent-result',result};
}
function attest(f,receipt){
  const statement=createAgentReceiptStatement({
    run:f.store.load(receipt.runId),receipt,keyId:'trusted-host',
    proofId:'complex-'+receipt.requestId,
    issuedAt:NOW-1000,expiresAt:NOW+10000,
  });
  return {statement,signature:sign(null,encodeAgentReceiptStatement(statement),
    f.keys.privateKey).toString('base64url')};
}
async function respond(f,frame,result){
  const p=await task(f,frame),receipt=receiptFor(p,result);
  const attestation=attest(f,receipt);
  const accepted=await f.host.accept({receipt,attestation});
  assert.equal(f.store.getReceipt(p.runId,p.requestId)?.acceptedRevision,
    accepted.acceptedRevision);
  return {
    frame:await settle(f.host,accepted),p,receipt,attestation,
    acceptedRevision:accepted.acceptedRevision,
  };
}
const answers={
  requirements:{requirementId:'REQ-001'},
  design:{designId:'DES-001'},
  plan:{planId:'PLAN-001'},
  review:{reviewApproved:true},
};
async function fourSteps(f,frame,{reviewResult=answers.review,trace=[]}={}){
  for(const id of ['requirements','design','plan','review']){
    const p=await task(f,frame);
    assert.equal(p.nodeId,id);
    const input=id==='requirements'?{request:'software task'}
      :id==='design'?{requirementId:'REQ-001'}
      :id==='plan'?{designId:'DES-001'}:{planId:'PLAN-001'};
    assert.deepEqual(p.input,input);
    const response=await respond(f,frame,id==='review'?reviewResult:answers[id]);
    trace.push({nodeId:id,requestId:p.requestId,attempt:p.attempt,
      acceptedRevision:response.acceptedRevision});
    frame=response.frame;
  }
  return {frame,trace};
}
function evidence(id,f,frame,extra={}){
  const {cp,journal}=audit(f,frame.runId);
  console.log('FLOWKIT_COMPLEX_ACCEPTANCE '+JSON.stringify({
    scenarioId:id,execution:'SCRIPTED_TRUSTED_HOST',modelCalls:0,
    programHash:f.compiled.programIdentity.artifactHash,runId:frame.runId,
    terminalStatus:cp.status,revision:cp.revision,journalRevisions:journal.length,
    receiptCount:cp.receiptCount,...extra,result:'PASS',
  }));
}

test('C01 4 signed, dependent Agent nodes + 2 Conditions commit exactly in Program order',async t=>{
  const f=await fixture(t);
  const first=await start(f,{runId:'C01-four',state:{
    ready:true,request:'software task',secret:'HOST-PRIVATE-DO-NOT-SHARE',
  }});
  const {frame,trace}=await fourSteps(f,first);
  assert.equal(frame.status,'succeeded');
  assert.equal(frame.terminal.nodeId,'done');
  assert.deepEqual(frame.state,{
    ready:true,request:'software task',secret:'HOST-PRIVATE-DO-NOT-SHARE',
    requirementId:'REQ-001',designId:'DES-001',planId:'PLAN-001',reviewApproved:true,
  });
  assert.equal(new Set(trace.map(x=>x.requestId)).size,4);
  evidence('C01',f,frame,{nodes:trace.map(x=>x.nodeId),signedReceipts:4});
});

test('C02 false/default/unknown Condition routes do not dispatch unreachable Agent',async t=>{
  const f=await fixture(t);
  const early=await start(f,{runId:'C02-early',state:{
    ready:false,request:'software task',
  }});
  assert.equal(early.status,'failed');
  assert.equal(early.terminal.nodeId,'declined');
  assert.equal(f.store.load('C02-early').receiptCount,0);
  audit(f,'C02-early');
  const missing=await start(f,{runId:'C02-missing',state:{
    request:'software task',
  }});
  assert.equal(missing.status,'errored');
  assert.equal(missing.terminal.causeCode,'FK_R002');
  assert.equal(f.store.load('C02-missing').receiptCount,0);
  audit(f,'C02-missing');
  const pending=await start(f,{runId:'C02-late'});
  const {frame,trace}=await fourSteps(f,pending,{
    reviewResult:{reviewApproved:false},
  });
  assert.equal(frame.status,'failed');
  assert.equal(frame.terminal.nodeId,'declined');
  assert.equal(trace.length,4);
  evidence('C02',f,frame,{
    routes:['ready:false -> declined','ready:missing -> FK_R002',
      'reviewApproved:false -> declined'],
    earlyDispatches:0,
  });
});

test('C03 invalid review schema does not mutate State, retries with new requestId',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C03-retry'});
  for(const id of ['requirements','design','plan']){
    frame=(await respond(f,frame,answers[id])).frame;
  }
  const prior=await task(f,frame);
  const first=await respond(f,frame,{reviewApproved:'wrong-type'});
  frame=first.frame;
  assert.equal(frame.status,'waiting');
  assert.equal(frame.pending.nodeId,'review');
  assert.equal(frame.pending.attempt,2);
  assert.notEqual(frame.pending.requestId,prior.requestId);
  assert.equal(Object.hasOwn(f.store.load(frame.runId).state,'reviewApproved'),false);
  const dup=await f.host.accept({
    receipt:first.receipt,attestation:first.attestation,
  });
  assert.equal(dup.duplicate,true);
  assert.equal(dup.acceptedRevision,first.acceptedRevision);
  assert.equal(dup.pending.requestId,frame.pending.requestId);
  const second=await respond(f,frame,{reviewApproved:true});
  assert.equal(second.frame.status,'succeeded');
  assert.equal(second.frame.state.reviewApproved,true);
  evidence('C03',f,second.frame,{attempts:[1,2],invalidStateMerged:false,
    firstAck:first.acceptedRevision,secondAck:second.acceptedRevision});
});

test('C04 repeated invalid review schema consumes exactly retries+1 and FK_R004',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C04-error'});
  for(const id of ['requirements','design','plan']){
    frame=(await respond(f,frame,answers[id])).frame;
  }
  const attempts=[];
  for(let n=0;n<2;n++){
    const p=await task(f,frame);
    assert.equal(p.nodeId,'review');
    attempts.push(p.attempt);
    frame=(await respond(f,frame,{invalid:true})).frame;
  }
  assert.deepEqual(attempts,[1,2]);
  assert.equal(frame.status,'errored');
  assert.equal(frame.terminal.causeCode,'FK_R004');
  assert.equal(Object.hasOwn(frame.state,'reviewApproved'),false);
  evidence('C04',f,frame,{attempts,causeCode:'FK_R004'});
});

test('C10 36 Agent chain keeps all 36 Ack identities in the receipt index',async t=>{
  const count=36;
  const f=await fixture(t,{
    source:longSource(count),
    allowedInputKeys:['request',...Array.from({length:count},(_,i)=>'step'+i)],
  });
  let frame=await start(f,{runId:'C10-long'});
  const accepted=[];
  for(let i=0;i<count;i++){
    const p=await task(f,frame);
    assert.equal(p.nodeId,'agent'+i);
    const expected=i===0?{request:'software task'}:{
      ['step'+(i-1)]:'value-'+(i-1),
    };
    assert.deepEqual(p.input,expected);
    const answer=await respond(f,frame,{['step'+i]:'value-'+i});
    accepted.push(answer);
    frame=answer.frame;
  }
  assert.equal(frame.status,'succeeded');
  const {cp}=audit(f,frame.runId);
  assert.equal(cp.receiptCount,count);
  assert.equal(Object.keys(cp.state).length,count+2);
  for(const entry of accepted){
    assert.equal(f.store.getReceipt(frame.runId,entry.p.requestId).acceptedRevision,
      entry.acceptedRevision);
  }
  const old=await f.makeHost().accept({
    receipt:accepted[0].receipt,attestation:accepted[0].attestation,
  });
  assert.equal(old.duplicate,true);
  assert.equal(old.acceptedRevision,accepted[0].acceptedRevision);
  assert.equal(old.revision,frame.revision);
  evidence('C10',f,frame,{agents:count,history:accepted.length,
    acceptedReceipts:cp.receiptCount,historicalAck:true});
});

test('C11 stage budget 1 and 128 produce same final State bytes and node order',async t=>{
  const compared=[];
  for(const budget of [1,128]){
    const f=await fixture(t,{maxStagesPerCall:budget});
    const first=await start(f,{runId:'C11-budget-'+budget});
    const trace=[];
    const {frame}=await fourSteps(f,first,{trace});
    assert.equal(frame.status,'succeeded');
    const {journal}=audit(f,frame.runId);
    compared.push({
      budget,programHash:f.compiled.programIdentity.artifactHash,
      state:frame.state,stateHash:sha256Bytes(canonicalBytes(frame.state)),
      trace:trace.map(x=>({id:x.nodeId,attempt:x.attempt})),
      revision:frame.revision,journalRevisions:journal.length,
    });
  }
  assert.equal(compared[0].programHash,compared[1].programHash);
  assert.equal(compared[0].stateHash,compared[1].stateHash);
  assert.deepEqual(compared[0].trace,compared[1].trace);
  assert.ok(compared[0].revision>compared[1].revision);
  console.log('FLOWKIT_COMPLEX_ACCEPTANCE '+JSON.stringify({
    scenarioId:'C11',execution:'SCRIPTED_TRUSTED_HOST',modelCalls:0,
    programHash:compared[0].programHash,
    stateHash:compared[0].stateHash,
    runs:compared.map(x=>({budget:x.budget,revision:x.revision,
      journalRevisions:x.journalRevisions})),
    result:'PASS',
  }));
});


// C13-C20 extend the FROZEN C01-C12 set with compound failure/interleaving
// conditions. All model outputs below are SCRIPTED; zero real model calls.
test('C13 cross-budget branch product: true/false/missing and late rejection',async t=>{
  const observations=[];
  for(const budget of [1,128]){
    const f=await fixture(t,{maxStagesPerCall:budget});
    const declined=await start(f,{runId:'C13-early-'+budget,
      state:{ready:false,request:'software task'}});
    assert.equal(declined.status,'failed');
    assert.equal(declined.terminal.nodeId,'declined');
    assert.equal(f.store.load(declined.runId).receiptCount,0);

    const missing=await start(f,{runId:'C13-missing-'+budget,
      state:{request:'software task'}});
    assert.equal(missing.status,'errored');
    assert.equal(missing.terminal.causeCode,'FK_R002');
    assert.equal(f.store.load(missing.runId).receiptCount,0);

    const falseFirst=await start(f,{runId:'C13-late-false-'+budget});
    const rejected=await fourSteps(f,falseFirst,{
      reviewResult:{reviewApproved:false}});
    assert.equal(rejected.frame.status,'failed');
    assert.equal(rejected.frame.terminal.nodeId,'declined');
    assert.equal(rejected.trace.length,4);

    const trueFirst=await start(f,{runId:'C13-late-true-'+budget});
    const approved=await fourSteps(f,trueFirst);
    assert.equal(approved.frame.status,'succeeded');
    assert.equal(approved.frame.terminal.nodeId,'done');
    const stateHash=sha256Bytes(canonicalBytes(approved.frame.state));
    const rejectedStateHash=sha256Bytes(canonicalBytes(rejected.frame.state));
    for(const runId of [declined.runId,missing.runId,
      rejected.frame.runId,approved.frame.runId])audit(f,runId);
    observations.push({budget,stateHash,rejectedStateHash,
      statuses:[declined.status,missing.status,rejected.frame.status,
        approved.frame.status]});
  }
  assert.equal(observations[0].stateHash,observations[1].stateHash);
  assert.equal(observations[0].rejectedStateHash,
    observations[1].rejectedStateHash);
  assert.deepEqual(observations.map(x=>x.statuses),[
    ['failed','errored','failed','succeeded'],
    ['failed','errored','failed','succeeded']]);
  console.log('FLOWKIT_COMPLEX_ACCEPTANCE '+JSON.stringify({
    scenarioId:'C13',execution:'SCRIPTED_TRUSTED_HOST',modelCalls:0,
    branchCases:4,stageBudgets:[1,128],observations,result:'PASS',
  }));
});

test('C14 tampered/oversized signed-looking replies halfway through chain are no-ops',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C14-forged'});
  frame=(await respond(f,frame,answers.requirements)).frame;
  const pending=await task(f,frame);
  assert.equal(pending.nodeId,'design');
  const valid=receiptFor(pending,{designId:'DES-001'});
  const attestation=attest(f,valid);
  const cp=canonicalBytes(f.store.load(frame.runId));
  const journal=f.store.listJournal(frame.runId);
  const rejected=[
    {receipt:{...valid,result:{designId:'swapped'}},attestation},
    {receipt:{...valid,attempt:pending.attempt+1},attestation},
    {receipt:{...valid,requestId:'forged-request'},attestation},
    {receipt:{...valid,result:{designId:'x'.repeat(2_100_000)}},
      attestation},
    {receipt:valid,attestation:{...attestation,
      signature:'A'.repeat(86)}},
  ];
  for(const entry of rejected){
    await assert.rejects(f.host.accept(entry),
      {code:'FK_I_PROVENANCE_REJECTED'});
    assert.deepEqual(canonicalBytes(f.store.load(frame.runId)),cp);
    assert.deepEqual(f.store.listJournal(frame.runId),journal);
  }
  const accepted=await f.host.accept({receipt:valid,attestation});
  frame=await settle(f.host,accepted);
  assert.equal(frame.pending.nodeId,'plan');
  frame=(await respond(f,frame,answers.plan)).frame;
  frame=(await respond(f,frame,answers.review)).frame;
  assert.equal(frame.status,'succeeded');
  assert.equal(frame.state.designId,'DES-001');
  evidence('C14',f,frame,{rejectedBodies:rejected.length,
    noMutationBeforeValidReceipt:true});
});

test('C15 lost Ack replay after Host rebuild and after downstream Terminal is immutable',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C15-lost-ack'});
  const first=await respond(f,frame,answers.requirements);
  frame=first.frame;
  assert.equal(frame.pending.nodeId,'design');
  const cp=canonicalBytes(f.store.load(frame.runId));
  const before=f.store.listJournal(frame.runId);
  const rebuilt=f.makeHost();
  const duplicate=await rebuilt.accept({
    receipt:first.receipt,attestation:first.attestation});
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.acceptedRevision,first.acceptedRevision);
  assert.deepEqual(canonicalBytes(f.store.load(frame.runId)),cp);
  assert.deepEqual(f.store.listJournal(frame.runId),before);
  for(const id of ['design','plan','review']){
    frame=(await respond(f,frame,answers[id])).frame;
  }
  assert.equal(frame.status,'succeeded');
  const terminalRevision=f.store.load(frame.runId).revision;
  const after=await f.makeHost().accept({
    receipt:first.receipt,attestation:first.attestation});
  assert.equal(after.duplicate,true);
  assert.equal(after.acceptedRevision,first.acceptedRevision);
  assert.equal(f.store.load(frame.runId).revision,terminalRevision);
  evidence('C15',f,frame,{lostAckRecovered:true,
    replayAfterTerminal:true});
});

test('R11 reconciles a lost receipt acknowledgement after a second SQLite connection advances the run',async t=>{
  const f=await fixture(t);
  const frame=await start(f,{runId:'R11-lost-response'});
  const original=receiptFor(await task(f,frame),answers.requirements);
  const attestation=attest(f,original);
  const lostResponse=new Error('test drops the successful receipt CAS response');
  let acceptedRevision;
  const droppingStore={
    ...f.store,
    compareAndSwap(args) {
      const result=f.store.compareAndSwap(args);
      if (result.committed && args.journalEntry?.kind==='receipt-accepted') {
        acceptedRevision=result.checkpoint.revision;
        throw lostResponse;
      }
      return result;
    },
  };
  const firstHost=f.makeHost(droppingStore);
  await assert.rejects(firstHost.accept({receipt:original,attestation}),error=>error===lostResponse);
  assert.equal(f.store.getReceipt(frame.runId,original.requestId).acceptedRevision,acceptedRevision);

  const secondStore=createSqliteCheckpointStore(path.join(f.root,'run.sqlite'),{namespace:f.store.namespace});
  t.after(()=>secondStore.close());
  const second={...f,store:secondStore,host:f.makeHost(secondStore)};
  let later=await second.host.resume({runId:frame.runId});
  for (const id of ['design','plan','review']) {
    assert.equal(later.pending.nodeId,id);
    later=(await respond(second,later,answers[id])).frame;
  }
  assert.equal(later.status,'succeeded');
  assert.ok(later.revision>acceptedRevision+5);
  const before=canonicalBytes(secondStore.load(frame.runId));
  const beforeJournal=secondStore.listJournal(frame.runId);
  const replay=await f.host.accept({receipt:original,attestation});
  assert.equal(replay.duplicate,true);
  assert.equal(replay.acceptedRevision,acceptedRevision);
  assert.equal(replay.revision,later.revision);
  assert.deepEqual(replay.state,later.state);
  assert.deepEqual(canonicalBytes(secondStore.load(frame.runId)),before);
  assert.deepEqual(secondStore.listJournal(frame.runId),beforeJournal);
  console.log('FLOWKIT_R11_RECOVERY '+JSON.stringify({
    runId:frame.runId,requestId:original.requestId,acceptedRevision,latestRevision:later.revision,
    sqliteConnections:2,modelCalls:0,journalRows:beforeJournal.length,
  }));
});

test('C16 signed Host call-failed in late Agent retries safely and does not skip route',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C16-provider-failure'});
  for(const id of ['requirements','design','plan']){
    frame=(await respond(f,frame,answers[id])).frame;
  }
  const p=await task(f,frame);
  const failure={runId:p.runId,requestId:p.requestId,nodeId:p.nodeId,
    attempt:p.attempt,kind:'agent-call-failed',
    failure:{message:'provider unavailable'}};
  const proof=attest(f,failure);
  const failed=await f.host.accept({receipt:failure,attestation:proof});
  frame=await settle(f.host,failed);
  assert.equal(frame.status,'waiting');
  assert.equal(frame.pending.nodeId,'review');
  assert.equal(frame.pending.attempt,2);
  assert.notEqual(frame.pending.requestId,p.requestId);
  assert.equal(Object.hasOwn(f.store.load(frame.runId).state,'reviewApproved'),false);
  const duplicate=await f.host.accept({receipt:failure,attestation:proof});
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.acceptedRevision,failed.acceptedRevision);
  frame=(await respond(f,frame,answers.review)).frame;
  assert.equal(frame.status,'succeeded');
  evidence('C16',f,frame,{failureReceiptAccepted:true,
    attempt2:true,staleAckImmutable:true});
});

test('C17 Host policy drift at intermediate Pending rejects before mutation; old Host completes',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C17-policy'});
  for(const id of ['requirements','design']){
    frame=(await respond(f,frame,answers[id])).frame;
  }
  assert.equal(frame.pending.nodeId,'plan');
  const before=canonicalBytes(f.store.load(frame.runId));
  const history=f.store.listJournal(frame.runId);
  const drifted=createTrustedInteractiveHost({
    store:f.store,runtime:{skillResolver:async({nodeId})=>'Perform declared step '+nodeId,
      validateResult:validator},
    policy:{deploymentId:'complex-c01-c12',
      bindingVersions:{resolver:'v2',validator:'v1'}},
    trustedPublicKeys:{'trusted-host':f.keys.publicKey},
    trustedArtifacts:[f.compiled.programIdentity.artifactHash],
    allowedInputKeys:['request','requirementId','designId','planId'],
    disclosurePolicyId:'complex-test-public',
    authorizeDisclosure:async()=>true,now:()=>NOW,
  });
  for(const action of [
    ()=>drifted.load({runId:frame.runId}),
    ()=>drifted.resume({runId:frame.runId}),
    ()=>drifted.getPublicAgentTask({runId:frame.runId}),
  ]){
    await assert.rejects(action(),{code:'FK_I_HOST_DENIED'});
    assert.deepEqual(canonicalBytes(f.store.load(frame.runId)),before);
    assert.deepEqual(f.store.listJournal(frame.runId),history);
  }
  frame=(await respond(f,frame,answers.plan)).frame;
  frame=(await respond(f,frame,answers.review)).frame;
  assert.equal(frame.status,'succeeded');
  evidence('C17',f,frame,{policyChangedResolver:'v1 -> v2',
    driftRejectedWithoutCAS:true});
});

test('C18 two interleaved Runs isolate branching, start identity and Journal',async t=>{
  const f=await fixture(t);
  let a=await start(f,{runId:'C18-run-A'});
  const b=await start(f,{runId:'C18-run-B',state:{
    ready:false,request:'software task'}});
  assert.equal(a.status,'waiting');
  assert.equal(b.status,'failed');
  assert.equal(f.store.load(b.runId).receiptCount,0);
  const replay=await f.host.start({...f.compiled,runId:'C18-shadow',
    startKey:'C18-run-A',state:{ready:true,request:'software task'}});
  assert.equal(replay.runId,a.runId);
  assert.equal(replay.pending.requestId,a.pending.requestId);
  await assert.rejects(f.host.start({...f.compiled,runId:'C18-conflict',
    startKey:'C18-run-A',state:{ready:false,request:'software task'}}),
  {code:'FK_I_START_CONFLICT'});
  a=(await fourSteps(f,a)).frame;
  assert.equal(a.status,'succeeded');
  assert.equal(f.store.load(b.runId).status,'failed');
  assert.equal(f.store.load(b.runId).receiptCount,0);
  audit(f,a.runId);audit(f,b.runId);
  evidence('C18',f,a,{parallelRuns:2,
    duplicateStartIdempotent:true,conflictingStartRejected:true});
});

test('C19 36-node chain with invalid output at step 18 has no ghost dispatch',async t=>{
  const count=36;
  const f=await fixture(t,{source:longSource(count),
    allowedInputKeys:['request',...Array.from({length:count},(_,i)=>'step'+i)]});
  let frame=await start(f,{runId:'C19-fail-midchain'});
  const receipts=[];
  for(let i=0;i<18;i++){
    const p=await task(f,frame);
    assert.equal(p.nodeId,'agent'+i);
    receipts.push(p.requestId);
    const value=i===17?{invalid:'bad'}:{['step'+i]:'value-'+i};
    frame=(await respond(f,frame,value)).frame;
  }
  assert.equal(frame.status,'errored');
  assert.equal(frame.terminal.causeCode,'FK_R004');
  assert.equal(Object.hasOwn(frame.state,'step17'),false);
  assert.equal(Object.hasOwn(frame.state,'step18'),false);
  assert.equal(new Set(receipts).size,18);
  const previous=canonicalBytes(f.store.load(frame.runId));
  const resumed=await f.host.resume({runId:frame.runId});
  assert.equal(resumed.status,'errored');
  assert.deepEqual(canonicalBytes(f.store.load(frame.runId)),previous);
  evidence('C19',f,frame,{declaredAgents:36,dispatched:18,
    remainingNotDispatched:18,causeCode:'FK_R004'});
});

test('C20 conflicting independently signed late-Agent answers accept only one CAS',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C20-equivocation'});
  frame=(await respond(f,frame,answers.requirements)).frame;
  const p=await task(f,frame);
  assert.equal(p.nodeId,'design');
  const left=receiptFor(p,{designId:'DES-A'});
  const right=receiptFor(p,{designId:'DES-B'});
  const [one,two]=await Promise.allSettled([
    f.host.accept({receipt:left,attestation:attest(f,left)}),
    f.makeHost().accept({receipt:right,attestation:attest(f,right)}),
  ]);
  const settled=[one,two];
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(settled.filter(x=>x.status==='rejected').length,1);
  assert.equal(settled.find(x=>x.status==='rejected').reason.code,
    'FK_I_RECEIPT_CONFLICT');
  const winning=settled.find(x=>x.status==='fulfilled').value;
  frame=await settle(f.host,winning);
  assert.equal(frame.pending.nodeId,'plan');
  assert.ok(['DES-A','DES-B'].includes(f.store.load(frame.runId).state.designId));
  const journal=f.store.listJournal(frame.runId);
  assert.equal(journal.length,frame.revision+1);
  frame=(await respond(f,frame,answers.plan)).frame;
  frame=(await respond(f,frame,answers.review)).frame;
  assert.equal(frame.status,'succeeded');
  evidence('C20',f,frame,{twoValidCompetingHostReceipts:true,
    exactlyOneCAS:true,winningDesign:frame.state.designId});
});

test('C20 two Node processes submit different signed answers for the same Pending',async t=>{
  const f=await fixture(t);
  let frame=await start(f,{runId:'C20-process-race'});
  frame=(await respond(f,frame,answers.requirements)).frame;
  const p=await task(f,frame);
  assert.equal(p.nodeId,'design');
  const publicKey=f.keys.publicKey.export({type:'spki',format:'pem'});
  const script=`
    import {once} from 'node:events';
    import {createSqliteCheckpointStore} from ${JSON.stringify(new URL('../../src/interactive/sqlite-store.mjs',import.meta.url).href)};
    import {createTrustedInteractiveHost} from ${JSON.stringify(new URL('../../src/interactive/trusted-host.mjs',import.meta.url).href)};
    const [file,publicKey,artifactHash,submission]=process.argv.slice(1);
    const store=createSqliteCheckpointStore(file,{namespace:'complex-acceptance'});
    try {
      const host=createTrustedInteractiveHost({
        store,runtime:{
          skillResolver:async({nodeId})=>'Perform declared step '+nodeId,
          validateResult:(schema,result)=>Object.keys(result).length===1 &&
            Object.keys(schema.properties).every(key=>typeof result[key]===schema.properties[key].type)?[]:['invalid'],
        },
        policy:{deploymentId:'complex-c01-c12',bindingVersions:{resolver:'v1',validator:'v1'}},
        trustedPublicKeys:{'trusted-host':publicKey},trustedArtifacts:[artifactHash],
        allowedInputKeys:['request','requirementId','designId','planId'],
        disclosurePolicyId:'complex-test-public',authorizeDisclosure:async()=>true,now:()=>1794400000000,
      });
      const release=once(process.stdin,'data');
      process.stdout.write('ready\\n');
      await release;
      try {
        const result=await host.accept(JSON.parse(submission));
        console.log(JSON.stringify({pid:process.pid,acceptedRevision:result.acceptedRevision,duplicate:result.duplicate}));
      } catch (error) {
        if(error.code!=='FK_I_RECEIPT_CONFLICT') throw error;
        console.log(JSON.stringify({pid:process.pid,code:error.code}));
      }
    } finally {store.close();}
  `;
  const submissions=['DES-A','DES-B'].map(designId=>{
    const receipt=receiptFor(p,{designId});
    return {receipt,attestation:attest(f,receipt)};
  });
  const children=submissions.map(submission=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,path.join(f.root,'run.sqlite'),
      publicKey,f.compiled.programIdentity.artifactHash,JSON.stringify(submission)],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    let markReady;
    const ready=new Promise(resolve=>{markReady=resolve});
    child.stdin.on('error',error=>{stderr+=error.message});
    child.stdout.on('data',bytes=>{
      stdout+=bytes;
      if(stdout.startsWith('ready\n')) markReady(true);
    });
    child.stderr.on('data',bytes=>{stderr+=bytes});
    const closed=new Promise(resolve=>{
      child.once('error',error=>{markReady(false);resolve({error:error.message})});
      child.once('close',code=>{markReady(false);resolve({code,stdout,stderr})});
    });
    return {child,ready,closed};
  });
  const deadline=setTimeout(()=>children.forEach(({child})=>child.kill()),15000);
  let records;
  try {
    assert.deepEqual(await Promise.all(children.map(child=>child.ready)),[true,true]);
    for(const {child} of children) child.stdin.end('commit');
    records=(await Promise.all(children.map(child=>child.closed))).map(({code,stdout,stderr,error})=>{
      assert.equal(code,0,stderr??error);
      return JSON.parse(stdout.split('\n')[1]);
    });
  } finally {
    clearTimeout(deadline);
    for(const {child} of children) if(child.exitCode===null && child.signalCode===null) child.kill();
    await Promise.all(children.map(child=>child.closed));
  }
  assert.notEqual(records[0].pid,records[1].pid);
  const winner=records.findIndex(record=>record.duplicate===false);
  assert.ok(winner>=0);
  assert.equal(records[1-winner].code,'FK_I_RECEIPT_CONFLICT');
  const stored=f.store.getReceipt(frame.runId,p.requestId);
  assert.equal(stored.acceptedRevision,records[winner].acceptedRevision);
  const audited=audit(f,frame.runId);
  assert.equal(audited.cp.state.designId,submissions[winner].receipt.result.designId);
  assert.equal(audited.journal.filter(entry=>entry.entry?.requestId===p.requestId
    && entry.entry.kind==='receipt-accepted').length,1);
  frame=await f.host.resume({runId:frame.runId});
  frame=(await respond(f,frame,answers.plan)).frame;
  frame=(await respond(f,frame,answers.review)).frame;
  assert.equal(frame.status,'succeeded');
  evidence('C20',f,frame,{twoNodeProcesses:records,winningRequestId:p.requestId});
});
