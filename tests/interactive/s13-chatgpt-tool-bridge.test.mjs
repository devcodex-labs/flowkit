/**
 * ChatGPT-current-conversation -> real JS tool -> actual FlowKit Host bridge.
 *
 * Phase 1 (without a reply file): compile & execute the verified Program,
 * durably publish a public Agent Pending, and print its EXACT requestId/digest.
 * The ChatGPT model then reads that real CI output and writes a reply via its
 * authenticated GitHub tool call (a separate conversation action).
 *
 * Phase 2 (with response fixture): recompile the same workflow, verify that
 * the model-authored result is bound to the actual pending request, recreate
 * a Host from the persisted SQLite database, sign through a Host-only
 * Ed25519 key, accept, CAS, replay the duplicate Ack and check terminal.
 *
 * This proves actual tool-using ChatGPT participated. It does NOT independently
 * attest ChatGPT provider/session origin, Codex-native JS tools or cross-UID
 * model isolation. M6 S13 native Host gate remains separately BLOCKED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {createAgentReceiptStatement,encodeAgentReceiptStatement}
  from '../../src/interactive/host-attestation.mjs';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';

const workflowFile=fileURLToPath(
  new URL('../../examples/interactive/s13-chatgpt.workflow.js',import.meta.url));
const skillFile=fileURLToPath(
  new URL('../../examples/interactive/skills/reviewer.md',import.meta.url));
const replyFile=fileURLToPath(
  new URL('../fixtures/s13-chatgpt-reply.json',import.meta.url));
const runId='s13-chatgpt-bridge-run-20261111';
const startKey='s13-chatgpt-bridge-20261111';
const namespace='s13-chatgpt-bridge-tenant';
const privateCanary='HOST_PRIVATE_'+randomBytes(24).toString('hex');

const initialState={
  ready:true,
  request:'请审查 FlowKit 如何通过可执行 JavaScript Program 约束 Agent 工作流，并给出一项可验证的下一步。',
  constraints:[
    'State 只保留当前工作流所需的轻量状态和少量值。',
    '业务文件/产物由用户配置的 Host 存储处理，Context 可以负责复杂关联。',
    '流程推进及路由必须由 FlowKit Program 决定，模型不能绕开可信 Host。',
  ],
  hostOnlySecret:privateCanary,
};
const policy={
  deploymentId:'s13-chatgpt-tool-bridge',
  bindingVersions:{
    'runtime.skillResolver':'reviewer-skill-test-v1',
    'runtime.validateResult':'reviewer-schema-test-v1',
  },
};
const resultFields=['flowkitBoundary','nextAction','summary'];

test('S13 live ChatGPT turn consumes actual public Pending and returns via Host signature/CAS',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-s13-chatgpt-'));
  const file=path.join(dir,'run.sqlite');
  let store;
  try{
    const compiled=await compileInteractive(workflowFile,{
      output:'memory',
      featureStage:'P0-A',
      skillsRoot:'examples/interactive/skills',
      skillCheck:true,
    });
    assert.equal(compiled.diagnostics.some(x=>x.severity==='error'),false,
      JSON.stringify(compiled.diagnostics));
    assert.ok(compiled.programIdentity?.artifactHash);
    const skill=await readFile(skillFile,'utf8');
    const skillHash=sha256Bytes(Buffer.from(skill,'utf8'));
    const keys=generateKeyPairSync('ed25519');
    const runtime={
      skillResolver:async({agent,skill:declared})=>{
        assert.equal(agent,'reviewer');
        assert.equal(declared,null);
        return skill;
      },
      validateResult:(_schema,output)=>{
        if(!output||typeof output!=='object'||Array.isArray(output)) {
          return ['result must be object'];
        }
        const keys=Object.keys(output).sort();
        if(keys.join(',')!==resultFields.join(','))return ['result field set does not match'];
        return resultFields.every(k=>typeof output[k]==='string'
          && output[k].length>=15 && output[k].length<=1000)?[]:['result field lengths invalid'];
      },
    };
    const hostFor=s=>createTrustedInteractiveHost({
      store:s,
      runtime,policy,
      trustedPublicKeys:{'s13-test-transport':keys.publicKey},
      trustedArtifacts:[compiled.programIdentity.artifactHash],
      allowedInputKeys:['request','constraints'],
      disclosurePolicyId:'s13-public-only-v1',
      authorizeDisclosure:async({task})=>
        task?.kind==='agent' && task?.nodeId==='review'
        && task?.runId===runId,
    });
    store=createSqliteCheckpointStore(file,{namespace});
    const firstHost=hostFor(store);
    const frame=await firstHost.start({
      programBytes:Buffer.from(compiled.code,'utf8'),
      programIdentity:compiled.programIdentity,
      runId,startKey,state:initialState,
    });
    assert.equal(frame.status,'waiting');
    const pending=await firstHost.getPublicAgentTask({runId});
    assert.equal(pending.kind,'agent');
    assert.equal(pending.nodeId,'review');
    assert.equal(pending.runId,runId);
    assert.deepEqual(pending.input,{
      request:initialState.request,constraints:initialState.constraints,
    });
    assert.equal(JSON.stringify(pending).includes(privateCanary),false);
    assert.equal(JSON.stringify(pending).includes('hostOnlySecret'),false);
    const taskDigest=sha256Bytes(canonicalBytes(pending));
    const firstJournal=store.listJournal(runId);
    assert.ok(firstJournal.length>=3);
    assert.equal(store.load(runId).pending.requestId,pending.requestId);

    // Actual public Agent task, published only after durable SQLite Pending.
    // No Host secrets, Store path, full State or private signing key are printed.
    console.log('S13_CHATGPT_PUBLIC_TASK '+JSON.stringify({
      taskDigest,task:pending,
      skillSha256:skillHash,
      artifactHash:compiled.programIdentity.artifactHash,
    }));
    let modelReply;
    try{
      modelReply=JSON.parse(await readFile(replyFile,'utf8'));
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
    }
    if(!modelReply){
      assert.equal((await firstHost.load({runId})).status,'waiting');
      console.log('S13_CHATGPT_PHASE1_WAITING '+JSON.stringify({
        runId,requestId:pending.requestId,revision:frame.revision,
        journalRevisions:firstJournal.length,
        result:'Real public task printed for next ChatGPT tool turn',
      }));
      return;
    }
    assert.equal(modelReply.runId,runId);
    assert.equal(modelReply.requestId,pending.requestId);
    assert.equal(modelReply.taskDigest,taskDigest);
    assert.ok(modelReply.result);
    assert.equal(runtime.validateResult(null,modelReply.result).length,0);

    // Host lifecycle: close actual SQLite Store after durable Pending, then
    // reopen and continue without recompiling at the resume boundary.
    store.close();
    store=createSqliteCheckpointStore(file,{namespace});
    const resumedHost=hostFor(store);
    const recovered=await resumedHost.load({runId});
    assert.equal(recovered.status,'waiting');
    const afterRestartTask=await resumedHost.getPublicAgentTask({runId});
    assert.equal(afterRestartTask.requestId,pending.requestId);
    assert.equal(sha256Bytes(canonicalBytes(afterRestartTask)),taskDigest);
    const receipt={
      runId,
      requestId:pending.requestId,
      nodeId:pending.nodeId,
      attempt:pending.attempt,
      kind:'agent-result',
      result:modelReply.result,
    };
    // Local Host signer is separate from the public model task, but this
    // fixture has NO independent native ChatGPT session attestation.
    const now=Date.now();
    const statement=createAgentReceiptStatement({
      run:store.load(runId),receipt,keyId:'s13-test-transport',
      proofId:'chatgpt-github-bridge-result-001',
      issuedAt:now-1000,expiresAt:now+60000,
    });
    const attestation={
      statement,
      signature:sign(null,encodeAgentReceiptStatement(statement),keys.privateKey)
        .toString('base64url'),
    };
    const before=store.load(runId);
    assert.equal(before.status,'waiting');
    // Signed, but bogus signature must not mutate Run.
    await assert.rejects(resumedHost.accept({
      receipt,attestation:{statement,signature:'forged'},
    }),{code:'FK_I_PROVENANCE_REJECTED'});
    assert.equal(store.load(runId).revision,before.revision);
    const completed=await resumedHost.accept({receipt,attestation});
    assert.equal(completed.status,'succeeded');
    assert.equal(completed.terminal.nodeId,'done');
    assert.equal(completed.state.hostOnlySecret,privateCanary);
    assert.equal(completed.state.summary,modelReply.result.summary);
    assert.equal(completed.state.nextAction,modelReply.result.nextAction);
    assert.equal(completed.state.flowkitBoundary,modelReply.result.flowkitBoundary);
    const receiptIndex=store.getReceipt(runId,receipt.requestId);
    assert.equal(receiptIndex.acceptedRevision,completed.acceptedRevision);
    assert.equal(store.listJournal(runId).length,completed.revision+1);
    const duplicate=await resumedHost.accept({receipt,attestation});
    assert.equal(duplicate.duplicate,true);
    assert.equal(duplicate.acceptedRevision,completed.acceptedRevision);
    assert.equal(duplicate.revision,completed.revision);
    assert.equal((await resumedHost.resume({runId})).status,'succeeded');
    console.log('S13_CHATGPT_TOOL_BRIDGE_COMPLETED '+JSON.stringify({
      runId,requestId:receipt.requestId,
      modelReplyDigest:sha256Bytes(canonicalBytes(modelReply.result)),
      artifactHash:compiled.programIdentity.artifactHash,
      taskDigest,skillHash,
      status:completed.status,
      terminal:completed.terminal.nodeId,
      acceptedRevision:completed.acceptedRevision,
      journalRevisions:completed.revision+1,
      duplicateAck:true,restoredFromSQLite:true,
      policyPinned:true,
      secretNotExposedToPublicTask:true,
      warning:'Actual ChatGPT tool-using answer, but NO independent native model-session attestation; S13 remains BLOCKED',
    }));
  }finally{
    try{store?.close()}finally{await rm(dir,{recursive:true,force:true})}
  }
});
