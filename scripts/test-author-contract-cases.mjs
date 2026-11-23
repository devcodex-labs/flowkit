import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInteractiveHostContext, createSqliteInteractivePersistence, loadInteractiveProgram,
  start, complete, resume } from '@devcodex-labs/flowkit/interactive';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { canonicalBytes } from '../src/interactive/canonical.mjs';

const contractRequest = (input, inputType, output) =>
  `根 contract.input 是对象，唯一必填字段 ${input}（${inputType}）。根 contract.output 是对象，唯一必填业务结果是 ${output}（非空字符串）；只从成功路径的同名状态键返回，失败终态不发布业务结果。`;
const commonGoal = '只使用以下既有 Host 回调；所有 Action 都声明 effect: read-only，只写本次流程的本地状态。Host 回调内部逻辑已确定。';

export const authorContractCases = {
  software: {
    name: 'software-release-review', inputKey: 'changeRef', outputKey: 'deliveryReceipt', inputValue: 'change-42',
    goal: '起草 Interactive P2 软件交付审阅工作流。'+contractRequest('changeRef','非空字符串','deliveryReceipt')+commonGoal+
      '先由 Verification check-change 校验变更引用，false 到失败终点，true 进入一个 Human。批准时调用 Action summarize-delivery，写 deliveryReceipt，再到成功终点。第一次要求修改时调用 Action revise-delivery，写内部 revisionEvidence，再回同一个 Human。设置 maxRevisions 为 1，第二次仍可提交要求修改，由修订耗尽直接走失败且不再调用 revise-delivery。明确拒绝由 onDecline 跳到失败终点。按这个流程执行和交付。',
    verifier: 'check-change', outputAction: 'summarize-delivery', expected: value => 'reviewed:' + value,
    decisionCases: [
      { label:'approved', decisions:['approve'], terminal:'succeeded' },
      { label:'revised-and-approved', decisions:['revise','approve'], terminal:'succeeded' },
      { label:'declined', decisions:['decline'], terminal:'failed' },
      { label:'revisions-exhausted', decisions:['revise','revise'], terminal:'failed' },
    ],
  },
  media: {
    name: 'media-caption-delivery', inputKey: 'caption', outputKey: 'subtitleText', inputValue: 'Scene one',
    goal: '起草 Interactive P2 视频字幕交付工作流。'+contractRequest('caption','非空字符串','subtitleText')+commonGoal+
      '先由 Verification check-caption 按 Host 的字符规则检查字幕文本。false 到失败终点。通过后调用 Action format-caption，将字幕格式化为 SRT 并写 subtitleText，随后进入成功终点。只有上述两个回调，不需要人工确认节点。',
    verifier: 'check-caption', outputAction: 'format-caption', expected: value => '1\n00:00:00,000 --> 00:00:02,000\n'+value+'\n',
  },
  data: {
    name: 'data-import-summary', inputKey: 'rowCount', outputKey: 'importSummary', inputValue: 7,
    goal: '起草 Interactive P2 数据导入前检查工作流。'+contractRequest('rowCount','整数','importSummary')+commonGoal+
      '先由 Verification check-rows 判断批次行数是否大于零。false 跳到失败终点，true 调用 Action format-import，写 importSummary 再进入成功终点。只统计已知行数，不写数据库。不需要人工确认节点。',
    verifier: 'check-rows', outputAction: 'format-import', expected: value => value+' rows ready for import',
  },
};

export async function verifyAuthorContractExport(root, directory, domain, graph) {
  const fixture=authorContractCases[domain];
  const contract=graph.contract;
  assert.deepEqual(contract?.input?.required,[fixture.inputKey]);
  assert.deepEqual(contract?.output?.required,[fixture.outputKey]);
  assert.deepEqual(contract.outputKeys,[fixture.outputKey]);
  assert.match(contract.digest,/^sha256:[0-9a-f]{64}$/);
  const state={ [fixture.inputKey]:fixture.inputValue };
  const expected={ [fixture.outputKey]:fixture.expected(fixture.inputValue) };
  const bytes=await readFile(path.join(directory,'workflow.js'));
  const artifactHash=artifactDigest(bytes);
  const { interactiveProgram }=await loadInteractiveProgram(bytes,artifactHash);
  assert.equal(interactiveProgram.identity.implementedStage,'P2');
  const namespace='cli-contract-'+domain;
  const database=path.join(root,'run.sqlite');
  const open=()=>createSqliteInteractivePersistence(database,{namespace});
  const auth=createInteractiveHostContext({namespace,subjectId:'contract-fixture',authorize:()=>true,authorizeTask:()=>true,
    authorizeHuman:({reviewDigest})=>({proofId:'contract-fixture:'+reviewDigest,evidenceHash:reviewDigest})});
  const policy={id:namespace,version:'1',canonicalizationVersion:'jcs-rfc8785-v1',
    capabilityStage:'P2',disclosePolicyId:'contract-test',bindingManifest:{}};
  let persistence=open();
  try {
    const reference=await persistence.programRegistry.putImmutable(bytes,{...interactiveProgram.identity,artifactHash});
    const options=startKey=>({...persistence,auth,policy,startKey});
    await assert.rejects(start(reference,{}, {},options('missing-input')),{code:'FK_R008'});
    const scenarios=[
      ...(fixture.decisionCases??[{label:'accepted',terminal:'succeeded'}]),
      {label:'verification-failed',verifierPass:false,terminal:'failed'},
      {label:'missing-required-output',decisions:['approve'],omitOutput:true,terminal:'errored'},
    ];
    const outcomes={};
    for(const {label,decisions=[],verifierPass=true,omitOutput=false,terminal} of scenarios) {
      let frame=await start(reference,{},state,options(label));
      assert.equal(frame.status,'waiting');
      persistence.close();
      persistence=open();
      const saved=await resume(frame.runId,{},options(label));
      assert.deepEqual(saved.pending,frame.pending);
      frame=saved;
      let index=0, dispatches=0;
      while(frame.status==='waiting') {
        assert.ok(++dispatches<12,'Host step limit');
        assert.equal(frame.pending.length,1);
        const [{ task, nodeId, requestId, kind }]=frame.pending;
        const current=options(label);
        const receipt={runId:frame.runId,requestId,kind,outcome:'succeeded'};
        if(kind==='verification') {
          assert.equal(task.verifier,fixture.verifier);
          frame=await complete({...receipt,result:{passed:verifierPass}}, {},current);
        } else if(kind==='human') {
          const decision=decisions[index++];
          assert.ok(decision,'Unexpected Human Pending: '+nodeId);
          const submission={...receipt,reviewDigest:task.reviewDigest,result:{decision}};
          frame=await complete(submission,{},current);
          assert.equal((await complete(submission,{},current)).acknowledgement.repeated,true);
        } else {
          assert.equal(kind,'action');
          assert.ok(task.action===fixture.outputAction||domain==='software'&&task.action==='revise-delivery');
          const inputHash=artifactDigest(canonicalBytes(task));
          const operation={runId:frame.runId,operationKey:task.operationKey,inputHash};
          assert.equal((await persistence.operationController.claim({...operation,requestId},auth)).readOnly,true);
          const set=task.action==='revise-delivery'?{revisionEvidence:'prepared for second review'}:omitOutput?{}:expected;
          const result={set};
          await persistence.operationController.settle({...operation,effect:'no-effect',result,
            evidenceHash:artifactDigest(canonicalBytes(result))},auth);
          frame=await complete({...receipt,operationKey:task.operationKey,result}, {},current);
        }
      }
      assert.equal(frame.status,terminal,label);
      const projection=await auth.readTerminalResult(frame.resultRef,options(label));
      assert.deepEqual(projection.publicOutput,terminal==='succeeded'?expected:undefined,label);
      if(omitOutput)assert.equal(projection.causeCode,'FK_R009');
      assert.equal((await resume(frame.runId,{},options(label))).revision,frame.revision);
      outcomes[label]={status:frame.status,revision:frame.revision,humanDecisions:index, ...(projection.publicOutput?{output:projection.publicOutput}:{})};
    }
    return {domain,contractDigest:contract.digest,artifactHash,cases:outcomes};
  } finally {persistence.close();}
}
