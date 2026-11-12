/**
 * Live model evidence: four distinct Agent nodes + deliberate schema-retry,
 * two Conditions. Each answer MUST be written by the current ChatGPT model
 * only AFTER inspecting a real published Pending in prior Actions logs.
 *
 * Test runner replays recorded answers through actual FlowKit Compiler,
 * generated Program, SQLite and Ed25519 Trusted Host. It reopens the DB
 * within each CI run; separate Actions runs do NOT share a physical DB.
 * GitHub tool identity is NOT a provider-native session attestation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {createAgentReceiptStatement,encodeAgentReceiptStatement}
  from '../../src/interactive/host-attestation.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const workflowFile=fileURLToPath(new URL(
  '../../examples/interactive/c01-live-chatgpt.workflow.js',import.meta.url));
const repliesFile=fileURLToPath(new URL(
  '../fixtures/c01-live-chatgpt-turns.json',import.meta.url));
const NOW=1794400000000;
const runId='c01-live-multi-agent-20261111';
const namespace='complex-live-chatgpt';
const expectedPath=['requirements','architecture','implementation','review','review'];
const instructions={
  requirements:"分析用户的 FlowKit 复杂验收要求，给出严谨、可操作的需求说明。只能回答一个 JSON 对象 {requirementSummary:string}，不少于 60 个汉字，不包含未授权的内部信息。",
  architecture:"基于公开的 requirementSummary 设计精简的 FlowKit 复杂验收架构，分清 FlowKit JS Program、Host、Context 的职责。只能回答 JSON {designSummary:string}，不少于 60 个汉字。",
  implementation:"基于上个节点公开的 designSummary，提出可复现的 C01-C12 复杂测试实施步骤，包含真实模型场景和故障/恢复验证。只能回答 JSON {executionPlan:string}，不少于 60 个汉字。",
  review:"独立评审公开的 executionPlan 的可执行性、证据质量和宿主安全边界。只回答 JSON {reviewApproved:boolean,reviewNotes:string}，reviewNotes 不少于 60 个汉字；必须依据实际上游数据，不得凭空宣称 Grok Build 已执行或 S13 已通过。",
};
const outputShape={
  requirements:{requirementSummary:'string'},
  architecture:{designSummary:'string'},
  implementation:{executionPlan:'string'},
  review:{reviewApproved:'boolean',reviewNotes:'string'},
};
function validate(schema,output){
  if(!output||typeof output!=='object'||Array.isArray(output))return ['Agent result must be object'];
  const allowed=Object.keys(schema.properties??{}).sort();
  if(allowed.join('|')!==Object.keys(output).sort().join('|'))return ['Agent output keys differ from Schema'];
  for(const field of allowed){
    if(typeof output[field]!==schema.properties[field].type)return [field+' must be '+schema.properties[field].type];
    if(typeof output[field]==='string'&&output[field].length<70){
      return [field+' must be at least 70 characters'];
    }
  }
  return [];
}
const originalRequest='建立 FlowKit Interactive P0-A 的 C01–C12 复杂验收矩阵，验证多 Agent 顺序、条件路由、Schema 重试、SQLite 恢复、签名、安全与长链；不得越界实现 Context 或通用产物存储。';

test('C01/C03 actual ChatGPT multiple tool turns follow real Program, review retry and terminal',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'fk-c01-live-'));
  const file=path.join(root,'run.sqlite');
  let store;
  try{
    const compiled=await compileInteractive(workflowFile,{
      output:'memory',featureStage:'P0-A',skillCheck:false,
    });
    assert.equal(compiled.diagnostics.some(x=>x.severity==='error'),false,
      JSON.stringify(compiled.diagnostics));
    assert.ok(compiled.code&&compiled.programIdentity);
    const keys=generateKeyPairSync('ed25519');
    const privateCanary=randomBytes(24).toString('hex');
    const runtime={
      skillResolver:async d=>{
        assert.equal(typeof instructions[d.nodeId],'string');
        return instructions[d.nodeId];
      },
      validateResult:validate,
    };
    const hostFor=s=>createTrustedInteractiveHost({
      store:s,runtime,policy:{deploymentId:'c01-live-20261111',
        bindingVersions:{skill:'live-c01-v1',validator:'live-c01-v1'}},
      trustedPublicKeys:{'complex-live-host':keys.publicKey},
      trustedArtifacts:[compiled.programIdentity.artifactHash],
      allowedInputKeys:['request','requirementSummary','designSummary','executionPlan'],
      disclosurePolicyId:'allow-public-c01-inputs',
      authorizeDisclosure:async({task})=>
        task?.runId===runId&&expectedPath.includes(task?.nodeId),
      now:()=>NOW,
    });
    store=createSqliteCheckpointStore(file,{namespace});
    let host=hostFor(store);
    let frame=await host.start({
      programBytes:Buffer.from(compiled.code,'utf8'),
      programIdentity:compiled.programIdentity,
      runId,startKey:'complex-live-c01-start',
      state:{ready:true,request:originalRequest,hostSecret:privateCanary},
    });
    assert.equal(frame.status,'waiting');
    let replies=[];
    try{
      replies=JSON.parse(await readFile(repliesFile,'utf8'));
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
    assert.ok(Array.isArray(replies)&&replies.length<=expectedPath.length);
    const resultDigests=[];
    const requestIds=[];
    let rejectedReviewAttempts=0;
    for(let index=0;index<expectedPath.length;index++){
      assert.equal(frame.status,'waiting');
      const task=await host.getPublicAgentTask({runId});
      assert.ok(task);
      assert.equal(task.nodeId,expectedPath[index]);
      assert.equal(task.runId,runId);
      assert.equal(task.kind,'agent');
      assert.ok(!JSON.stringify(task).includes(privateCanary));
      assert.equal(Object.hasOwn(task,'hostSecret'),false);
      assert.equal(Object.hasOwn(task,'state'),false);
      const taskDigest=sha256Bytes(canonicalBytes(task));
      const recorded=replies[index];
      if(!recorded){
        assert.equal(index,replies.length);
        assert.equal((await host.load({runId})).status,'waiting');
        console.log('C01_LIVE_CHATGPT_PENDING '+JSON.stringify({
          index,turn:index+1,expectedPath,
          requestId:task.requestId,taskDigest,
          programHash:compiled.programIdentity.artifactHash,
          task,
          modelTurnsAlreadyRecorded:replies.length,
          warning:'This task must be answered by actual ChatGPT before saving the next fixture',
        }));
        return;
      }
      assert.equal(recorded.index,index);
      assert.equal(recorded.nodeId,task.nodeId);
      assert.equal(recorded.requestId,task.requestId);
      assert.equal(recorded.taskDigest,taskDigest);
      assert.ok(recorded.result&&typeof recorded.result==='object');
      const receipt={
        runId,requestId:task.requestId,nodeId:task.nodeId,attempt:task.attempt,
        kind:'agent-result',result:recorded.result,
      };
      const stmt=createAgentReceiptStatement({
        run:store.load(runId),receipt,keyId:'complex-live-host',
        proofId:'chatgpt-complex-turn-'+index,
        issuedAt:NOW-1000,expiresAt:NOW+30000,
      });
      const attestation={statement:stmt,
        signature:sign(null,encodeAgentReceiptStatement(stmt),keys.privateKey)
          .toString('base64url'),
      };
      // A newly rebuilt Host and Store must resume this same physical SQLite
      // database; this is WITHIN ONE Actions job, not across CI runs.
      store.close();
      store=createSqliteCheckpointStore(file,{namespace});
      host=hostFor(store);
      const recovered=await host.load({runId});
      assert.equal(recovered.status,'waiting');
      assert.equal((await host.getPublicAgentTask({runId})).requestId,task.requestId);
      const accepted=await host.accept({receipt,attestation});
      assert.equal(accepted.duplicate,false);
      assert.equal(store.getReceipt(runId,task.requestId).acceptedRevision,
        accepted.acceptedRevision);
      requestIds.push(task.requestId);
      resultDigests.push(sha256Bytes(canonicalBytes(recorded.result)));
      if(index===3){
        assert.equal(task.nodeId,'review');
        assert.equal(task.attempt,1);
        assert.notEqual(typeof recorded.result.reviewApproved,'boolean',
          'This is an explicitly controlled invalid-schema injection');
        assert.equal(accepted.status,'waiting');
        assert.equal(accepted.pending.nodeId,'review');
        assert.equal(accepted.pending.attempt,2);
        assert.equal(Object.hasOwn(store.load(runId).state,'reviewApproved'),false);
        rejectedReviewAttempts++;
      }
      frame=accepted;
    }
    assert.equal(frame.status,'succeeded');
    assert.equal(frame.terminal.nodeId,'done');
    assert.equal(rejectedReviewAttempts,1);
    assert.equal(requestIds.length,5);
    assert.equal(new Set(requestIds).size,5);
    assert.equal(frame.state.hostSecret,privateCanary);
    assert.equal(frame.state.reviewApproved,true);
    assert.equal(typeof frame.state.requirementSummary,'string');
    assert.equal(typeof frame.state.designSummary,'string');
    assert.equal(typeof frame.state.executionPlan,'string');
    assert.equal(typeof frame.state.reviewNotes,'string');
    const journal=store.listJournal(runId);
    assert.equal(journal.length,frame.revision+1);
    const last=replies.at(-1);
    const lastTask=await host.load({runId});
    assert.equal(lastTask.status,'succeeded');
    const old=store.getReceipt(runId,replies[0].requestId);
    assert.ok(old&&old.acceptedRevision>0);
    console.log('C01_LIVE_CHATGPT_COMPLETED '+JSON.stringify({
      scenarioIds:['C01','C03'],execution:'REAL_CHATGPT_GITHUB_BRIDGE',
      nativeHostAttested:false,realModelTurns:replies.length,
      resultDigests,requestIds,
      programHash:compiled.programIdentity.artifactHash,
      finalStateHash:sha256Bytes(canonicalBytes(frame.state)),
      terminal:frame.status,nodeId:frame.terminal.nodeId,
      journalRevisions:journal.length,restartedSQLiteWithinEachCI:true,
      retriesObserved:rejectedReviewAttempts,
      outputLength:last.result.reviewNotes.length,
      note:'Five real ChatGPT responses, but source/session not independently authenticated by Native Host and CI actions re-create DB',
    }));
  }finally{
    try{store?.close()}finally{await rm(root,{recursive:true,force:true})}
  }
});
