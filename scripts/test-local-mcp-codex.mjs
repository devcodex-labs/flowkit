import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { get } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildCodexMarketplace } from './build-codex-plugin.mjs';
import { startLocalMcp } from './run-local-mcp.mjs';
import { deliveryNames, exportTrust, newExportKey, publicDelivery, readPortableExport } from './local-mcp-artifacts.mjs';
import { readWorkflowPageData } from './workflow-viewer.mjs';
import { browserIdentity, confirmInTestBrowser, monthlyTimesheetModel } from '../tests/integrations/local-mcp-fixture.mjs';
import { compileInteractive, createInteractiveHostContext, createSqliteInteractivePersistence, loadInteractiveProgram,
  start, complete, resume } from '@devcodex-labs/flowkit/interactive';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { canonicalBytes } from '../src/interactive/canonical.mjs';
import { checkCandidate, prepareStandardSkill } from '../src/author/standard-artifact.mjs';
import { openLocalSkillStore } from '../src/author/local-skill-store.mjs';
import { createApiAgentAdapter, runApprovedCollectionWorkflow } from '../dist/host.mjs';
import { localModel } from './local-mcp-model.mjs';
import { createLocalCodexSkills } from './local-codex-skills.mjs';
import { readPublishedGraphDocument } from './local-capability-graph.mjs';
import { authorContractCases, verifyAuthorContractExport } from './test-author-contract-cases.mjs';

const token = randomBytes(32).toString('hex');
const live = process.argv.includes('--live');
const interactive=process.argv.includes('--interactive');
const readOnly = process.argv.includes('--p0b');
const fixtureIndex = process.argv.indexOf('--layout-fixture');
const fixtureDirectory = fixtureIndex < 0 ? null : process.argv[fixtureIndex + 1];
const layoutValidation = process.argv.includes('--verify-model-layout');
const relayoutValidation = process.argv.includes('--verify-relayout');
const nativeProfessional = process.argv.includes('--verify-native-professional');
const professional = nativeProfessional || process.argv.includes('--verify-professional');
const capabilityGraph = process.argv.includes('--capability-graph');
const openai = process.argv.includes('--openai');
const referenceMode = process.argv.includes('--reference') || !!fixtureDirectory;
const longTurnMs = 660000;
const specIndex = process.argv.indexOf('--v45-spec');
const v45Spec = specIndex !== -1;
// The 140-node acceptance fixture needs time for authoring and a separate full review.
const acceptanceTurnMs = v45Spec ? 1_200_000 : longTurnMs;
const acceptanceTaskMs = v45Spec ? 420_000 : 150_000;
const acceptanceToolSec = (v45Spec || layoutValidation || professional ? acceptanceTurnMs : 240_000) / 1000 + 30;
const v45MaxTotalTokens = 128_000;
const domainIndex = process.argv.indexOf('--contract-domain');
const domain = domainIndex < 0 ? null : process.argv[domainIndex + 1];
if (domainIndex >= 0 && (!Object.hasOwn(authorContractCases, domain) || !live || interactive || readOnly || referenceMode)) {
  throw new Error('Use --live --contract-domain software|media|data');
}
const contractCase = domain && authorContractCases[domain];
if (v45Spec && (!live || interactive || readOnly || referenceMode || contractCase || !process.argv[specIndex + 1])) {
  throw new Error('Use --live --v45-spec <approved-business-spec.txt>');
}
const v45Input = v45Spec ? await readFile(process.argv[specIndex + 1], 'utf8') : null;
if (fixtureIndex >= 0 && !fixtureDirectory || layoutValidation && (!live || !referenceMode) ||
    relayoutValidation && !layoutValidation || openai && !layoutValidation && !professional ||
    professional && (!live || referenceMode || readOnly || interactive || v45Spec || contractCase)) {
  throw new Error('Use --live --verify-professional or --live --verify-model-layout with a signed fixture; add --openai for Responses');
}
const importedFiles = fixtureDirectory && Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
  [name, await readFile(path.join(fixtureDirectory, name), 'utf8')])));
const sourceKey = referenceMode ? importedFiles ? JSON.parse(importedFiles['workflow.html']
  .match(/<script type="application\/json" id="flowkit-export-provenance">([^<]+)<\/script>/)[1]) : newExportKey() : null;
if (readOnly && (!live || interactive)) throw new Error('Use --live --p0b for the Interactive read-only Action scenario');
const ticketContracts = [
  { id: 'read-ticket', kind: 'action', version: '1', implementationDigest: artifactDigest('p0b-ticket-read-fixture-v1'),
    effect: 'read-only', reads: [], writes: ['ticket', 'ticketOutcome'],
    rules: [
      'A normal read settles with no-effect and a successful Action receipt. It writes ticketOutcome as found or not-found.',
      'When found, the receipt also writes ticket. When not-found, it writes only ticketOutcome.',
      "After the successful read, use a Condition on ticketOutcome. Only ticketOutcome === 'found' reaches the check-ticket Verification. A not-found ticket goes to a failed Terminal without calling check-ticket.",
    ] },
  { id: 'check-ticket', kind: 'verification', version: '1', implementationDigest: artifactDigest('p0b-ticket-check-fixture-v1'),
    rules: ['Verify a found ticket. True goes to a succeeded Terminal; false goes to a failed Terminal.'] },
];
const professionalGoal = [
  '起草 Standard 工作流，根据一条 FlowKit 候选交付记录判断能否导出。',
  '根输入必须有字符串 evidence，根输出必须有字符串 decision。只用一个 Agent 步骤评估并产出 decision，之后直接到成功终点。',
  'Agent 的业务角色为交付复核员。该步骤需要可复用的 Professional Skill，稳定 ID 为 delivery-review，写清下列判断规则，先查已授权目录。',
  '复审未通过时返回「等待复审」，复审通过但用户尚未确认时返回「等待确认」，复审和用户确认都完成时返回「可以导出」。',
  'Agent 从工作流调用方获得 evidence，只读评估，不执行导出或调用外部工具。Agent 返回的 JSON 只含 decision。'
].join('\n');
const goal = professional ? professionalGoal + (capabilityGraph ?
  '\n本轮是定义工作流候选。请从已授权 FlowKit 图谱选择能力 flowkit::define-workflow（Author or define a workflow），读取其 flowkit-doc-authoring 指南，并在冻结提案和独立复审中使用该指南。' : '') :
  v45Spec ? '按完整的 V4.5 软件开发交付业务规格，起草可由独立宿主运行的 Interactive P2 工作流。保持原规格的 Schema 精确：只在内层 request 声明 additionalProperties: false，根 input 和 output 均省略 additionalProperties。' :
  contractCase ? contractCase.goal : readOnly ?
  '起草 Interactive P0-B 工单校验工作流，严格按 Host 提供的 read-ticket 与 check-ticket 契约编排。正常读取回执返回 ticketOutcome。工单找到后调用 check-ticket，校验通过则成功，否则失败。工单不存在时直接失败并跳过校验。只编排这两个回调，无外部写入。' : interactive ?
  '起草一个 Interactive P2 月度工时表校验工作流。外层并行必须全部通过，一个分支校验输入，另一分支在复核副本与复核原表之间选首个成功。Host 提供三个既有的只读布尔校验器 check-input、check-copy 和 check-original，分别对应输入、副本和原表。输入不通过时整体失败；任一复核通过即可继续，两个复核均不通过时整体失败。流程只编排这三个校验器。' :
  '起草一个 Standard 月度工时表工作流，只编排既有 Host 回调。公开 contract.input 声明必填的 employeeId（string）、month（string）和 hours（number）。Host 的 check-input 只读校验这三个字段，检查 hours 是 0 到 744 的有限数字，并以布尔值返回。初检为 true 才执行 Host 的 write-copy，它生成独立副本且不改原表，并将副本引用写入 state.copyRef。随后执行 Host 的 check-copy，由此回调以布尔值校验字段、行数和工时总和。两个校验器返回 false 都走失败终点，复核为 true 才走成功终点。调用方从 Standard runArtifact 的 state.copyRef 读取结果，省略 contract.output。复核紧跟写入动作，write-copy 显式声明 onError 指向失败终点，控制信号继续抛出。回调内部逻辑由 Host 实现。';
const base = path.resolve('.tmp');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'flowkit-codex-e2e-'));
const cwd = path.join(root, 'workspace');
await mkdir(cwd);
const nativeSkillBody = '---\r\nname: delivery-review\r\ndescription: 只读复核一条 FlowKit 候选交付记录。\r\n---\r\n\r\n' +
  '作为交付复核员，只读评估工作流调用方提供的一条 FlowKit 候选交付记录，唯一输入是字符串 evidence。' +
  '复审未通过时，decision 为「等待复审」。复审通过但用户尚未确认时，decision 为「等待确认」。' +
  '复审通过且用户已经确认时，decision 为「可以导出」。只返回一个仅含字符串字段 decision 的 JSON 对象。' +
  '不要执行导出、修改记录、调用外部工具或使用其他输入。\r\n';
if (nativeProfessional) {
  const directory = path.join(cwd, '.agents', 'skills', 'delivery-review');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), nativeSkillBody);
}
const requestGraph = capabilityGraph && professional;
const graphActivity = { matches: 0, reads: 0, reviews: new Map() };
let liveAcceptanceModel;
if (live && (capabilityGraph || v45Spec)) {
  const workspace = path.join(root, 'model');
  await mkdir(workspace);
  const provider = openai ? 'openai' : 'codex';
  liveAcceptanceModel = localModel({ provider, workspace, model: process.env.FLOWKIT_AUTHOR_MODEL,
    apiKey: process.env.OPENAI_API_KEY, timeoutMs: professional || v45Spec ? acceptanceTaskMs : undefined,
    ...(v45Spec ? { maxTotalTokens: v45MaxTotalTokens } : {}) });
  const { request, createSession } = liveAcceptanceModel.execution;
  liveAcceptanceModel.execution.request = async (body, options) => {
    if (!body.flowkitCapabilityMatch) return request(body, options);
    graphActivity.matches++;
    const selection = await request(body, options);
    console.log(JSON.stringify({ path: 'live-graph-model-selection', decision: selection.decision, ids: selection.ids }));
    return selection;
  };
  liveAcceptanceModel.execution.createSession = async (...args) => {
    const session = await createSession(...args);
    const runAgentTask = session.runtime.runAgentTask.bind(session.runtime);
    session.runtime.runAgentTask = async (prepared, ...context) => {
      const { node, input, execution } = prepared.task;
      if (capabilityGraph && node.id === 'semantic-review') graphActivity.reviews.set(execution.requestId, input.resourceSnapshot?.documents ?? []);
      const result = await runAgentTask(prepared, ...context);
      if (v45Spec) console.log(JSON.stringify({ path: 'live-v45-model-stage', stage: node.id, status: result.status,
        failure: result.failure?.code, usage: result.usage, executionId: execution.requestId }));
      return result;
    };
    return session;
  };
}
const service = await startLocalMcp({
  listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports'),
  ...(nativeProfessional ? { codexSkillsWorkspace: cwd } : {}),
  ...(capabilityGraph ? { capabilityGraph: true } : {}),
  ...(v45Spec || layoutValidation || professional ? { authorTaskTimeoutMs: acceptanceTaskMs, authorTurnDurationMs: acceptanceTurnMs } : {}),
  ...(openai ? { authorProvider: 'openai' } : {}),
  ...(sourceKey ? { trustedExportKeys: [sourceKey.publicKey] } : {}),
}, { credential: token, ...(readOnly ? { hostExecutionContracts: ticketContracts } : {}),
  ...(liveAcceptanceModel ? { modelBinding: liveAcceptanceModel } : live ? {} : { modelBinding: monthlyTimesheetModel({interactive}) }),
  ...(live && capabilityGraph ? { readDocumentUrl(url, { signal } = {}) {
    graphActivity.reads++;
    return readPublishedGraphDocument(url, 90000, signal);
  } } : {}) });

async function verifyApprovedSkillRun(exported, saved) {
  const files = Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
    [name, await readFile(path.join(exported.directory, name), 'utf8')])));
  const { candidate } = readPortableExport(files, exportTrust([service.exportPublicKey]));
  assert.equal(candidate.hash, saved.candidateHash);
  const [pin] = candidate.manifest.professionalSkills;
  assert.equal(pin.id, 'delivery-review');
  assert.equal(candidate.manifest.nodeRoles.find(role => role.nodeId === pin.nodeId).label, '交付复核员');
  const provider = openai ? 'openai' : 'codex';
  const model = process.env.FLOWKIT_AUTHOR_MODEL;
  const transport = localModel({ provider, model, apiKey: process.env.OPENAI_API_KEY, workspace: cwd, timeoutMs: 150000 });
  const calls = [];
  const adapter = createApiAgentAdapter({ scope: 'flowkit-delivery-acceptance', model: model ?? 'codex-default', supportsTools: false,
    limits: { timeoutMs: 150000, maxTotalTokens: 64000 }, async request(body, context) {
      const response = await transport.requestForExecution(body, context);
      const data = await response.clone().json();
      calls.push({ status: response.status, model: data.model ?? model ?? 'codex-default', requestId: response.headers.get('x-request-id') ?? data.id });
      return response;
    } });
  const store = openLocalSkillStore(path.join(root, 'state', 'author.sqlite'), () => false, () => false, { namespace: 'flowkit-local' });
  try {
    const nativeResolver = nativeProfessional ? await createLocalCodexSkills({ workspace: cwd,
      root: path.join(root, 'state', 'codex-skill-generations'), collection: { id: service.collectionId } }) : undefined;
    if (nativeResolver) assert.match(pin.source, /^codex-skill:/);
    const taskPolicy = { projectRoot: cwd, maxDurationMs: 150000, hostProfile: { schemaVersion: 1, hostId: provider, hostVersion: '1.0.0',
      adapterId: 'responses', adapterVersion: '1.0.0', executionModes: ['standard'], capabilities: { skillResourceLoading: 'supported' } } };
    const runtime = { isControlSignal: () => false, validateResult: () => [], taskPolicy,
      async runAgentTask(prepared, context) {
        const [skill] = prepared.skills;
        assert.equal(skill.logicalId, pin.id);
        assert.equal(skill.resolvedVersion, pin.version);
        assert.equal(skill.digest, pin.digest);
        assert.match(skill.files['SKILL.md'], /等待确认/);
        if (nativeResolver) assert.equal(skill.files['SKILL.md'], nativeSkillBody);
        return adapter.runAgentTask(prepared, context);
      } };
    const run = await runApprovedCollectionWorkflow(store, { collectionId: service.collectionId, skillId: saved.workflowId,
      candidateHash: candidate.hash, skillDirectory: exported.directory, executionRef: 'live-approved-delivery' },
    { hostProfile: candidate.manifest.hostProfile, authorizeExecution: ({ candidateHash }) => candidateHash === candidate.hash,
      resolveApplicableSafetyPolicies: () => [], runtime, ...(nativeResolver ? { resolveRunProfessionalSkill: nativeResolver.resolve } : {}) },
    { evidence: '候选已经通过独立复审。用户尚未确认当前候选版本。' }, { projectRoot: cwd });
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(run.publicOutput.decision, '等待确认');
    assert.ok(calls.length && calls.every(call => call.status === 200 && call.requestId));
    await writeFile(path.join(root, 'export-public-key.txt'), service.exportPublicKey + '\n');
    console.log(JSON.stringify({ path: 'live-approved-professional-workflow', provider, candidateHash: candidate.hash,
      artifactHash: candidate.manifest.artifactHash, directory: exported.directory, pin, calls, result: run.publicOutput }));
  } finally { store.close(); }
}

async function testReferenceDelivery(tool) {
  const { candidate } = importedFiles ? readPortableExport(importedFiles, exportTrust([sourceKey.publicKey])) : await prepareStandardSkill({
    file: 'examples/v45/software-delivery.workflow.js', collectionId: 'v45-reference', skillId: 'software-delivery',
    name: 'software-delivery', description: 'V4.5 software delivery reference', version: '1.0.0',
    hostProfile: { id: 'flowkit-local-authoring', digest: artifactDigest('flowkit-local-authoring-v1') },
    buildId: 'v45-reference', executionMode: 'interactive-p2', safetyPolicies: [],
  });
  const sourceGraph = checkCandidate(candidate);
  if (!importedFiles) assert.equal(sourceGraph.nodes.length, 140);
  const cookie = await browserIdentity(service);
  const origin = new URL(service.url).origin;
  const upload = await fetch(origin + '/sources', { method: 'POST', headers: { cookie, origin },
    body: new URLSearchParams({ source: JSON.stringify(importedFiles ?? publicDelivery(candidate, sourceKey)) }) });
  assert.equal(upload.status, 200);
  const { sourceRef } = await upload.json();
  const requestId = 'v45-cli-add';
  const waiting = await tool('flowkit_add_workflow', { requestId, sourceRef, candidateHash: candidate.hash, destination: 'flowkit' });
  assert.ok(waiting.confirmationUrl, JSON.stringify(waiting));
  // The default fetch headers timeout can expire before the configured live layout deadline.
  const page = await new Promise((resolve, reject) => {
    get(waiting.confirmationUrl, { headers: { cookie }, signal: AbortSignal.timeout(longTurnMs + 10000) }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Reference preview returned HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(chunks.join('')));
      response.on('error', reject);
    }).on('error', reject);
  });
  const preview = readWorkflowPageData(page);
  if (layoutValidation) assert.deepEqual(preview.graph, sourceGraph);
  const saved = await (await confirmInTestBrowser(waiting.confirmationUrl, cookie)).json();
  assert.equal(saved.status, 'added');
  const db = new DatabaseSync(path.join(root, 'state', 'local-mcp.sqlite'), { readOnly: true });
  let binding;
  let layoutProof;
  try {
    binding = JSON.parse(db.prepare('SELECT value FROM local_mcp WHERE key=?').get('add:' + requestId).value);
    if (layoutValidation) {
      const row = db.prepare("SELECT value FROM local_mcp WHERE key LIKE 'preview-layout-selection:%' AND key LIKE ?")
        .get('%:' + binding.candidateHash);
      const selection = JSON.parse(row.value);
      assert.equal(selection.source, 'model', JSON.stringify(selection));
      assert.ok(preview.layout.edges.every(edge => edge.route?.length >= 2), 'The preview must use accepted model geometry');
      const layout = JSON.parse(db.prepare('SELECT value FROM local_mcp WHERE key=?').get(selection.key).value);
      assert.ok(layout.receipts.some(r => r.accepted && r.provider === (openai ? 'openai' : 'codex')));
      if (sourceGraph.nodes.length > 60) assert.ok(layout.receipts.some(r =>
        ['partition', 'arrangement'].includes(r.task) && r.accepted));
      layoutProof = { nodes: sourceGraph.nodes.length, regions: sourceGraph.regions.length,
        visibleEdges: preview.layout.edges.length, layoutHash: layout.layoutHash, skillContract: layout.layoutContractHash, requests: layout.receipts };
    }
  }
  finally { db.close(); }
  assert.equal(binding.candidateHash, saved.candidateHash);
  const { draftId, candidateHash } = binding;
  await tool('flowkit_export_workflow', { draftId, candidateHash: candidate.hash }, true);
  const exported = await tool('flowkit_export_workflow', { draftId, candidateHash });
  assert.deepEqual((await readdir(exported.directory)).sort(), ['workflow.html', 'workflow.js', 'workflow.mmd']);
  const offline = readWorkflowPageData(await readFile(path.join(exported.directory, 'workflow.html'), 'utf8'));
  assert.deepEqual(offline, preview);
  assert.equal(offline.graph.artifactHash, artifactDigest(await readFile(path.join(exported.directory, 'workflow.js'))));
  if (layoutValidation) {
    const files = Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
      [name, await readFile(path.join(exported.directory, name), 'utf8')])));
    assert.equal(readPortableExport(files, exportTrust([service.exportPublicKey])).candidate.hash, candidateHash);
    assert.equal(files['workflow.js'], importedFiles?.['workflow.js'] ?? candidate.files['workflow.js']);
    assert.equal(files['workflow.mmd'], importedFiles?.['workflow.mmd'] ?? candidate.files['workflow.mmd']);
  }
  let relayoutProof;
  if (relayoutValidation) {
    const current = await tool('flowkit_get_workflow_draft', { draftId });
    const input = { requestId: 'reference-relayout', draftId, candidateHash, expectedLayoutRevision: current.candidate.layoutRevision };
    const changed = await tool('flowkit_relayout_workflow', input);
    assert.equal(changed.status, 'relayout-complete', JSON.stringify(changed));
    assert.notEqual(changed.layoutRevision, input.expectedLayoutRevision);
    const repeated = await tool('flowkit_relayout_workflow', input);
    assert.equal(repeated.layoutRevision, changed.layoutRevision);
    await tool('flowkit_export_workflow', { draftId, candidateHash, layoutRevision: input.expectedLayoutRevision }, true);
    const revised = await tool('flowkit_export_workflow', { draftId, candidateHash, layoutRevision: changed.layoutRevision });
    assert.notEqual(revised.directory, exported.directory);
    const byName = delivery => Object.fromEntries(delivery.files.map(file => [file.name, file]));
    const oldFiles = byName(exported), newFiles = byName(revised);
    for (const name of ['workflow.js', 'workflow.mmd']) assert.equal(newFiles[name].sha256, oldFiles[name].sha256);
    const oldHtml = await fetch(oldFiles['workflow.html'].url);
    assert.ok(oldHtml.ok);
    assert.equal(artifactDigest(await oldHtml.text()), oldFiles['workflow.html'].sha256);
    const previewResponse = await fetch(changed.previewUrl, { headers: { cookie } });
    assert.ok(previewResponse.ok);
    const html = await readFile(path.join(revised.directory, 'workflow.html'), 'utf8');
    assert.deepEqual(readWorkflowPageData(html), readWorkflowPageData(await previewResponse.text()));
    const files = Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
      [name, await readFile(path.join(revised.directory, name), 'utf8')])));
    assert.equal(readPortableExport(files, exportTrust([service.exportPublicKey])).candidate.hash, candidateHash);
    relayoutProof = { requestId: input.requestId, layoutRevision: changed.layoutRevision, layoutHash: changed.layoutHash,
      directory: revised.directory, originalExport: exported.directory, oldDownloadVerified: true };
  }
  console.log(JSON.stringify({ path: layoutValidation ? (openai ? 'layout-openai-mcp' : 'layout-codex-mcp') : 'v45-codex-mcp',
    candidateHash, directory: exported.directory,
    graphDigest: offline.graph.graphDigest, artifactHash: offline.graph.artifactHash, staleCandidateRejected: true, layoutProof, relayoutProof }));
  return saved;
}

async function runExport(directory) {
  const bytes=await readFile(path.join(directory,'workflow.js'));
  const artifactHash=artifactDigest(bytes);
  const program=await loadInteractiveProgram(bytes,artifactHash);
  const stage = readOnly ? 'P0-B' : 'P2';
  assert.equal(program.interactiveProgram.identity.implementedStage, stage);
  const namespace='cli-export';
  const database=path.join(root,'run.sqlite');
  let persistence=createSqliteInteractivePersistence(database,{namespace});
  const auth=createInteractiveHostContext({namespace,subjectId:'fixture',authorize:()=>true,authorizeTask:()=>true});
  const options={...persistence,auth,policy:{id:'cli-export',version:'1',
    canonicalizationVersion:'jcs-rfc8785-v1',capabilityStage:stage,disclosePolicyId:'test',bindingManifest:{}}};
  try {
    const reference=await persistence.programRegistry.putImmutable(bytes,{...program.interactiveProgram.identity,artifactHash});
    if (readOnly) {
      const outcomes = {};
      const cases = [
        { startKey: 'check-passed', ticketOutcome: 'found', passed: true, status: 'succeeded' },
        { startKey: 'check-rejected', ticketOutcome: 'found', passed: false, status: 'failed' },
        { startKey: 'ticket-not-found', ticketOutcome: 'not-found', status: 'failed' },
      ];
      for (const { startKey, ticketOutcome, passed, status } of cases) {
        const runOptions = { ...options, startKey };
        let frame = await start(reference, {}, {}, runOptions);
        assert.equal(frame.pending.length, 1);
        const [read] = frame.pending;
        assert.equal(read.task.action, 'read-ticket');
        const { operationKey } = read.task;
        const inputHash = artifactDigest(canonicalBytes(read.task));
        const claim = { runId: frame.runId, requestId: read.requestId, operationKey, inputHash };
        assert.equal((await persistence.operationController.claim(claim, auth)).readOnly, true);
        const found = ticketOutcome === 'found';
        const result = { set: { ticketOutcome, ...(found ? { ticket: { id: 'test-ticket' } } : {}) } };
        const settlement = { runId: frame.runId, operationKey, inputHash,
          effect: 'no-effect', evidenceHash: artifactDigest(startKey), result };
        const saved = await persistence.operationController.settle(settlement, auth);
        if (startKey === 'check-passed') {
          persistence.close();
          persistence=createSqliteInteractivePersistence(database,{namespace});
          Object.assign(options,persistence);
          Object.assign(runOptions,persistence);
          const resumed = await resume(frame.runId,{},runOptions);
          assert.equal(resumed.runId,frame.runId);
          assert.equal(resumed.pending[0]?.requestId,read.requestId);
          assert.deepEqual(await persistence.operationController.load({runId:frame.runId,operationKey},auth),saved);
          assert.deepEqual(await persistence.operationController.settle(settlement,auth),saved);
          console.log(JSON.stringify({path:'interactive-resume',runId:resumed.runId,requestId:read.requestId,
            originalRun:true,repeatedSettlement:true,storageReopened:true}));
        }
        frame = await complete({ runId: frame.runId, requestId: read.requestId, operationKey,
          kind: 'action', outcome: 'succeeded', result }, {}, runOptions);
        if (found) {
          assert.equal(frame.pending.length, 1);
          const [verification] = frame.pending;
          assert.equal(verification.task.verifier, 'check-ticket');
          frame = await complete({ runId: frame.runId, requestId: verification.requestId, kind: 'verification',
            outcome: 'succeeded', result: { passed } }, {}, runOptions);
        }
        assert.equal(frame.status, status);
        assert.equal(frame.pending.length, 0);
        outcomes[startKey] = { status: frame.status, verificationCalls: found ? 1 : 0, runId: frame.runId };
      }
      console.log(JSON.stringify({ path: 'interactive-sdk', stage, effect: 'no-effect', cases: outcomes }));
      return;
    }
    const groups=Object.entries(program.programTable.nodes).filter(([,node])=>node.kind==='parallel');
    assert.ok(groups.some(([id,inner])=>inner.metadata.strategy==='any' &&
      groups.some(([,outer])=>outer.metadata.strategy==='all_succeeded' &&
        outer.metadata.branchNodes?.some(branch=>branch.includes(id)))), 'Expected an any group nested inside all_succeeded');
    const verifiers=['check-input','check-copy','check-original'];
    const cases=[
      { label:'first-review-wins', passes:['check-input','check-copy'], visited:verifiers.slice(0,2), terminal:'succeeded' },
      { label:'fallback-review-wins', passes:['check-input','check-original'], visited:verifiers, terminal:'succeeded' },
      { label:'all-reviews-fail', passes:['check-input'], visited:verifiers, terminal:'failed' },
      { label:'input-rejected', passes:['check-copy','check-original'], visited:verifiers.slice(0,1), terminal:'failed' }
    ];
    for (const {label,passes,visited,terminal} of cases) {
      const runOptions={...options,startKey:label};
      let frame=await start(reference,{}, {},runOptions);
      assert.deepEqual(frame.pending.map(task=>task.task.verifier).sort(),[...verifiers].sort());
      for (const verifier of visited) {
        const request=frame.pending.find(item=>item.task.verifier===verifier);
        assert.equal(request?.kind,'verification',label+' needs Pending '+verifier);
        frame=await complete({runId:frame.runId,requestId:request.requestId,kind:'verification',
          outcome:'succeeded',result:{passed:passes.includes(verifier)}},{},runOptions);
      }
      assert.equal(frame.status,terminal,label);
    }
    console.log(JSON.stringify({path:'interactive-sdk',stage:'P2',
      cases:Object.fromEntries(cases.map(({label,terminal})=>[label,terminal]))}));
  } finally {persistence.close();}
}

const envFor = (home, credential = token) => ({
  ...process.env, CODEX_HOME: path.join(root, home), FLOWKIT_MCP_TOKEN: credential
});
function codex(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timeout = setTimeout(() => child.kill(), 30000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(args.slice(0,3).join(' ') + ' exited ' + code + ': ' + (stderr || stdout).slice(-1000)));
    });
  });
}

async function withAppServer(env, test) {
  const process_ = spawn('codex', ['app-server','--listen','stdio://'], {
    cwd, env, windowsHide: true, stdio: ['pipe','pipe','pipe']
  });
  const pending = new Map();
  let next = 0;
  process_.stderr.resume();
  process_.stdin.on('error', () => {});
  createInterface({ input: process_.stdout }).on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    pending.get(response.id)?.(response);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + ' timed out'));
    }, live && method === 'mcpServer/tool/call' ? (acceptanceToolSec + 10) * 1000 : 25000);
    pending.set(id, response => {
      pending.delete(id);
      clearTimeout(timer);
      if (response.error) reject(new Error(method + ': ' + response.error.message));
      else resolve(response.result);
    });
    process_.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const closed = new Promise(resolve => process_.once('close', resolve));
  const failure = new Promise((_, reject) => process_.once('error', reject));
  try {
    await Promise.race([failure, (async () => {
      await call('initialize', { clientInfo: { name: 'flowkit-cli-test', version: '1.0.0' } });
      process_.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
      const { thread } = await call('thread/start', { cwd, ephemeral: true });
      const { data } = await call('mcpServerStatus/list', { threadId: thread.id });
      const flowkit = data.find(item => Object.hasOwn(item.tools ?? {}, 'flowkit_start_workflow'));
      const tool = async (name, args = {}, expectError = false) => {
        const out = await call('mcpServer/tool/call', { threadId: thread.id, server: flowkit.name, tool: name, arguments: args });
        assert.equal(out.isError === true, expectError, JSON.stringify(out));
        if (!expectError) return JSON.parse(out.content[0].text);
      };
      await test({ data, flowkit, tool, call });
    })()]);
  } finally {
    process_.stdin.end();
    const timer = setTimeout(() => process_.kill(), 3000);
    await closed;
    clearTimeout(timer);
  }
}

try {
  const directEnv = envFor('direct');
  await mkdir(directEnv.CODEX_HOME);
  await writeFile(path.join(directEnv.CODEX_HOME,'config.toml'), '[mcp_servers.flowkit]\nurl = ' +
    JSON.stringify(service.url) + '\nbearer_token_env_var = "FLOWKIT_MCP_TOKEN"\nrequired = true\n' +
    `tool_timeout_sec = ${acceptanceToolSec}\n`);
  let saved;
  await withAppServer(directEnv, async ({ flowkit, tool }) => {
    assert.ok(flowkit);
    assert.equal(Boolean(flowkit.pluginId), false);
    if (nativeProfessional) assert.equal(Object.hasOwn(flowkit.tools, 'flowkit_collection'), false);
    else assert.equal((await tool('flowkit_collection')).collection.id, service.collectionId);
    if (referenceMode) {
      saved = await testReferenceDelivery(tool);
      return;
    }
    const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'cli-start',
      goal, ...(readOnly ? { executionMode: 'interactive-p0-b' } : interactive || contractCase || v45Spec ? { executionMode: 'interactive-p2' } : {}) });
    let candidate = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'cli-plan',
      expectedStateVersion: draft.stateVersion, input: v45Input ?? goal,
      ...(requestGraph ? { useCapabilityGraph: true } : {}),
      target: { name: professional ? 'flowkit-delivery-review' : v45Spec ? 'v45-software-delivery' : contractCase?.name ?? (readOnly ? 'ticket-review' : 'monthly-timesheet') } } });
    const shortStandard = !referenceMode && !readOnly && !interactive && !contractCase && !v45Spec;
    if (live && (professional || shortStandard) && candidate.status === 'needs-revision' && candidate.review.findings.length) {
      console.log(JSON.stringify({ path: 'live-initial-review-rejected', candidateHash: candidate.candidate?.candidateHash,
        findings: candidate.review.findings }));
      candidate = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'cli-revise',
        expectedStateVersion: candidate.stateVersion,
        input: professional ? '按本轮复审发现修订，保留发起时已给定的三条规则、输入输出契约和业务角色。只修改复审指出的问题。' :
          '按上一轮复审发现修订。保留原始任务的三个输入字段、回调、失败分支，以及从 state.copyRef 取结果的约定。' } });
    }
    assert.equal(candidate.status, 'candidate-ready', JSON.stringify(candidate));
    assert.equal(Object.hasOwn(candidate.candidate, 'files'), false);
    const identity = { draftId: draft.id, candidateHash: candidate.candidate.candidateHash };
    assert.equal((await tool('flowkit_review_candidate', { ...identity, previousHash: candidate.previousHash })).qualified, true);
    await tool('flowkit_export_workflow', identity, true);
    const cookie = await browserIdentity(service);
    const preview = readWorkflowPageData(await (await fetch(candidate.candidate.previewUrl, { headers: { cookie } })).text());
    assert.equal(preview.candidateHash, identity.candidateHash);
    if (v45Spec) {
      const reference = await compileInteractive('examples/v45/software-delivery.workflow.js', { output: 'memory', featureStage: 'P2' });
      assert.deepEqual(reference.diagnostics, []);
      assert.equal(preview.graph.contract?.digest, reference.graphSnapshot.contract?.digest, 'V4.5 root Schema differs from the approved reference');
    }
    assert.equal((await confirmInTestBrowser(candidate.candidate.previewUrl, cookie)).status, 200);
    await tool('flowkit_export_workflow', {...identity, candidateHash: 'sha256:' + '0'.repeat(64)}, true);
    const exported = await tool('flowkit_export_workflow', identity);
    assert.deepEqual((await readdir(exported.directory)).sort(), ['workflow.html','workflow.js','workflow.mmd']);
    assert.match(await readFile(path.join(exported.directory, 'workflow.mmd'), 'utf8'),
      live ? /flowchart/ : interactive ? /Review alternatives/ : /Verify copy/);
    const offline = readWorkflowPageData(await readFile(path.join(exported.directory, 'workflow.html'), 'utf8'));
    assert.equal(offline.candidateHash, identity.candidateHash);
    if (professional) {
      assert.deepEqual(offline.graph, preview.graph);
      assert.deepEqual(offline.layout, preview.layout);
      assert.equal(preview.executionBindings[0].skills[0].pendingApproval ?? false, !nativeProfessional);
    } else assert.deepEqual(offline, preview);
    assert.equal(offline.graph.artifactHash, artifactDigest(await readFile(path.join(exported.directory, 'workflow.js'))));
    if (live) {
      const db = new DatabaseSync(path.join(root, 'state', 'author.sqlite'), { readOnly: true });
      let reviewedDraft;
      try { reviewedDraft = JSON.parse(db.prepare('SELECT payload FROM fk_author_drafts WHERE draft_id=?').get(draft.id).payload); }
      finally { db.close(); }
      const receipt = reviewedDraft.reviewReceipt;
      assert.equal(receipt.candidateHash, identity.candidateHash);
      assert.equal(receipt.reviewPolicy, 'separate-pass');
      assert.equal(receipt.qualified, true);
      assert.ok(receipt.observation?.executionId && receipt.observation.subjectId);
      const files = Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
        [name, await readFile(path.join(exported.directory, name), 'utf8')])));
      const verified = readPortableExport(files, exportTrust([service.exportPublicKey])).candidate;
      assert.equal(verified.hash, identity.candidateHash);
      if (requestGraph) {
        const evidence = verified.manifest.documents?.find(item => item.documentId === 'flowkit-doc-authoring');
        assert.ok(evidence?.revision && evidence.contentHash && evidence.source?.url, JSON.stringify(verified.manifest.documents));
        assert.ok(graphActivity.matches > 0 && graphActivity.reads > 0);
        assert.ok(reviewedDraft.plan.capabilityRequirements.includes('flowkit::define-workflow'));
        assert.ok(reviewedDraft.resources.capabilities.nodes.some(item => item.capability.id === 'flowkit::define-workflow'));
        const inPlan = reviewedDraft.plan.resourceRequirements.find(pin => pin.documentId === evidence.documentId);
        assert.equal(inPlan?.revision, evidence.revision);
        assert.equal(inPlan?.contentHash, evidence.contentHash);
        const inReview = graphActivity.reviews.get(receipt.observation.executionId)?.find(item =>
          item.evidence.documentId === evidence.documentId);
        assert.deepEqual(inReview?.evidence, evidence);
        assert.ok(inReview.text.trim());
        console.log(JSON.stringify({ path: 'live-graph-author-document', ...evidence, candidateHash: verified.hash,
          matches: graphActivity.matches, reads: graphActivity.reads }));
      } else if (capabilityGraph) {
        assert.deepEqual(verified.manifest.documents ?? [], []);
        assert.deepEqual([graphActivity.matches, graphActivity.reads], [0, 0]);
        console.log(JSON.stringify({ path: 'live-ordinary-with-graph-host', matches: graphActivity.matches, reads: graphActivity.reads }));
      }
      console.log(JSON.stringify({ path: 'live-author-review-signature', candidateHash: identity.candidateHash,
        reviewExecutionId: receipt.observation.executionId, reviewSubjectId: receipt.observation.subjectId,
        signedFilesVerified: deliveryNames.length, ...(readOnly ? { exportPublicKey: service.exportPublicKey } : {}) }));
    }
    if (v45Spec) {
      assert.equal(offline.graph.nodes.length, 140);
      await writeFile(path.join(root, 'export-public-key.txt'), service.exportPublicKey + '\n');
      console.log(JSON.stringify({ path: 'real-v45-author', ...identity, directory: exported.directory, nodes: offline.graph.nodes.length,
        graphDigest: offline.graph.graphDigest, artifactHash: offline.graph.artifactHash, sourceSpecHash: artifactDigest(v45Input),
        modelProvider: 'codex', model: process.env.FLOWKIT_AUTHOR_MODEL || 'codex-default',
        authorTaskTimeoutMs: acceptanceTaskMs, authorTurnDurationMs: acceptanceTurnMs, maxTotalTokensPerTask: v45MaxTotalTokens,
        exportPublicKeyFile: path.join(root, 'export-public-key.txt'), preapprovalRejected: true, wrongVersionRejected: true }));
    }
    if (interactive || readOnly) await runExport(exported.directory);
    if (contractCase) {
      console.log(JSON.stringify({path:'real-author-contract',...(await verifyAuthorContractExport(root,exported.directory,domain,offline.graph)),
        candidateHash: identity.candidateHash, directory: exported.directory, preapprovalRejected:true, wrongVersionRejected:true}));
    }
    const add = { requestId: 'monthly-cli-add', sourceRef: draft.id, candidateHash: identity.candidateHash };
    const waiting = await tool('flowkit_add_workflow', add);
    saved = await (await confirmInTestBrowser(waiting.confirmationUrl, cookie)).json();
    assert.equal(saved.status, 'added');
    assert.deepEqual(await tool('flowkit_add_workflow', add), saved);
    if (professional) {
      await verifyApprovedSkillRun(exported, saved);
      if (nativeProfessional) return;
      const material = (await readFile('website/content/guide/workflow-authoring.mdx', 'utf8')).split('\n## 用 Author 准备 Workflow Skill')[0].slice(0, 12000);
      const source = { id: 'flowkit-guide', title: 'FlowKit 工作流编写指南', content: material };
      const designInput = { requestId: 'real-guide-map', title: 'FlowKit 本机起草、复审与交付', materials: [source] };
      const designDeadline = Date.now() + 600000;
      let design;
      for (;;) {
        design = await tool('flowkit_create_design_diagram', designInput);
        if (design.status !== 'running') break;
        if (Date.now() >= designDeadline) throw new Error('Project design did not finish before the acceptance deadline');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(design.status, 'ready', JSON.stringify(design));
      assert.ok(design.requestId);
      assert.deepEqual(await readdir(design.directory), ['design.html']);
      const view = readWorkflowPageData(await readFile(path.join(design.directory, 'design.html'), 'utf8'));
      assert.equal(view.graph.mode, 'design');
      assert.ok(view.graph.nodes.length >= 3 && view.graph.referenceEdges.length >= 2);
      assert.deepEqual(view.design.sources, [{ id: source.id, title: source.title, digest: artifactDigest(material) }]);
      assert.ok(view.design.nodeSources.every(node => node.sources.includes(source.id)));
      for (const file of design.files) assert.equal(artifactDigest(Buffer.from(await (await fetch(file.url)).arrayBuffer())), file.sha256);
      console.log(JSON.stringify({ path: 'live-project-design', provider: design.provider, model: design.model, requestId: design.requestId,
        directory: design.directory, nodes: view.graph.nodes.length, edges: view.graph.referenceEdges.length,
        unresolved: view.design.unresolved.length, source: view.design.sources[0], graphDigest: view.graph.graphDigest, layout: design.layoutSource }));
    }
    console.log(JSON.stringify({ path: 'direct', collectionId: service.collectionId, candidateHash: saved.candidateHash, directory: exported.directory }));
  });

  const pluginEnv = envFor('plugin');
  await mkdir(pluginEnv.CODEX_HOME);
  const { marketplace, selector } = await buildCodexMarketplace(root, { url: service.url });
  await codex(['plugin','marketplace','add',marketplace,'--json'], pluginEnv);
  await codex(['plugin','add',selector,'--json'], pluginEnv);
  await withAppServer(pluginEnv, async ({ flowkit, tool, call }) => {
    assert.equal(flowkit?.pluginId, selector);
    if (nativeProfessional) {
      const { data } = await call('skills/list', { cwds: [cwd], forceReload: true });
      const names = data.flatMap(page => page.skills.map(skill => skill.name));
      assert.ok(names.includes('flowkit-delivery-review'), JSON.stringify(names));
      assert.ok(names.includes('delivery-review'), JSON.stringify(names));
      console.log(JSON.stringify({ path: 'approved-native-skill-discovery', names, candidateHash: saved.candidateHash }));
      return;
    }
    const data = await tool('flowkit_collection');
    if (professional) assert.ok(data.skills.some(item => item.candidateHash === saved.candidateHash));
    else assert.deepEqual(data.skills.map(({ candidateHash }) => candidateHash), [saved.candidateHash]);
    console.log(JSON.stringify({ path: 'plugin-only', pluginId: selector, candidateHash: saved.candidateHash }));
  });
  for (const [name, badEnv] of [['wrong-token', { ...pluginEnv, FLOWKIT_MCP_TOKEN:'incorrect' }],
    ['missing-token', Object.fromEntries(Object.entries(pluginEnv).filter(([key]) => key !== 'FLOWKIT_MCP_TOKEN'))]]) {
    await withAppServer(badEnv, async ({ flowkit }) => assert.equal(flowkit, undefined));
    console.log(JSON.stringify({ path: name, rejected: true }));
  }
} finally {
  const result = await service.close();
  console.log(JSON.stringify({ temporaryTestDirectory: root, serviceClosed: result.closed }));
  assert.equal(result.closed, true);
}
