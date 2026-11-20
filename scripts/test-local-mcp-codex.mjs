import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildCodexMarketplace } from './build-codex-plugin.mjs';
import { startLocalMcp } from './run-local-mcp.mjs';
import { browserIdentity, confirmInTestBrowser, monthlyTimesheetModel } from '../tests/integrations/local-mcp-fixture.mjs';

const token = randomBytes(32).toString('hex');
const live = process.argv.includes('--live');
const goal = '起草一个 Standard 月度工时表工作流，只编排既有 Host 回调。Host 的 check-input 只读校验 employeeId、month、hours，检查 hours 是 0 到 744 的有限数字，并以布尔值返回。初检为 true 才执行 Host 的 write-copy，它生成独立副本且不改原表，并将副本引用写入 state.copyRef。随后执行 Host 的 check-copy，由此回调以布尔值校验字段、行数和工时总和。两个校验器返回 false 都走失败终点，复核为 true 才走成功终点，调用方从 Standard runArtifact 的 state.copyRef 读取结果。复核紧跟写入动作，write-copy 的普通错误通过编译器派生边直接走失败终点，控制信号继续抛出。回调内部逻辑由 Host 实现。';
const base = path.resolve('.tmp');
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, 'flowkit-codex-e2e-'));
const cwd = path.join(root, 'workspace');
await mkdir(cwd);
const service = await startLocalMcp({
  listen: { port: 0 }, dataDir: path.join(root, 'state'), exportDir: path.join(root, 'exports')
}, { credential: token, ...(live ? {} : { modelBinding: monthlyTimesheetModel() }) });

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
    }, live && method === 'mcpServer/tool/call' ? 250000 : 25000);
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
      const tool = async (name, args = {}) => {
        const out = await call('mcpServer/tool/call', { threadId: thread.id, server: flowkit.name, tool: name, arguments: args });
        assert.equal(out.isError === true, false, JSON.stringify(out));
        return JSON.parse(out.content[0].text);
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
    JSON.stringify(service.url) + '\nbearer_token_env_var = "FLOWKIT_MCP_TOKEN"\nrequired = true\n');
  let saved;
  await withAppServer(directEnv, async ({ flowkit, tool }) => {
    assert.ok(flowkit);
    assert.equal(Boolean(flowkit.pluginId), false);
    assert.equal((await tool('flowkit_collection')).collection.id, service.collectionId);
    const draft = await tool('flowkit_start_workflow', { operation: 'create', requestId: 'monthly-cli-start',
      goal });
    const candidate = await tool('flowkit_prepare_workflow', { turn: { draftId: draft.id, turnId: 'monthly-cli-plan',
      expectedStateVersion: draft.stateVersion, input: goal, target: { name: 'monthly-timesheet' } } });
    assert.equal(candidate.status, 'candidate-ready', JSON.stringify(candidate));
    assert.equal(Object.hasOwn(candidate.candidate, 'files'), false);
    const identity = { draftId: draft.id, candidateHash: candidate.candidate.candidateHash };
    assert.equal((await tool('flowkit_review_candidate', { ...identity, previousHash: candidate.previousHash })).qualified, true);
    const cookie = await browserIdentity(service);
    await confirmInTestBrowser(candidate.candidate.previewUrl, cookie);
    const exported = await tool('flowkit_export_workflow', identity);
    assert.deepEqual((await readdir(exported.directory)).sort(), ['workflow.html','workflow.js','workflow.mmd']);
    assert.match(await readFile(path.join(exported.directory, 'workflow.mmd'), 'utf8'), live ? /flowchart/ : /Verify copy/);
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
