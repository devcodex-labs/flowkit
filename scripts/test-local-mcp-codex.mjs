import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildCodexMarketplace } from './build-codex-plugin.mjs';
import { startLocalMcp } from './run-local-mcp.mjs';
import { deliveryNames, exportTrust, newExportKey, publicDelivery, readPortableExport } from './local-mcp-artifacts.mjs';
import { readWorkflowPageData } from './workflow-viewer.mjs';
import { browserIdentity, confirmInTestBrowser, monthlyTimesheetModel } from '../tests/integrations/local-mcp-fixture.mjs';
import { createInteractiveHostContext, createSqliteInteractivePersistence, loadInteractiveProgram,
  start, complete } from '@devcodex-labs/flowkit/interactive';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { canonicalBytes } from '../src/interactive/canonical.mjs';
import { checkCandidate, prepareStandardSkill } from '../src/author/standard-artifact.mjs';
import { authorContractCases, verifyAuthorContractExport } from './test-author-contract-cases.mjs';

const token = randomBytes(32).toString('hex');
const live = process.argv.includes('--live');
const interactive=process.argv.includes('--interactive');
const readOnly = process.argv.includes('--p0b');
const fixtureIndex = process.argv.indexOf('--layout-fixture');
const fixtureDirectory = fixtureIndex < 0 ? null : process.argv[fixtureIndex + 1];
const layoutValidation = process.argv.includes('--verify-model-layout');
const openai = process.argv.includes('--openai');
const referenceMode = process.argv.includes('--reference') || !!fixtureDirectory;
const specIndex = process.argv.indexOf('--v45-spec');
const v45Spec = specIndex !== -1;
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
if (fixtureIndex >= 0 && !fixtureDirectory || layoutValidation && (!live || !referenceMode) || openai && !layoutValidation) {
  throw new Error('Use --live --verify-model-layout --reference or --layout-fixture <signed export directory>, with optional --openai');
}
const importedFiles = fixtureDirectory && Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
  [name, await readFile(path.join(fixtureDirectory, name), 'utf8')])));
const sourceKey = referenceMode ? importedFiles ? JSON.parse(importedFiles['workflow.html']
  .match(/<script type="application\/json" id="flowkit-export-provenance">([^<]+)<\/script>/)[1]) : newExportKey() : null;
if (readOnly && (!live || interactive)) throw new Error('Use --live --p0b for the Interactive read-only Action scenario');
const goal = v45Spec ? '按完整的 V4.5 软件开发交付业务规格，起草可由独立宿主运行的 Interactive P2 工作流。' :
  contractCase ? contractCase.goal : readOnly ?
  '起草 Interactive P0-B 工单校验工作流。Host 提供既有的只读 Action read-ticket，将读取结果写入工作流状态 state.ticket；后继是独立的布尔 Verification check-ticket，返回 true 到成功终点，false 到失败终点。read-ticket 普通业务失败也走失败终点。只编排这两个回调，不增加外部写入。' : interactive ?
  '起草一个 Interactive P2 月度工时表校验工作流。外层并行必须全部通过，一个分支校验输入，另一分支在复核副本与复核原表之间选首个成功。Host 提供三个既有的只读布尔校验器 check-input、check-copy 和 check-original，分别对应输入、副本和原表。输入不通过时整体失败；任一复核通过即可继续，两个复核均不通过时整体失败。流程只编排这三个校验器。' :
  '起草一个 Standard 月度工时表工作流，只编排既有 Host 回调。Host 的 check-input 只读校验 employeeId、month、hours，检查 hours 是 0 到 744 的有限数字，并以布尔值返回。初检为 true 才执行 Host 的 write-copy，它生成独立副本且不改原表，并将副本引用写入 state.copyRef。随后执行 Host 的 check-copy，由此回调以布尔值校验字段、行数和工时总和。两个校验器返回 false 都走失败终点，复核为 true 才走成功终点，调用方从 Standard runArtifact 的 state.copyRef 读取结果。复核紧跟写入动作，write-copy 的普通错误通过编译器派生边直接走失败终点，控制信号继续抛出。回调内部逻辑由 Host 实现。';
const base = path.resolve('.tmp');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'flowkit-codex-e2e-'));
const cwd = path.join(root, 'workspace');
await mkdir(cwd);
const service = await startLocalMcp({
  listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports'),
  ...(v45Spec || layoutValidation ? { authorTaskTimeoutMs: 150000, authorTurnDurationMs: 660000 } : {}),
  ...(openai ? { authorProvider: 'openai' } : {}),
  ...(sourceKey ? { trustedExportKeys: [sourceKey.publicKey] } : {}),
}, { credential: token, ...(live ? {} : { modelBinding: monthlyTimesheetModel({interactive}) }) });

async function testReferenceDelivery(tool) {
  const { candidate } = importedFiles ? readPortableExport(importedFiles, exportTrust([sourceKey.publicKey])) : await prepareStandardSkill({
    file: 'examples/v45/software-delivery.workflow.js', collectionId: 'v45-reference', skillId: 'software-delivery',
    name: 'software-delivery', description: 'V4.5 software delivery reference', version: '1.0.0',
    hostProfile: { id: 'flowkit-local-authoring', digest: artifactDigest('flowkit-local-authoring-v1') },
    buildId: 'v45-reference', executionMode: 'interactive-p2',
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
  const preview = readWorkflowPageData(await (await fetch(waiting.confirmationUrl, { headers: { cookie } })).text());
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
      if (sourceGraph.nodes.length > 60) assert.ok(layout.receipts.some(r => r.task === 'partition' && r.accepted));
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
  console.log(JSON.stringify({ path: layoutValidation ? (openai ? 'layout-openai-mcp' : 'layout-codex-mcp') : 'v45-codex-mcp',
    candidateHash, directory: exported.directory,
    graphDigest: offline.graph.graphDigest, artifactHash: offline.graph.artifactHash, staleCandidateRejected: true, layoutProof }));
  return saved;
}

async function runExport(directory) {
  const bytes=await readFile(path.join(directory,'workflow.js'));
  const artifactHash=artifactDigest(bytes);
  const program=await loadInteractiveProgram(bytes,artifactHash);
  const stage = readOnly ? 'P0-B' : 'P2';
  assert.equal(program.interactiveProgram.identity.implementedStage, stage);
  const namespace='cli-export';
  const persistence=createSqliteInteractivePersistence(path.join(root,'run.sqlite'),{namespace});
  const auth=createInteractiveHostContext({namespace,subjectId:'fixture',authorize:()=>true,authorizeTask:()=>true});
  const options={...persistence,auth,policy:{id:'cli-export',version:'1',
    canonicalizationVersion:'jcs-rfc8785-v1',capabilityStage:stage,disclosePolicyId:'test',bindingManifest:{}}};
  try {
    const reference=await persistence.programRegistry.putImmutable(bytes,{...program.interactiveProgram.identity,artifactHash});
    if (readOnly) {
      const outcomes = {};
      for (const passed of [true, false]) {
        const startKey = passed ? 'check-passed' : 'check-rejected';
        const runOptions = { ...options, startKey };
        let frame = await start(reference, {}, {}, runOptions);
        const [read] = frame.pending;
        assert.equal(read.task.action, 'read-ticket');
        const { operationKey } = read.task;
        const inputHash = artifactDigest(canonicalBytes(read.task));
        const claim = { runId: frame.runId, requestId: read.requestId, operationKey, inputHash };
        assert.equal((await persistence.operationController.claim(claim, auth)).readOnly, true);
        const result = { set: { ticket: { id: 'test-ticket' } } };
        await persistence.operationController.settle({ runId: frame.runId, operationKey, inputHash,
          effect: 'no-effect', evidenceHash: artifactDigest(startKey), result }, auth);
        frame = await complete({ runId: frame.runId, requestId: read.requestId, operationKey,
          kind: 'action', outcome: 'succeeded', result }, {}, runOptions);
        const [verification] = frame.pending;
        assert.equal(verification.task.verifier, 'check-ticket');
        frame = await complete({ runId: frame.runId, requestId: verification.requestId, kind: 'verification',
          outcome: 'succeeded', result: { passed } }, {}, runOptions);
        assert.equal(frame.status, passed ? 'succeeded' : 'failed');
        outcomes[startKey] = frame.status;
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
    }, live && method === 'mcpServer/tool/call' ? (v45Spec ? 700000 : 250000) : 25000);
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
      const flowkit = data.find(item => Object.hasOwn(item.tools ?? {}, 'flowkit_collection'));
      const tool = async (name, args = {}, expectError = false) => {
        const out = await call('mcpServer/tool/call', { threadId: thread.id, server: flowkit.name, tool: name, arguments: args });
        assert.equal(out.isError === true, expectError, JSON.stringify(out));
        if (!expectError) return JSON.parse(out.content[0].text);
      };
      await test({ data, flowkit, tool });
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
    (v45Spec || layoutValidation ? 'tool_timeout_sec = 690\n' : ''));
  let saved;
  await withAppServer(directEnv, async ({ flowkit, tool }) => {
    assert.ok(flowkit);
    assert.equal(Boolean(flowkit.pluginId), false);
    assert.equal((await tool('flowkit_collection')).collection.id, service.collectionId);
    if (referenceMode) {
      saved = await testReferenceDelivery(tool);
      return;
    }
    const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'cli-start',
      goal, ...(readOnly ? { executionMode: 'interactive-p0-b' } : interactive || contractCase || v45Spec ? { executionMode: 'interactive-p2' } : {}) });
    const candidate = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'cli-plan',
      expectedStateVersion: draft.stateVersion, input: v45Input ?? goal,
      target: { name: v45Spec ? 'v45-software-delivery' : contractCase?.name ?? (readOnly ? 'ticket-review' : 'monthly-timesheet') } } });
    assert.equal(candidate.status, 'candidate-ready', JSON.stringify(candidate));
    assert.equal(Object.hasOwn(candidate.candidate, 'files'), false);
    const identity = { draftId: draft.id, candidateHash: candidate.candidate.candidateHash };
    assert.equal((await tool('flowkit_review_candidate', { ...identity, previousHash: candidate.previousHash })).qualified, true);
    await tool('flowkit_export_workflow', identity, true);
    const cookie = await browserIdentity(service);
    const preview = readWorkflowPageData(await (await fetch(candidate.candidate.previewUrl, { headers: { cookie } })).text());
    assert.equal(preview.candidateHash, identity.candidateHash);
    assert.equal((await confirmInTestBrowser(candidate.candidate.previewUrl, cookie)).status, 200);
    await tool('flowkit_export_workflow', {...identity, candidateHash: 'sha256:' + '0'.repeat(64)}, true);
    const exported = await tool('flowkit_export_workflow', identity);
    assert.deepEqual((await readdir(exported.directory)).sort(), ['workflow.html','workflow.js','workflow.mmd']);
    assert.match(await readFile(path.join(exported.directory, 'workflow.mmd'), 'utf8'),
      live ? /flowchart/ : interactive ? /Review alternatives/ : /Verify copy/);
    const offline = readWorkflowPageData(await readFile(path.join(exported.directory, 'workflow.html'), 'utf8'));
    assert.equal(offline.candidateHash, identity.candidateHash);
    assert.deepEqual(offline, preview);
    assert.equal(offline.graph.artifactHash, artifactDigest(await readFile(path.join(exported.directory, 'workflow.js'))));
    if (v45Spec) {
      assert.equal(offline.graph.nodes.length, 140);
      const db = new DatabaseSync(path.join(root, 'state', 'local-mcp.sqlite'), { readOnly: true });
      let publicKey;
      try { publicKey = JSON.parse(db.prepare('SELECT value FROM local_mcp WHERE key=?').get('export-key-v1').value).publicKey; }
      finally { db.close(); }
      const files = Object.fromEntries(await Promise.all(deliveryNames.map(async name =>
        [name, await readFile(path.join(exported.directory, name), 'utf8')])));
      assert.equal(readPortableExport(files, exportTrust([publicKey])).candidate.hash, identity.candidateHash);
      await writeFile(path.join(root, 'export-public-key.txt'), publicKey + '\n');
      console.log(JSON.stringify({ path: 'real-v45-author', ...identity, directory: exported.directory, nodes: offline.graph.nodes.length,
        graphDigest: offline.graph.graphDigest, artifactHash: offline.graph.artifactHash, sourceSpecHash: artifactDigest(v45Input),
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
    console.log(JSON.stringify({ path: 'direct', collectionId: service.collectionId, candidateHash: saved.candidateHash, directory: exported.directory }));
  });

  const pluginEnv = envFor('plugin');
  await mkdir(pluginEnv.CODEX_HOME);
  const { marketplace, selector } = await buildCodexMarketplace(root, { url: service.url });
  await codex(['plugin','marketplace','add',marketplace,'--json'], pluginEnv);
  await codex(['plugin','add',selector,'--json'], pluginEnv);
  await withAppServer(pluginEnv, async ({ flowkit, tool }) => {
    assert.equal(flowkit?.pluginId, selector);
    const data = await tool('flowkit_collection');
    assert.deepEqual(data.skills.map(({ candidateHash }) => candidateHash), [saved.candidateHash]);
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
