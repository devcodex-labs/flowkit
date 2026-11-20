import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rmdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWorkflowAuthorHost } from '../dist/host.mjs';
import { createFlowkitHttpHandler } from '../src/mcp.mjs';
import { planNewCollection } from '../src/author/collections.mjs';
import { authorIdentity } from '../src/author/host-target.mjs';
import { checkCandidate } from '../src/author/standard-artifact.mjs';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { commitDelivery, deliveryNames, escapeHtml, graphPage, publicDelivery } from './local-mcp-artifacts.mjs';
import { localModel } from './local-mcp-model.mjs';

const interpreter = new URL('../website/node_modules/mermaid/dist/mermaid.min.js', import.meta.url);
const token = () => randomBytes(32).toString('base64url');
const exact = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const withheld = status => ['discarded','abandoned'].includes(status);
const capacity = { maxPhysicalExecutions: 2, maxDrafts: 128, maxDraftBytes: 8388608,
  maxRetainedDraftBytes: 67108864, maxReceiptBytes: 67108864, maxTurnsPerDraft: 128 };
const sourcePanel = [
  '<!doctype html><meta charset="UTF-8"><title>FlowKit MCP</title><h1>FlowKit MCP</h1>',
  '<p>操作员已连接。请从 Codex 打开候选预览。</p><h2>添加已有工作流</h2>',
  '<form><label>选择导出的三个文件，或可信候选 JSON<input type="file" multiple accept=".js,.mmd,.html,.json" id="files"></label>',
  '<label>Codex 插件标识（可选）<input id="codex"></label><button>生成来源引用</button></form><p aria-live="polite" id="result"></p>',
  '<script>document.querySelector("form").addEventListener("submit", async event => {',
  'event.preventDefault(); const result = document.querySelector("#result");',
  'try { const files = [...document.querySelector("#files").files]; const source = Object.create(null);',
  'if (files.reduce((size, file) => size + file.size, 0) > 8 * 1024 * 1024) throw Error("所选文件超过 8 MiB");',
  'let payload = source;',
  'if (files.length === 1 && files[0].name.endsWith(".json")) payload = JSON.parse(await files[0].text());',
  'else for (const file of files) { if (!["workflow.js","workflow.mmd","workflow.html"].includes(file.name) || Object.hasOwn(source,file.name)) throw Error("文件名不受支持或重复"); source[file.name] = await file.text(); }',
  'const response = await fetch("/sources", {method:"POST",body:new URLSearchParams({source:JSON.stringify(payload),codex:document.querySelector("#codex").value.trim()})});',
  'const data = await response.json(); if (!response.ok) throw Error(data.error); result.textContent = "来源引用 " + data.sourceRef + "，可交给 Codex 添加。";',
  '} catch(error) {result.textContent = error.message;}});</script>'
].join('\n');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function html(res, page) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}

async function readBody(req, limit) {
  const data = [];
  let size = 0;
  for await (const bytes of req) {
    size += bytes.length;
    if (size > limit) throw new Error('Request exceeds the local FlowKit byte limit');
    data.push(bytes);
  }
  return Buffer.concat(data).toString('utf8');
}

function canInstall(selector) {
  if (!/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/.test(selector ?? '')) return false;
  const result = spawnSync('codex', ['plugin', 'list', '--marketplace', selector.split('@')[1], '--available', '--json'],
    { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (result.status !== 0) return false;
  const listing = JSON.parse(result.stdout);
  return [...listing.installed, ...listing.available].some(plugin => plugin.pluginId === selector);
}

export async function startLocalMcp(config, dependencies = {}) {
  const listen = config.listen ?? {};
  const host = listen.host ?? '127.0.0.1';
  const port = listen.port ?? 8765;
  const mcpPath = listen.mcpPath ?? '/mcp';
  const namespace = config.namespace ?? 'flowkit-local';
  const workspaceId = config.workspaceId ?? namespace;
  const dataDir = path.resolve(config.dataDir ?? '.flowkit/data');
  const exportDir = path.resolve(config.exportDir ?? 'flowkit-exports');
  const credential = dependencies.credential ?? process.env[config.mcpTokenEnv ?? 'FLOWKIT_MCP_TOKEN'];
  const collectionName = config.defaultCollection ?? 'flowkit-workflows';
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !/^\/[a-z][a-z0-9-]*$/.test(mcpPath) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace) ||
      typeof credential !== 'string' || credential.length < 24) throw new Error('Configure a loopback address and a FlowKit MCP token of at least 24 characters');
  await mkdir(dataDir, { recursive: true });
  const renderer = dependencies.renderer ?? await readFile(interpreter, 'utf8');
  const rendererHash = artifactDigest(renderer);
  const data = new DatabaseSync(path.join(dataDir, 'local-mcp.sqlite'));
  data.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS local_mcp (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
  const get = key => {
    const row = data.prepare('SELECT value FROM local_mcp WHERE key=?').get(key);
    return row && JSON.parse(row.value);
  };
  const insert = (key, value) => {
    data.prepare('INSERT OR IGNORE INTO local_mcp VALUES (?, ?)').run(key, JSON.stringify(value));
    return get(key);
  };
  const put = (key, value) => data.prepare('INSERT INTO local_mcp VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
  const key = insert('signing-key', token());
  const identity = insert('service-identity', { namespace, workspaceId, collectionName });
  if (authorIdentity(identity) !== authorIdentity({ namespace, workspaceId, collectionName })) {
    data.close();
    throw new Error('Use a different data directory for a different namespace, workspace or collection');
  }
  const collectionPlan = get('collection-plan') ?? insert('collection-plan', planNewCollection({ name: collectionName }, [], () => null));
  const collectionId = collectionPlan.destination.id;
  const context = { namespace, workspaceId, principalId: 'flowkit-local-owner', sessionId: 'flowkit-local-workspace',
    authorizedCollections: [collectionId], authorizationSnapshotRef: 'flowkit-local-owner-v1' };
  const hostProfile = { id: 'flowkit-local-authoring', digest: artifactDigest('flowkit-local-authoring-v1') };
  const bootstrap = token();
  let bootstrapUsed = false;
  let origin;
  const signature = value => createHmac('sha256', key).update(value).digest('base64url');
  function seal(kind, value) {
    const payload = Buffer.from(JSON.stringify({ kind, value, until: Date.now() + (kind === 'operator' ? 86400000 : 3600000) })).toString('base64url');
    return payload + '.' + signature(payload);
  }

  function unseal(kind, ref) {
    const parts = ref?.split('.') ?? [];
    if (parts.length !== 2 || !exact(signature(parts[0]), parts[1])) return;
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (data.kind === kind && data.until > Date.now()) return data.value;
  }

  const operator = req => unseal('operator', req.headers.cookie?.match(/(?:^|;\s*)flowkit_operator=([^;]+)/)?.[1]) === workspaceId;
  const approval = ref => get('approval:' + ref);
  const storeFile = path.join(dataDir, 'author.sqlite');
  let authorHost, server, modelWorkspace;
  const closeStorage = async () => {
    data.close();
    if (modelWorkspace) await rmdir(modelWorkspace);
  };
  try {
    const provider = config.authorProvider ?? 'codex';
    if (!dependencies.modelBinding && provider === 'codex') modelWorkspace = await mkdtemp(path.join(tmpdir(), 'flowkit-local-model-'));
    const model = dependencies.modelBinding ?? localModel({ provider,
      model: process.env[config.authorModelEnv ?? 'FLOWKIT_AUTHOR_MODEL'], apiKey: process.env.OPENAI_API_KEY, workspace: modelWorkspace });
    authorHost = await createWorkflowAuthorHost({ namespace, storageFile: storeFile, collectionIds: [collectionId], hostProfile,
      defaults: { project: workspaceId, executionMode: 'standard', includeSource: false }, useNodeOptionsForNewDrafts: true, capacity,
      budgetPolicy: { durationMs: 240000, maxRequests: 8 }, execution: model.execution,
      resolveImportSource({ sourceRef }) {
        const source = get('import:' + sourceRef);
        return source && { candidate: source, sourceRef };
      },
      authorization: {
        observeReview: model.observeReview,
        authorize({ action, collectionId: target, requestContext, approvalRef, publicationId }) {
          if (target !== collectionId || authorIdentity(requestContext) !== authorIdentity(context)) return false;
          if (action === 'collection-plan') return approvalRef === bootstrap;
          if (action !== 'publish') return true;
          const record = approval(approvalRef);
          return record?.confirmed === true && record.publicationId === publicationId;
        },
        verifyApproval({ approvalRef, draftId, candidateHash, reviewRef, previousHash, contentHash }) {
          const record = approval(approvalRef);
          const approved = record?.draftId === draftId && record.candidateHash === candidateHash &&
            record.reviewRef === reviewRef && record.previousHash === previousHash && record.contentHash === contentHash;
          return { approved, subjectId: context.principalId, approvalId: approvalRef };
        },
        verifyImport({ sourceRef, sourceHash }) {
          return get('import:' + sourceRef)?.hash === sourceHash;
        }
      }
    });
    const binding = authorHost.createMcpOptions(context);
    if (!binding.store.readCollectionMetadata(collectionId)) {
      try { await binding.applyCollectionPlan(collectionPlan, bootstrap, context); }
      catch (error) { if (!binding.store.readCollectionMetadata(collectionId)) throw error; }
    }

    const readDraft = async (draftId, candidateHash, signal) => {
      const draft = await authorHost.readDraft({ draftId }, context, signal);
      if (withheld(draft.status) || draft.candidate?.hash !== candidateHash) throw new Error('候选已变更，请打开当前版本。');
      return draft;
    };
    const previewUrl = (draft, operation) => origin + '/preview/' + seal('preview',
      { draftId: draft.id, candidateHash: draft.candidate.hash, ...(operation ? { operation } : {}) });
    const publicReview = review => ({ qualified: review.receipt?.qualified === true,
      findings: review.rejection?.findings?.map(({ message, nodeIds }) => ({ message, nodeIds })) ?? [],
      ...(review.receipt?.reviewRef ? { reviewRef: review.receipt.reviewRef } : {}) });

    async function exportCandidate({ draftId, candidateHash }, _context, signal) {
      const draft = await readDraft(draftId, candidateHash, signal);
      if (draft.approvalReceipt?.candidateHash !== candidateHash || !draft.reviewReceipt?.qualified ||
          !approval(draft.approvalReceipt.approvalRef)?.confirmed) throw new Error('请先在预览页确认当前候选。');
      const receiptId = candidateHash.slice(7);
      const directory = path.join(exportDir, receiptId);
      const files = publicDelivery(draft.candidate, renderer);
      const hashes = Object.fromEntries(deliveryNames.map(name => [name, artifactDigest(files[name])]));
      const record = insert('export:' + receiptId, { draftId, candidateHash, directory, hashes, rendererHash });
      if (authorIdentity(record.hashes) !== authorIdentity(hashes) || record.directory !== directory) throw new Error('Export configuration or renderer changed for this candidate');
      await commitDelivery(exportDir, directory, files, hashes);
      put('export-source:' + authorIdentity(hashes), { draftId, candidateHash });
      for (const name of deliveryNames) insert('export-member:' + name + ':' + hashes[name], receiptId);
      const ref = seal('export', receiptId);
      return { candidateHash, directory, files: deliveryNames.map(name => ({ name, url: origin + '/exports/' + ref + '/' + name, sha256: hashes[name] })) };
    }

    const resultFor = (status, draft, extra = {}) => ({
      status, collectionId, collectionName, workflowId: draft.candidate.manifest.skillId,
      version: draft.candidate.manifest.version, candidateHash: draft.candidate.hash, ...extra
    });

    function compatible(candidate) {
      if (!candidate) return false;
      try {
        checkCandidate(candidate);
        return candidate.manifest.collectionId !== collectionId && candidate.manifest.hostProfile.digest === hostProfile.digest;
      } catch { return false; }
    }

    async function add(input, _context, signal) {
      const { requestId, sourceRef, candidateHash, destination } = input;
      const uploaded = get('upload:' + sourceRef);
      const firstParty = uploaded?.provenance ?? (!uploaded && candidateHash ? { draftId: sourceRef, candidateHash } : null);
      if (uploaded?.changed || (uploaded?.provenance && candidateHash && uploaded.provenance.candidateHash !== candidateHash)) {
        return { requestId, status: 'conflict', reason: '导出文件与 FlowKit 来源记录不符。' };
      }
      const selector = uploaded?.codexSelector;
      const external = !firstParty && uploaded?.candidate;
      async function withOptions() {
        return [
          { destination: 'flowkit', label: '加入 FlowKit', available: compatible(external) },
          { destination: 'codex', label: '直接安装', available: await (dependencies.canInstall ?? canInstall)(selector) }
        ];
      }
      if (!firstParty && !destination) return { requestId, status: 'choice_required', options: await withOptions(),
        ...(uploaded ? {} : { sourceUrl: origin + '/' }) };
      if (destination === 'codex') {
        return (await withOptions())[1].available ?
          { requestId, status: 'install_required', destination, selector, command: ['codex','plugin','add',selector] } :
          { requestId, status: 'rejected', reason: '缺少当前 Codex 可安装的外部插件包。' };
      }
      if (!firstParty && !compatible(external)) return { requestId, status: 'rejected', reason: '缺少当前 Host 可核验的兼容工作流候选。' };
      const material = authorIdentity({ sourceRef, candidateHash: candidateHash ?? null, destination: 'flowkit', collectionId });
      const operationKey = 'add:' + requestId;
      const operation = insert(operationKey, { material, publicationId: 'flowkit-local-' + artifactDigest(requestId).slice(7),
        input: { ...input, destination: 'flowkit' } });
      if (operation.material !== material) return { requestId, status: 'conflict', reason: '该请求 ID 已关联其他来源或版本。' };
      if (operation.result) return operation.result;

      let draft;
      if (firstParty) draft = await readDraft(firstParty.draftId, firstParty.candidateHash, signal);
      else {
        insert('import:' + sourceRef, external);
        const identity = authorIdentity([external.manifest.collectionId, external.manifest.skillId, collectionId]);
        let imported = await authorHost.start({ operation: 'import', collectionId, requestId: 'local-import-' + identity.slice(7) + '-' + external.hash.slice(7),
          goal: external.manifest.name, importSource: { sourceRef, mode: 'new-collection' },
          target: { skillId: 'imported-' + identity.slice(7, 39) } }, context, signal);
        if (!imported.reviewReceipt?.qualified && imported.status !== 'saved') {
          imported = await authorHost.advanceTurn({ draftId: imported.id, expectedStateVersion: imported.stateVersion,
            turnId: 'review-' + imported.candidate.hash.slice(7), input: '核对外部候选定义与来源。', kind: 'review-only',
            candidateHash: imported.candidate.hash }, context);
        }
        draft = imported;
      }
      const bound = { ...get(operationKey), draftId: draft.id, candidateHash: draft.candidate.hash };
      if (bound.result) return bound.result;
      put(operationKey, bound);
      const existing = binding.store.readVersion(collectionId, draft.candidate.manifest.skillId, draft.candidate.hash);
      if (existing) {
        const original = draft.savedReceipt?.publicationId === operation.publicationId;
        const result = resultFor(original ? 'added' : 'already_added', draft, { requestId, destination: 'flowkit',
          ...(original ? { publicationId: operation.publicationId } : {}) });
        put(operationKey, { ...bound, result });
        return result;
      }
      const approvalRef = draft.approvalReceipt?.approvalRef;
      const proof = approval(approvalRef);
      if (!draft.reviewReceipt?.qualified || proof?.publicationId !== operation.publicationId || proof.confirmed !== true) {
        return { requestId, status: 'rejected', reason: '请查看并确认将该版本加入目标集合。', confirmationUrl: previewUrl(draft, requestId) };
      }
      let receipt;
      try {
        receipt = await authorHost.publish({ draftId: draft.id, candidateHash: draft.candidate.hash, previousHash: draft.previousHash,
          expectedStateVersion: draft.stateVersion, reviewRef: draft.reviewReceipt.reviewRef, approvalRef, publicationId: operation.publicationId }, context, signal);
      } catch (error) {
        if (/conflict|UNIQUE/i.test(error.code + ' ' + error.message)) return { requestId, status: 'conflict', reason: '同一目标版本正在变更或内容冲突。' };
        throw error;
      }
      const visible = binding.store.readVersion(collectionId, draft.candidate.manifest.skillId, receipt.candidateHash);
      const result = resultFor(visible ? 'added' : 'saved_pending_discovery', draft, { requestId, destination: 'flowkit', publicationId: receipt.publicationId });
      if (visible) put(operationKey, { ...bound, result });
      return result;
    }

    const mcp = createFlowkitHttpHandler(req => exact(req.headers.authorization, 'Bearer ' + credential) ?
      { ...binding, workflowUi: { defaultCollectionId: collectionId, review: publicReview, export: exportCandidate, add,
        present: draft => ({ id: draft.id, draftId: draft.id, stateVersion: draft.stateVersion, status: draft.status,
          collectionId: draft.collectionId, previousHash: draft.previousHash, questions: draft.questions,
          planHash: draft.plan?.planHash,
          diagnostics: draft.diagnostics?.map(({ code, message }) => ({ code, message })),
          review: publicReview({ receipt: draft.reviewReceipt, rejection: draft.reviewRejection }),
          ...(draft.plan?.planHash ? { planHash: draft.plan.planHash } : {}),
          ...(draft.candidate ? { candidate: { name: draft.candidate.manifest.name, version: draft.candidate.manifest.version,
            candidateHash: draft.candidate.hash, previewUrl: previewUrl(draft),
            requiredCapabilities: draft.candidate.manifest.workflowDefinition?.nodes?.flatMap(node => [node.action ?? node.verifier].filter(Boolean)) } } : {}) })
      } } : null);

    async function web(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
        return json(res, 403, { error: 'Only the configured loopback origin is allowed' });
      }
      const url = new URL(req.url, origin);
      if (url.pathname === mcpPath) return mcp(req, res);
      const [, route, ref, action] = url.pathname.split('/');
      if (route === 'operator' && req.method === 'GET' && !bootstrapUsed && exact(ref, bootstrap)) {
        bootstrapUsed = true;
        res.writeHead(303, { Location: '/', 'Set-Cookie': 'flowkit_operator=' + seal('operator', workspaceId) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' });
        return res.end();
      }
      if (url.pathname === '/' && req.method === 'GET' && operator(req)) {
        return html(res, sourcePanel);
      }
      if (route === 'sources' && req.method === 'POST' && operator(req) && req.headers.origin === origin) {
        const form = new URLSearchParams(await readBody(req, 16 * 1024 * 1024));
        const source = JSON.parse(form.get('source'));
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('来源必须是工作流文件对象或可信候选。');
        const hashes = Object.fromEntries(deliveryNames.filter(name => typeof source[name] === 'string')
          .map(name => [name, artifactDigest(source[name])]));
        const provenance = deliveryNames.every(name => Object.hasOwn(hashes,name)) && get('export-source:' + authorIdentity(hashes));
        const changed = !provenance && Object.keys(hashes).length > 0 && Object.keys(hashes).some(name =>
          Boolean(get('export-member:' + name + ':' + hashes[name])));
        const sourceRef = randomUUID();
        insert('upload:' + sourceRef, { candidate: compatible(source) ? source : null, provenance, changed, codexSelector: form.get('codex') });
        return json(res, 200, { sourceRef });
      }
      if (route === 'exports' && req.method === 'GET' && deliveryNames.includes(action)) {
        const id = unseal('export', ref);
        const entry = id && get('export:' + id);
        if (!entry) return json(res, 403, { error: 'Invalid export link' });
        const contents = await readFile(path.join(entry.directory, action));
        if (artifactDigest(contents) !== entry.hashes[action]) return json(res, 409, { error: 'Export file changed' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + action + '"' });
        return res.end(contents);
      }
      const preview = route === 'preview' && unseal('preview', ref);
      if (preview) {
        const draft = await readDraft(preview.draftId, preview.candidateHash);
        const label = draft.candidate.manifest.name + ' ' + draft.candidate.manifest.version;
        if (req.method === 'GET' && !action) {
          const challenge = seal('confirm', { ...preview, stateVersion: draft.stateVersion });
          const current = operator(req);
          const controls = draft.reviewReceipt?.qualified && current ?
            '<form method="post" action="/preview/' + ref + '/confirm"><input type="hidden" name="challenge" value="' + challenge +
            '"><button type="submit" disabled>' + (preview.operation ? '确认并加入 FlowKit' : '确认这个候选') + '</button></form>' :
            '<p>' + (current ? '候选需要通过复审。' : '请用本机启动信息建立操作员会话后刷新。') + '</p>';
          return html(res, graphPage({ title: label, source: draft.candidate.files['workflow.mmd'], renderer, controls }));
        }
        if (req.method === 'POST' && action === 'confirm' && operator(req) && req.headers.origin === origin) {
          const challenge = unseal('confirm', new URLSearchParams(await readBody(req, 8192)).get('challenge'));
          if (!challenge || challenge.draftId !== draft.id || challenge.candidateHash !== draft.candidate.hash ||
              challenge.stateVersion !== draft.stateVersion || challenge.operation !== preview.operation || !draft.reviewReceipt?.qualified) {
            return json(res, 409, { error: '候选已变更或未通过复审，请刷新。' });
          }
          const operation = preview.operation && get('add:' + preview.operation);
          if (preview.operation && (!operation || operation.draftId !== draft.id || operation.candidateHash !== draft.candidate.hash)) {
            return json(res, 409, { error: '添加请求已变更。' });
          }
          const approvalRef = randomUUID();
          const record = { draftId: draft.id, candidateHash: draft.candidate.hash, previousHash: draft.previousHash,
            contentHash: draft.contentHash, reviewRef: draft.reviewReceipt.reviewRef, publicationId: operation?.publicationId };
          insert('approval:' + approvalRef, record);
          await authorHost.recordApproval({ ...record, approvalRef, expectedStateVersion: draft.stateVersion }, context);
          put('approval:' + approvalRef, { ...record, confirmed: true });
          if (operation) {
            const result = await add(operation.input, context);
            if (!req.headers.accept?.includes('text/html')) return json(res, 200, result);
            const message = ({
              added: '已加入 FlowKit',
              already_added: '此版本已在 FlowKit 集合中',
              saved_pending_discovery: '已保存，等待集合发现'
            })[result.status] ?? result.reason ?? '请在 Codex 读取添加结果';
            return html(res, '<!doctype html><meta charset="UTF-8"><title>添加工作流</title><h1>' +
              escapeHtml(message) + '</h1><p>' + escapeHtml(label) + '</p>');
          }
          return html(res, '<!doctype html><meta charset="UTF-8"><title>已确认</title><h1>已确认 ' + escapeHtml(label) + '</h1><p>可在 Codex 请求导出或添加。</p>');
        }
      }
      return json(res, 404, { error: 'FlowKit endpoint not found' });
    }
    server = createServer((req,res) => web(req,res).catch(error => {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.end();
    }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    origin = 'http://' + host + ':' + server.address().port;

    return {
      url: origin + mcpPath, collectionId, operatorUrl: origin + '/operator/' + bootstrap,
      async close() {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        try { return await authorHost.close({ mode: 'cancel' }); }
        finally { await closeStorage(); }
      }
    };
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { if (authorHost) await authorHost.close({ mode: 'cancel' }); }
    finally { await closeStorage(); }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Usage: npm run mcp:local -- --config <file>');
    const config = JSON.parse(await readFile(path.resolve(process.argv[3]), 'utf8'));
    const service = await startLocalMcp(config);
    process.stdout.write(JSON.stringify({ url: service.url, collectionId: service.collectionId, operatorUrl: service.operatorUrl }) + '\n');
    const stop = async () => {
      try { if (!(await service.close()).closed) process.exitCode = 1; }
      catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
