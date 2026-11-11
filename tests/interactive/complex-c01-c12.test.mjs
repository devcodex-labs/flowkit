/**
 * C01/C02/C03/C04/C10/C11: actual FlowKit Program, trusted Host and SQLite,
 * but Agent results are SCRIPTED, never claim a real model session here.
 */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
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
  const makeHost=()=>createTrustedInteractiveHost({
    store,runtime,policy:{deploymentId:'complex-c01-c12',bindingVersions:{
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
    receiptCacheSize:cp.receipts.length,...extra,result:'PASS',
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
  assert.equal(f.store.load('C02-early').receipts.length,0);
  audit(f,'C02-early');
  const missing=await start(f,{runId:'C02-missing',state:{
    request:'software task',
  }});
  assert.equal(missing.status,'errored');
  assert.equal(missing.terminal.causeCode,'FK_R002');
  assert.equal(f.store.load('C02-missing').receipts.length,0);
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

test('C10 36 Agent chain keeps 16 recent receipt cache but all 36 Ack identities',async t=>{
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
  assert.equal(cp.receipts.length,16);
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
    recentCache:cp.receipts.length,historicalAck:true});
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
