import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rmdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createWorkflowAuthorHost } from '../dist/host.mjs';
import { checkProfessionalSkill, planProfessionalSkills, resolveTrustedProfessionalPin } from '../src/author/professional-skills.mjs';
import { collectDesignSections, mergeDesignSections, packDesignScope, planDesignCanvas, projectDesignLayoutGraph } from './workflow-viewer/project-design.mjs';
import { createFlowkitHttpHandler } from '../src/mcp.mjs';
import { planNewCollection } from '../src/author/collections.mjs';
import { authorIdentity, isNewerWorkflowVersion, sameSignedWorkflowOrigin } from '../src/author/host-target.mjs';
import { checkCandidate, rebindImportedCandidate } from '../src/author/standard-artifact.mjs';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { canExportPortable, commitDelivery, deliveryMatches, deliveryNames, escapeHtml, exportTrust, newExportKey, publicDelivery,
  readPortableExport } from './local-mcp-artifacts.mjs';
import { localModel } from './local-mcp-model.mjs';
import { defaultLayout, viewerHash, workflowPage, workflowRunArtifacts, workflowRunPage, workflowRunProgress, workflowTracePage } from './workflow-viewer.mjs';
import { listInteractiveForkPoints } from '../src/interactive/index.mjs';
import { generateLayout, layoutContractHash } from './workflow-viewer/auto-layout.mjs';

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

function acquireServiceLease(dataDir) {
  const lease = new DatabaseSync(path.join(dataDir, 'service-lock.sqlite'));
  try { lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch (cause) {
    lease.close();
    throw new Error('FlowKit 数据目录已被其他本机 MCP 服务占用，或无法获取写锁。', { cause });
  }
  let released = false;
  return () => {
    if (!released) { released = true; lease.close(); }
  };
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
  const authorTimeouts = [config.authorTaskTimeoutMs, config.authorTurnDurationMs];
  if (authorTimeouts.some(value => value !== undefined && (!Number.isInteger(value) || value < 1 || value > 2147483647))) {
    throw new TypeError('Author task and turn timeouts must be positive integer milliseconds within the timer range');
  }
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535 ||
      !/^\/[a-z][a-z0-9-]*$/.test(mcpPath) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace) ||
      typeof credential !== 'string' || credential.length < 24) throw new Error('Configure a loopback address and a FlowKit MCP token of at least 24 characters');
  await mkdir(dataDir, { recursive: true });
  const trustedExports = exportTrust(config.trustedExportKeys);
  const releaseLease = acquireServiceLease(dataDir);
  try {
    return await bindLocalMcp({ config, dependencies, host, port, mcpPath, namespace, workspaceId, dataDir,
      exportDir, credential, collectionName, releaseLease, trustedExports });
  } catch (error) {
    releaseLease();
    throw error;
  }
}

async function bindLocalMcp({ config, dependencies, host, port, mcpPath, namespace, workspaceId, dataDir,
  exportDir, credential, collectionName, releaseLease, trustedExports }) {
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
  const operatorCookie = 'flowkit_operator_' + artifactDigest(collectionId).slice(7, 31);
  const operatorCookiePattern = new RegExp('(?:^|;\\s*)' + operatorCookie + '=([^;]+)');
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

  const operator = req => unseal('operator', req.headers.cookie?.match(operatorCookiePattern)?.[1]) === workspaceId;
  const approval = ref => get('approval:' + ref);
  const sourceIssuer = source => source.exporterKey === null ? undefined : artifactDigest(source.exporterKey);
  function trustedImport(sourceRef) {
    const source = get('import:' + sourceRef);
    if (!source?.candidate || source.exporterKey !== null && !trustedExports.has(source.exporterKey)) return undefined;
    return source;
  }
  function trustedDraft(draft) {
    if (draft.operation !== 'import') return true;
    const source = trustedImport(draft.plan?.importSource?.sourceRef);
    const imported = draft.candidate?.manifest.importedFrom;
    return !!source && source.candidate.hash === imported?.hash && sourceIssuer(source) === imported.issuer;
  }
  const untrustedReason = '接收实例尚未信任或无法核对该导出公钥。请核对公钥后重新登记文件。';
  const storeFile = path.join(dataDir, 'author.sqlite');
  let authorHost, server, modelWorkspace;
  let storageClosed = false;
  const recoveryProofs = new Map();
  const layoutAbort = new AbortController();
  const layoutRequests = new Map();
  const designRequests = new Map();
  const designFailures = new Map();
  const legacyDesignNames = ['design.html', 'design.mmd'];
  const designNames = result => result.format === 2 ? ['design.html'] : legacyDesignNames;
  const designOwner = context => authorIdentity([context.principalId, context.workspaceId, collectionId]);
  const closeStorage = async () => {
    if (storageClosed) return;
    storageClosed = true;
    try {
      data.close();
      if (modelWorkspace) await rmdir(modelWorkspace);
    } finally { releaseLease(); }
  };
  try {
    const exportKey = get('export-key-v1') ?? insert('export-key-v1', newExportKey());
    const provider = config.authorProvider ?? 'codex';
    if (!dependencies.modelBinding && provider === 'codex') modelWorkspace = await mkdtemp(path.join(tmpdir(), 'flowkit-local-model-'));
    const model = dependencies.modelBinding ?? localModel({ provider, timeoutMs: config.authorTaskTimeoutMs,
      model: process.env[config.authorModelEnv ?? 'FLOWKIT_AUTHOR_MODEL'], apiKey: process.env.OPENAI_API_KEY, workspace: modelWorkspace });
    const modelLayoutCalls = new Set();
    async function planLayout(input) {
      while (modelLayoutCalls.size >= capacity.maxPhysicalExecutions) await Promise.race(modelLayoutCalls);
      input.signal.throwIfAborted();
      const request = Promise.resolve().then(() => model.planLayout(input));
      const settled = request.then(() => undefined, () => undefined);
      modelLayoutCalls.add(settled);
      try { return await request; }
      finally { modelLayoutCalls.delete(settled); }
    }
    const selectedLayoutKey = hash => 'preview-layout-selection:' + viewerHash + ':' + hash;
    const baseLayoutRevision = hash => artifactDigest(JSON.stringify(['layout-initial', viewerHash, hash]));
    const layoutRevisionOf = hash => get(selectedLayoutKey(hash))?.revision ?? baseLayoutRevision(hash);
    function selectedLayout(hash) {
      const selected = get(selectedLayoutKey(hash));
      return selected?.source === 'model' ? get(selected.key)?.layout : undefined;
    }
    const materialError = (code, message) => Object.assign(new Error(message), { code });
    async function resolveSources(sources, requestContext, signal, allowDesign = true) {
      const materials = [], designs = [];
      for (const source of sources) {
        signal?.throwIfAborted();
        if (source.kind === 'text') {
          const { id, title, content } = source;
          materials.push({ id, title, content });
        } else if (source.kind === 'material') {
          const value = await dependencies.readAuthoringMaterial?.({ id: source.id, sha256: source.sha256, collectionId, requestContext, signal });
          if (value?.authorized !== true || value.id !== source.id || typeof value.title !== 'string' ||
              !value.title.trim() || value.title.length > 160 || typeof value.content !== 'string' ||
              !value.content.length || allowDesign && Buffer.byteLength(value.content) > 262144) {
            throw materialError('FKA_MATERIAL_UNAVAILABLE', 'The Host could not authorize the selected material: ' + source.id);
          }
          if (artifactDigest(value.content) !== source.sha256) {
            throw materialError('FKA_MATERIAL_CHANGED', 'The selected material version changed: ' + source.id);
          }
          materials.push({ id: value.id, title: value.title, content: value.content });
        } else {
          if (!allowDesign) throw materialError('FKA_MATERIAL_UNAVAILABLE', 'A design must select its original text or Host material references');
          const key = unseal('design', source.ref);
          const record = key && get(key);
          const result = record?.result;
          if (result?.designHash !== source.sha256 || !record?.selection || !record.summary ||
              record.owner && record.owner !== designOwner(requestContext) ||
              !(await deliveryMatches(result.directory, result.hashes, designNames(result)))) {
            throw materialError('FKA_MATERIAL_UNAVAILABLE', 'The selected design version is unavailable or differs from the delivered version');
          }
          const selected = source.groupId ? await resolveDesignGroup(record, source.groupId, requestContext, signal) :
            { materials: await resolveDesignMaterials(record, requestContext, signal), summary: record.summary };
          materials.push(...selected.materials);
          designs.push({ sha256: result.designHash, ...(source.groupId ? { groupId: source.groupId } : {}),
            summary: selected.summary });
        }
      }
      if (new Set(materials.map(item => item.id)).size !== materials.length ||
          allowDesign && (materials.length > 6 || Buffer.byteLength(JSON.stringify([materials, designs])) > 262144)) {
        throw materialError('FKA_MATERIAL_LIMIT', 'Choose up to six unique materials within the Author input budget');
      }
      return { materials, designs };
    }

    async function resolveDesignMaterials(record, requestContext, signal) {
      const { materials } = await resolveSources(record.selection, requestContext, signal, false);
      if (artifactDigest(JSON.stringify([record.title, materials])) !== record.materialHash) {
        throw materialError('FKA_MATERIAL_CHANGED', 'The selected design material no longer matches its reviewed version');
      }
      return materials;
    }

    function designEvidence(source, material, range) {
      const bytes=Buffer.from(material.content);
      if (artifactDigest(bytes)!==source.digest) throw materialError('FKA_MATERIAL_CHANGED','Design evidence source changed');
      const selection=range?bytes.subarray(range.start,range.end):bytes;
      if (range && (range.start<0 || range.end>bytes.length || range.start>=range.end ||
        artifactDigest(selection)!==range.digest)) throw materialError('FKA_MATERIAL_CHANGED','Design evidence range changed');
      if (selection.length>256*1024) return null;
      const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(selection);
      const lines=range?{
        first:bytes.subarray(0,range.start).reduce((line,byte)=>line+(byte===10),1),
        count:text.replace(/\n$/,'').split('\n').length
      }:undefined;
      return { text, ...(lines?{lines}:{}), mimeType:/\.(?:md|markdown)$/i.test(source.title)?'text/markdown':'text/plain' };
    }

    const approveExcerpt = (source, range, requestContext, signal) =>
      dependencies.authorizeDesignExcerptExport?.({sourceId:source.id,sourceDigest:source.digest,
        rangeId:range.id,rangeDigest:range.digest,start:range.start,end:range.end,collectionId,requestContext,signal});

    async function designExportExcerpts(design, materials, requestContext, signal) {
      if (typeof dependencies.authorizeDesignExcerptExport!=='function') return [];
      const sources=new Map(design.sources.map(source=>[source.id,source]));
      const byId=new Map(materials.map(material=>[material.id,material]));
      const excerpts=[];
      let total=0;
      for (const range of design.ranges??[]) {
        signal.throwIfAborted();
        const size=range.end-range.start;
        if(total+size>256*1024)continue;
        const source=sources.get(range.sourceId);
        if(await approveExcerpt(source,range,requestContext,signal)!==true)continue;
        const evidence=designEvidence(source,byId.get(source.id),range);
        if(evidence) {
          total+=size;
          excerpts.push({rangeId:range.id,...evidence});
        }
      }
      return excerpts;
    }

    async function resolveDesignGroup(record, groupId, requestContext, signal) {
      const group = record.summary.groups?.find(item => item.id === groupId);
      if (!group) throw materialError('FKA_MATERIAL_UNAVAILABLE', 'Unknown section in the selected design version');
      const selected = new Set(group.ranges.map(range => range.sourceId));
      const pinned = new Map(record.summary.sources.map(source => [source.id, source]));
      const { materials } = await resolveSources(record.selection.filter(source => selected.has(source.id)), requestContext, signal, false);
      const byId = new Map(materials.map(material => {
        if (pinned.get(material.id)?.digest !== artifactDigest(material.content)) {
          throw materialError('FKA_MATERIAL_CHANGED', 'The selected design material no longer matches its reviewed version');
        }
        return [material.id, material];
      }));
      const slices = group.ranges.map(({ id, sourceId, start, end, digest }) => {
        const material = byId.get(sourceId);
        if (!material) throw materialError('FKA_MATERIAL_UNAVAILABLE', 'The selected design section is unavailable');
        const content = Buffer.from(material.content).subarray(start, end).toString('utf8');
        if (artifactDigest(content) !== digest) throw materialError('FKA_MATERIAL_CHANGED', 'The selected section changed');
        return { id, title: material.title, content };
      });
      const nodeIds = new Set(group.nodeIds);
      return { materials: slices, summary: { sources: [...selected].map(id => pinned.get(id)),
        nodeSources: record.summary.nodeSources.filter(node => nodeIds.has(node.id)),
        groups: [group], unresolved: group.unresolved ?? [] } };
    }

    async function authoringMaterials({ input, sources, draft }, requestContext, signal) {
      const key = 'authoring-materials:' + draft.id;
      const previous = get(key);
      const selected = sources ?? previous;
      if (!selected) return input;
      if (previous && authorIdentity(selected) !== authorIdentity(previous)) {
        throw materialError('FKA_MATERIAL_CHANGED', 'Choose a new draft to replace its exact material selection');
      }
      const snapshot = await resolveSources(selected, requestContext, signal);
      if (!previous) {
        if (input.expectedStateVersion !== draft.stateVersion) throw new Error('The draft state version changed');
        const saved = insert(key, selected);
        if (authorIdentity(saved) !== authorIdentity(selected)) throw materialError('FKA_MATERIAL_CHANGED', 'The draft already has another material selection');
      }
      return { ...input, contextSnapshot: { hostContext: input.contextSnapshot ?? null, ...snapshot } };
    }

    async function reauthorizeDraftSources(draftId, requestContext, signal) {
      const selected = get('authoring-materials:' + draftId);
      if (selected) await resolveSources(selected, requestContext, signal);
    }

    async function createDesign({ requestId, title, materials, sources }, requestContext, signal) {
      const selection = sources ?? materials.map(item => ({ kind: 'text', ...item }));
      materials = (await resolveSources(selection, requestContext, signal, false)).materials;
      const materialHash = artifactDigest(JSON.stringify([title, materials]));
      const key = 'design:' + artifactDigest(requestId).slice(7);
      const owner = designOwner(requestContext);
      const identity = authorIdentity([provider, process.env[config.authorModelEnv ?? 'FLOWKIT_AUTHOR_MODEL'] ?? null]);
      const record = insert(key, { materialHash, title, selection, owner, identity });
      if (record.materialHash !== materialHash || record.owner && record.owner !== owner ||
          !record.result && record.identity && record.identity !== identity ||
          record.selection && authorIdentity(record.selection) !== authorIdentity(selection)) {
        throw new Error('Design request ID already belongs to different source material');
      }
      const result = record.result;
      if (!result) {
        if (!designRequests.has(key)) {
          const failure = designFailures.get(key);
          if (failure) {
            designFailures.delete(key);
            throw failure;
          }
          if (designRequests.size >= capacity.maxPhysicalExecutions) throw new Error('Design Author capacity is busy');
          const durationMs = config.authorTurnDurationMs ?? 240_000;
          const expiresAt = performance.now() + durationMs;
          const deadline = AbortSignal.timeout(durationMs);
          const workSignal = AbortSignal.any([deadline, layoutAbort.signal]);
          const pending = Promise.resolve().then(async () => {
            let prepared = get(key).prepared;
            if (!prepared) {
              const original = new Map(materials.map(material => [material.id, artifactDigest(material.content)]));
              const sections = await collectDesignSections({ title, materials, signal: workSignal,
                modelIdentity: identity, plan: input => model.planDesign(input),
                load: section => get(key + ':' + section),
                save: (section, receipt) => put(key + ':' + section, receipt),
                async authorize(ids) {
                  const needed = new Set(ids);
                  const { materials: fresh } = await resolveSources(selection.filter(source => needed.has(source.id)), requestContext, workSignal, false);
                  if (fresh.length !== needed.size || fresh.some(item => artifactDigest(item.content) !== original.get(item.id))) {
                    throw materialError('FKA_MATERIAL_CHANGED', 'The selected design section has changed');
                  }
                } });
              const merged = mergeDesignSections(title, materials, sections);
              const { graph, design, mermaid, viewManifest } = merged;
              const canvas = planDesignCanvas(graph, design);
              function arrange(graph, ceiling) {
                const layoutMs = Math.max(0, Math.min(ceiling, Math.floor((expiresAt - performance.now()) / 2)));
                if (layoutMs && model.planLayout) {
                  return arrangeDesign(graph, AbortSignal.any([workSignal, AbortSignal.timeout(layoutMs)]));
                }
              }
              let project, viewLayout, layoutSource = 'fallback';
              if (canvas) {
                const { layoutGraphs, ...structure } = canvas;
                const positions = [];
                let arranged = 0, modelScopes = 0;
                for (const { id, graph: rawScope } of layoutGraphs) {
                  layoutAbort.signal.throwIfAborted();
                  const scope = projectDesignLayoutGraph(rawScope);
                  const needsModel = scope.nodes.length > 1 || scope.referenceEdges.length > 0;
                  if (needsModel) modelScopes++;
                  const arrangement = needsModel ? await arrange(scope, config.authorTaskTimeoutMs ?? 60_000) : undefined;
                  if (arrangement?.layout) arranged++;
                  const layout = arrangement?.layout ?? defaultLayout(scope);
                  const packed = packDesignScope(id, scope, layout, Boolean(arrangement?.layout));
                  positions.push({ ...packed, layoutSource: arrangement?.layout ? 'model' : needsModel ? 'fallback' : 'single-node',
                    ...(arrangement?.layout ? { modelLayout: { graphDigest: scope.graphDigest, contractHash: layoutContractHash,
                      placementHash: artifactDigest(JSON.stringify(packed)), receipts: arrangement.receipts } } : {}) });
                }
                project = { ...structure, positions };
                layoutSource = arranged && arranged === modelScopes ? 'model' : arranged ? 'mixed' : 'fallback';
              } else {
                viewLayout = (await arrange(graph, 60_000))?.layout;
                if (viewLayout) layoutSource = 'model';
              }
              layoutAbort.signal.throwIfAborted();
              const excerpts=await designExportExcerpts(design,materials,requestContext,workSignal);
              const files = { 'design.html': workflowPage({ graph, mermaid, viewManifest, viewLayout, project,
                design:excerpts.length?{...design,excerpts}:design }) };
              const hashes = { 'design.html': artifactDigest(files['design.html']) };
              const directory = path.join(exportDir, key.replace(':', '-'));
              const value = { format: 2, designHash: merged.identity, graphDigest: graph.graphDigest, directory, hashes,
                layoutSource, provider: sections[0].provider, model: sections[0].model,
                requestId: sections[0].requestId, sourceCount: design.sources.length, sectionCount: sections.length };
              prepared = { files, value, summary: design, excerptIds:excerpts.map(item=>item.rangeId) };
              put(key, { materialHash, title, selection, owner, identity, prepared });
            }
            const { files, value, summary } = prepared;
            await resolveDesignMaterials({ title, selection, materialHash }, requestContext, workSignal);
            for (const rangeId of prepared.excerptIds??[]) {
              const range=summary.ranges.find(item=>item.id===rangeId);
              const source=summary.sources.find(item=>item.id===range?.sourceId);
              if (!source || await approveExcerpt(source,range,requestContext,workSignal)!==true) {
                put(key, { materialHash, title, selection, owner, identity });
                throw materialError('FKA_MATERIAL_UNAVAILABLE','Permission for the prepared design excerpt changed');
              }
            }
            workSignal.throwIfAborted();
            await commitDelivery(exportDir, value.directory, files, value.hashes, designNames(value));
            put(key, { materialHash, title, selection, owner, identity, summary, result: value });
            return value;
          }).catch(error => {
            if (!deadline.aborted && !layoutAbort.signal.aborted) {
              if (designFailures.size >= capacity.maxDrafts) designFailures.delete(designFailures.keys().next().value);
              designFailures.set(key, error);
            }
            throw error;
          }).finally(() => designRequests.delete(key));
          void pending.catch(() => {});
          designRequests.set(key, pending);
        }
        return { status: 'running', requestId };
      }
      signal?.throwIfAborted();
      if (selection.some(source => source.kind === 'material')) {
        await resolveDesignMaterials({ title, selection, materialHash }, requestContext, signal);
      }
      if (!(await deliveryMatches(result.directory, result.hashes, designNames(result)))) throw new Error('Design files changed after delivery');
      const ref = seal('design', key);
      const files = designNames(result).map(name => ({ name, sha256: result.hashes[name], url: origin + '/designs/' + ref + '/' + name }));
      const { hashes: _hashes, ...rest } = result;
      return { status: 'ready', ...rest, designRef: ref, files };
    }
    async function arrangeDesign(graph, signal) {
      if (signal.aborted) return;
      let expire;
      const expired = new Promise(resolve => {
        expire = () => resolve(undefined);
        signal.addEventListener('abort', expire, { once: true });
      });
      try {
        const key = 'design-layout:' + viewerHash + ':' + layoutContractHash + ':' + graph.graphDigest;
        return await Promise.race([layoutRequest(key, graph, signal), expired]);
      } finally {
        signal.removeEventListener('abort', expire);
      }
    }
    function layoutRequest(key, graph, optionalDeadline) {
      const cached = get(key);
      if (cached) return cached;
      let pending = layoutRequests.get(key);
      if (!pending && !layoutAbort.signal.aborted && layoutRequests.size < capacity.maxPhysicalExecutions) {
        const deadline = optionalDeadline ?? AbortSignal.timeout(config.authorTurnDurationMs ?? 240_000);
        const signal = AbortSignal.any([layoutAbort.signal, deadline]);
        pending = Promise.resolve().then(async () => {
          const result = await generateLayout(graph, defaultLayout(graph), planLayout, signal);
          signal.throwIfAborted();
          if (!result.layout) return result;
          return insert(key, { ...result, graphDigest: graph.graphDigest, layoutContractHash,
            layoutHash: artifactDigest(JSON.stringify(result.layout)) });
        }).catch(() => ({ reason: deadline.aborted ? 'layout-deadline' : 'layout-unavailable' }))
          .finally(() => layoutRequests.delete(key));
        layoutRequests.set(key, pending);
      }
      return pending ?? { reason: 'layout-busy' };
    }
    async function preparePreviewLayout(hash, graph, authorized) {
      const selectionKey = selectedLayoutKey(hash);
      if (get(selectionKey) || !authorized || !model.planLayout || layoutAbort.signal.aborted) return;
      const key = 'preview-layout:' + viewerHash + ':' + layoutContractHash + ':' + graph.graphDigest;
      const cached = await layoutRequest(key, graph);
      if (layoutAbort.signal.aborted) return;
      insert(selectionKey, cached?.layout ? { source: 'model', key } :
        { source: 'fallback', reason: cached?.reason, receipts: cached?.receipts ?? [] });
    }
    const skillSource = 'collection:' + collectionId;
    const localProfessionalSkills = {
      collection: ({ collectionId: scope }) => scope === collectionId ? collectionPlan.destination : null,
      async search({ id, description, collection, verifyApplicability, signal }) {
        if (collection.id !== collectionId) return { denied: true };
        const snapshot = binding.store.readCollectionMetadata(collection.id, { limit: 1001, includeProfessionalDescription: true });
        if (!snapshot || snapshot.skills.length === 1001) return { complete: false };
        const skills = snapshot.skills.map(({ manifest }) => manifest).filter(manifest => manifest.kind === 'professional');
        const exact = [], samePurpose = [], other = [];
        const normalize = value => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
        const purpose = normalize(description);
        for (const skill of skills) {
          if (skill.skillId === id || skill.name === id) exact.push(skill);
          else if (normalize(skill.description) === purpose) samePurpose.push(skill);
          else other.push(skill);
        }
        const candidates = new Map();
        const maxBodies = 4;
        let checked = 0, uncertain = false;
        for (const group of [exact, samePurpose, other]) {
          if (!group.length) continue;
          checked += group.length;
          if (checked > maxBodies) return { complete: false };
          const result = await planProfessionalSkills(collection, { id, professionalNeeds: [{ id, description }] }, {
            listProfessionalMetadata: async () => ({ nextCursor: null, items: group.map(manifest => ({
              ...manifest, id: manifest.skillId, path: `${collection.directory}/skills/${manifest.name}/SKILL.md`
            })) }),
            matchesMetadata: () => true,
            readProfessionalSkill: ({ collectionId: scope, skillId, version, digest }) => {
              const candidate = binding.store.readProfessionalVersion(scope, skillId, version);
              if (!candidate || candidate.manifest.digest !== digest) throw new Error('Exact catalog Skill disappeared');
              checkProfessionalSkill(candidate);
              return candidate;
            },
            async confirmApplicability(need, candidate, item) {
              signal?.throwIfAborted();
              let compatible;
              try {
                compatible = dependencies.confirmProfessionalSkill ? await dependencies.confirmProfessionalSkill({ need, candidate, item }) :
                  await verifyApplicability(need, candidate);
              } catch (error) {
                if (error.code !== 'FKA_BUDGET_EXHAUSTED') throw error;
              }
              if (compatible === true) candidates.set(item.id, candidate);
              if (typeof compatible !== 'boolean') uncertain = true;
              return compatible === true;
            }
          }, { maxPages: 1, maxBodies });
          if (uncertain) return { complete: false };
          const matches = result.conflicts[0]?.candidates ?? result.reuse;
          if (matches.length) return { complete: true,
            matches: matches.map(({ id }) => ({ candidate: candidates.get(id), source: skillSource, approved: true })) };
        }
        return { complete: true, occupied: exact.length > 0, matches: [] };
      }
    };
    const professionalSkillCatalog = {
      collection: localProfessionalSkills.collection,
      async search(scope) {
        const local = await localProfessionalSkills.search(scope);
        const external = await dependencies.professionalSkillCatalog?.search(scope);
        if (!external) return local;
        if (local.complete !== true || external.complete !== true || !Array.isArray(external.matches) || external.denied) {
          return { complete: false, denied: local.denied || external.denied };
        }
        const matches = [...local.matches, ...external.matches];
        return { complete: true, occupied: local.occupied || external.occupied, matches: [...new Map(matches.map(match =>
          [JSON.stringify([match.source, match.candidate.hash]), match])).values()] };
      }
    };
    authorHost = await createWorkflowAuthorHost({ namespace, storageFile: storeFile, collectionIds: [collectionId], hostProfile,
      hostExecutionContracts: dependencies.hostExecutionContracts,
      capabilityGraph: dependencies.capabilityGraph,
      resolveCapabilityGraphContext: dependencies.resolveCapabilityGraphContext,
      initialCapabilityIds: dependencies.initialCapabilityIds,
      initialDocuments: dependencies.initialDocuments,
      readDocumentUrl: dependencies.readDocumentUrl,
      defaults: { project: workspaceId, executionMode: 'standard', includeSource: false }, useNodeOptionsForNewDrafts: true, capacity,
      professionalSkillCatalog,
      async resolveProfessionalSkill(pin, scope) {
        if (pin.source !== undefined && pin.source !== skillSource) return dependencies.resolveProfessionalSkill?.(pin, scope);
        const candidate = binding.store.readProfessionalVersion(collectionId, pin.id, pin.version);
        if (!candidate || candidate.manifest.digest !== pin.digest) return null;
        checkProfessionalSkill(candidate);
        return { id: pin.id, version: pin.version, digest: pin.digest, source: skillSource, approved: true };
      },
      budgetPolicy: { durationMs: config.authorTurnDurationMs ?? 240000, maxRequests: 8,
        // The internal compile port returns a candidate with Program, Mermaid and GraphSnapshot.
        maxResponseBytes: 1024 * 1024 },
      documentBudgetPolicy: { durationMs: config.authorTurnDurationMs ?? 900000, maxRequests: 168, maxBytes: 48 * 1024 * 1024 },
      execution: model.execution,
      resolveImportSource({ sourceRef }) {
        const source = trustedImport(sourceRef);
        return source && { candidate: source.candidate, sourceRef, issuer: sourceIssuer(source) };
      },
      authorization: {
        resolveApplicableSafetyPolicies: () => [],
        observeReview: model.observeReview,
        async authorize({ action, collectionId: target, requestContext, approvalRef, publicationId, draftId, signal }) {
          if (target !== collectionId || authorIdentity(requestContext) !== authorIdentity(context)) return false;
          if (action === 'collection-plan') return approvalRef === bootstrap;
          if (action === 'advance-commit' || action === 'approve') await reauthorizeDraftSources(draftId, requestContext, signal);
          if (action !== 'publish') return true;
          const record = approval(approvalRef);
          if (record?.confirmed !== true || record.publicationId !== publicationId || record.draftId !== draftId) return false;
          const draft = await authorHost.readDraft({ draftId }, requestContext, signal);
          if (!draft.savedReceipt) await reauthorizeDraftSources(draftId, requestContext, signal);
          return draft.savedReceipt?.publicationId === publicationId || trustedDraft(draft);
        },
        verifyApproval({ approvalRef, draftId, candidateHash, reviewRef, previousHash, contentHash }) {
          const record = approval(approvalRef);
          const approved = record?.draftId === draftId && record.candidateHash === candidateHash &&
            record.reviewRef === reviewRef && record.previousHash === previousHash && record.contentHash === contentHash;
          return { approved, subjectId: context.principalId, approvalId: approvalRef };
        },
        async verifySettlement({ evidenceRef, draftId, turnId, attemptId, decision, resultHash, reservations, requestContext, signal }) {
          const proof = recoveryProofs.get(evidenceRef);
          if (!proof || proof.draftId !== draftId || proof.turnId !== turnId || proof.attemptId !== attemptId ||
              proof.decision !== decision || proof.resultHash !== resultHash) return;
          if (decision === 'confirm-result') await reauthorizeDraftSources(draftId, requestContext, signal);
          const noEffect = Object.values(reservations).every(item => item.sideEffect === 'read' && item.sideEffectStatus === 'none');
          if (decision === 'confirm-no-effect' && !noEffect) return;
          return { verified: true, physicalDone: true, noEffect, draftId, turnId, attemptId, evidenceRef, resultHash };
        },
        verifyImport({ sourceRef, sourceHash, issuer }) {
          const source = trustedImport(sourceRef);
          return !!source && source.candidate.hash === sourceHash && sourceIssuer(source) === issuer;
        }
      }
    });
    const binding = authorHost.createMcpOptions(context, { resolveAuthoringInput: dependencies.resolveAuthoringInput });
    if (!binding.store.readCollectionMetadata(collectionId)) {
      try { await binding.applyCollectionPlan(collectionPlan, bootstrap, context); }
      catch (error) { if (!binding.store.readCollectionMetadata(collectionId)) throw error; }
    }

    const readDraft = async (draftId, candidateHash, signal) => {
      const draft = await authorHost.readDraft({ draftId }, context, signal);
      if (withheld(draft.status) || draft.candidate?.hash !== candidateHash) throw new Error('候选已变更，请打开当前版本。');
      return draft;
    };
    function recoveryAttempt(draft) {
      if (draft.status !== 'reconciliation-required') return undefined;
      return draft.recoveryRef ?? (draft.physicalOutstanding.length === 1 ? draft.physicalOutstanding[0] : undefined);
    }

    async function recover({ draftId, expectedStateVersion }, requestContext, signal) {
      const draft = await authorHost.readDraft({ draftId }, requestContext, signal);
      if (draft.status !== 'reconciliation-required') return draft;
      const attempt = recoveryAttempt(draft);
      if (!attempt) throw new Error('没有可由本机服务核验的恢复记录，请由 Host 对账。');
      const evidenceRef = randomUUID();
      const resultHash = attempt.resultHash ?? null;
      const decision = resultHash ? 'confirm-result' : 'confirm-no-effect';
      recoveryProofs.set(evidenceRef, { draftId, ...attempt, decision, resultHash });
      try {
        await authorHost.settleTurn({ draftId, turnId: attempt.turnId, decision, evidenceRef, expectedStateVersion }, requestContext, signal);
      } finally { recoveryProofs.delete(evidenceRef); }
      return authorHost.readDraft({ draftId }, requestContext, signal);
    }
    const previewUrl = (draft, operation, layoutRevision) => origin + '/preview/' + seal('preview',
      { draftId: draft.id, candidateHash: draft.candidate.hash, ...(operation ? { operation } : {}),
        ...(layoutRevision ? { layoutRevision } : {}) });
    const layoutConflict = () => Object.assign(new Error('布局版本已变更，请先打开当前预览。'), { code: 'FKA_LAYOUT_CONFLICT' });
    async function relayoutCandidate({ draftId, candidateHash, expectedLayoutRevision, requestId }, _context, signal) {
      let draft = await readDraft(draftId, candidateHash, signal);
      if (!draft.savedReceipt && !trustedDraft(draft)) throw new Error(untrustedReason);
      const selectionKey = selectedLayoutKey(candidateHash), operationKey = 'relayout:' + requestId;
      const target = { draftId, candidateHash, expectedLayoutRevision };
      const assertBinding = row => {
        if (row && authorIdentity(row.target) !== authorIdentity(target)) throw layoutConflict();
      };
      const presentResult = result => ({ ...result, candidateHash,
        previewUrl: previewUrl(draft, undefined, result.layoutRevision) });
      let operation = get(operationKey);
      assertBinding(operation);
      if (operation?.result) return presentResult(operation.result);
      if (!get(selectionKey) || layoutRevisionOf(candidateHash) !== expectedLayoutRevision) throw layoutConflict();
      operation = insert(operationKey, { target });
      assertBinding(operation);
      const graph = checkCandidate(draft.candidate);
      const key = 'relayout-result:' + viewerHash + ':' + layoutContractHash + ':' + artifactDigest(requestId);
      const planned = await layoutRequest(key, graph);
      draft = await readDraft(draftId, candidateHash, signal);
      if (!draft.savedReceipt && !trustedDraft(draft)) throw new Error(untrustedReason);
      if (layoutAbort.signal.aborted) throw new Error('布局服务已停止。');
      data.exec('BEGIN IMMEDIATE');
      let result;
      try {
        operation = get(operationKey);
        assertBinding(operation);
        result = operation.result;
        if (!result) {
          if (layoutRevisionOf(candidateHash) !== expectedLayoutRevision) throw layoutConflict();
          if (planned.layout) {
            const revision = artifactDigest(JSON.stringify(['relayout-v1', target, requestId, planned.layoutHash]));
            put(selectionKey, { source: 'model', key, revision });
            result = { status: 'relayout-complete', layoutRevision: revision, layoutHash: planned.layoutHash };
          } else {
            result = { status: 'relayout-failed', layoutRevision: expectedLayoutRevision, reason: planned.reason };
          }
          put(operationKey, { target, result });
        }
        data.exec('COMMIT');
      } catch (error) {
        data.exec('ROLLBACK');
        throw error;
      }
      return presentResult(result);
    }
    const publicReview = review => ({ qualified: review.receipt?.qualified === true,
      findings: review.rejection?.findings?.map(({ message, nodeIds }) => ({ message, nodeIds })) ?? [],
      ...(review.receipt?.document ? { document: { sourceIdentity: review.receipt.document.sourceIdentity,
        graphDigest: review.receipt.document.graphDigest, sections: review.receipt.document.sections.length } } : {}),
      ...(review.receipt?.reviewRef ? { reviewRef: review.receipt.reviewRef } : {}) });

    async function exportCandidate({ draftId, candidateHash, layoutRevision, exportReceipt }, requestContext, signal) {
      const draft = await readDraft(draftId, candidateHash, signal);
      if (!draft.savedReceipt) await reauthorizeDraftSources(draftId, requestContext, signal);
      if (!draft.savedReceipt && !trustedDraft(draft)) throw new Error(untrustedReason);
      function issue(receipt, record) {
        const { directory, hashes, layoutRevision } = record;
        put('export-source:' + authorIdentity(hashes), { draftId, candidateHash });
        for (const name of deliveryNames) insert('export-member:' + name + ':' + hashes[name], receipt);
        const ref = seal('export', receipt);
        return { candidateHash, directory, exportReceipt: receipt, ...(layoutRevision ? { layoutRevision } : {}),
          files: deliveryNames.map(name => ({ name, url: origin + '/exports/' + ref + '/' + name, sha256: hashes[name] })) };
      }
      const receiptForDraft = id => {
        const record = get('export:' + id);
        return record?.draftId === draftId && record.candidateHash === candidateHash &&
          record.directory === path.join(exportDir, id) ? record : undefined;
      };
      const available = record => record && deliveryMatches(record.directory, record.hashes);
      if (exportReceipt !== undefined) {
        if (layoutRevision !== undefined) throw new Error('请指定导出收据或布局版本其中之一。');
        const record = receiptForDraft(exportReceipt);
        if (!record) throw new Error('Exact export receipt or its original files are unavailable');
        if (!await available(record)) {
          throw Object.assign(new Error('Export files are unavailable'), { code: 'FKA_EXPORT_FILES_UNAVAILABLE' });
        }
        return issue(exportReceipt, record);
      }
      if (draft.approvalReceipt?.candidateHash !== candidateHash || !draft.reviewReceipt?.qualified ||
          !approval(draft.approvalReceipt.approvalRef)?.confirmed) throw new Error('请先在预览页确认当前候选。');
      const selected = get(selectedLayoutKey(candidateHash));
      const currentRevision = layoutRevisionOf(candidateHash);
      if (layoutRevision === undefined ? !!selected?.revision : layoutRevision !== currentRevision) throw layoutConflict();
      const layout = selectedLayout(candidateHash);
      const portable = canExportPortable(draft.candidate);
      const signer = portable ? exportKey.publicKey : null;
      const previousId = selected?.revision ? artifactDigest(JSON.stringify([
        'layout-export-v1', candidateHash, selected.revision, signer
      ])).slice(7) : signer ? artifactDigest(JSON.stringify(['portable-v1', candidateHash, signer])).slice(7) : candidateHash.slice(7);
      const previous = receiptForDraft(previousId);
      if ((layoutRevision === undefined || previous?.viewerHash === viewerHash) && await available(previous)) {
        return issue(previousId, previous);
      }
      const receiptId = artifactDigest(JSON.stringify(['layout-export-v2', draftId, candidateHash, currentRevision, signer])).slice(7);
      const existing = receiptForDraft(receiptId);
      if (await available(existing)) return issue(receiptId, existing);
      const directory = path.join(exportDir, receiptId);
      const files = publicDelivery(draft.candidate, portable ? exportKey : undefined, layout);
      const hashes = Object.fromEntries(deliveryNames.map(name => [name, artifactDigest(files[name])]));
      const record = insert('export:' + receiptId, { draftId, candidateHash, directory, hashes, viewerHash, layoutRevision: currentRevision });
      if (record.draftId !== draftId || record.candidateHash !== candidateHash || record.layoutRevision !== currentRevision ||
          record.viewerHash !== viewerHash || record.directory !== directory || authorIdentity(record.hashes) !== authorIdentity(hashes)) {
        throw new Error('Export receipt differs from the confirmed candidate and layout');
      }
      await commitDelivery(exportDir, directory, files, hashes);
      return issue(receiptId, record);
    }

    const resultFor = (status, candidate, extra = {}) => ({
      status, collectionId, collectionName, workflowId: candidate.manifest.skillId,
      version: candidate.manifest.version, candidateHash: candidate.hash, ...extra
    });
    const activeHash = draft => binding.store.readActive(collectionId, draft.candidate.manifest.skillId)?.hash ?? null;
    const changedTargetReason = '接收端当前版本已变更，请重新发起添加并复审。';

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
      if (uploaded?.changed || (uploaded?.provenance && candidateHash && uploaded.provenance.candidateHash !== candidateHash) ||
          (uploaded?.portable && candidateHash && uploaded.candidate.hash !== candidateHash)) {
        return { requestId, status: 'conflict', reason: '导出文件与 FlowKit 来源记录不符。' };
      }
      const selector = uploaded?.codexSelector;
      const untrusted = uploaded?.untrusted || uploaded?.portable && !trustedExports.has(uploaded.exporterKey);
      const external = !firstParty && !untrusted && uploaded?.candidate;
      async function withOptions() {
        return [
          { destination: 'flowkit', label: '加入 FlowKit', available: compatible(external) },
          { destination: 'codex', label: '直接安装', available: await (dependencies.canInstall ?? canInstall)(selector) }
        ];
      }
      if (!firstParty && !uploaded?.portable && !destination) return { requestId, status: 'choice_required', options: await withOptions(),
        ...(untrusted ? { reason: untrustedReason } : {}),
        ...(uploaded ? {} : { sourceUrl: origin + '/' }) };
      if (destination === 'codex') {
        return (await withOptions())[1].available ?
          { requestId, status: 'install_required', destination, selector, command: ['codex','plugin','add',selector] } :
          { requestId, status: 'rejected', reason: '缺少当前 Codex 可安装的外部插件包。' };
      }
      const material = authorIdentity({ sourceRef, candidateHash: candidateHash ?? null, destination: 'flowkit', collectionId });
      const operationKey = 'add:' + requestId;
      const prior = get(operationKey);
      if (prior && prior.material !== material) return { requestId, status: 'conflict', reason: '该请求 ID 已关联其他来源或版本。' };
      if (prior?.result) return prior.result;
      if (!prior?.draftId && !firstParty && !compatible(external)) return { requestId, status: 'rejected', reason: untrusted ?
        untrustedReason : '缺少当前 Host 可核验的兼容工作流候选。' };
      const operation = prior ?? insert(operationKey, { material, publicationId: 'flowkit-local-' + artifactDigest(requestId).slice(7),
        input: { ...input, destination: 'flowkit' } });

      let draft;
      if (operation.draftId) draft = await readDraft(operation.draftId, operation.candidateHash, signal);
      else if (firstParty) draft = await readDraft(firstParty.draftId, firstParty.candidateHash, signal);
      else {
        const source = { candidate: external, exporterKey: uploaded.exporterKey ?? null };
        const issuer = sourceIssuer(source);
        const verifiedSourceRef = 'verified-' + authorIdentity([external.hash, issuer ?? null]).slice(7);
        const identity = authorIdentity([external.manifest.collectionId, external.manifest.skillId, collectionId]);
        const skillId = 'imported-' + identity.slice(7, 39);
        const incoming = rebindImportedCandidate(external, { collectionId, skillId, issuer });
        const installed = binding.store.readVersion(collectionId, skillId, incoming.hash) ??
          (issuer && binding.store.readVersion(collectionId, skillId, rebindImportedCandidate(external, { collectionId, skillId }).hash));
        if (installed) {
          const result = resultFor('already_added', installed, { requestId, destination: 'flowkit' });
          put(operationKey, { ...operation, result });
          return result;
        }
        const previous = binding.store.readActive(collectionId, skillId);
        if (previous && !sameSignedWorkflowOrigin(incoming.manifest.importedFrom, previous.manifest.importedFrom)) {
          return { requestId, status: 'conflict', reason: '无法核对当前版本与待添加版本来自同一签名来源。' };
        }
        if (previous && !isNewerWorkflowVersion(incoming.manifest.version, previous.manifest.version)) {
          return { requestId, status: 'conflict', reason: '同源更新必须使用比当前生效版本更高的新版本号。' };
        }
        insert('import:' + verifiedSourceRef, source);
        try {
          draft = await authorHost.start({ operation: 'import', collectionId,
            requestId: 'local-import-' + authorIdentity([collectionId, verifiedSourceRef, previous?.hash ?? null]).slice(7),
            goal: external.manifest.name, importSource: { sourceRef: verifiedSourceRef, mode: 'new-collection' }, target: { skillId },
            ...(previous ? { targetRef: { collectionId, skillId, baseVersion: previous.manifest.version,
              baseArtifactHash: previous.manifest.artifactHash } } : {}) }, context, signal);
        } catch (error) {
          if (/conflict|author-target/.test(error.code + ' ' + error.reasonCode)) return { requestId, status: 'conflict', reason: changedTargetReason };
          throw error;
        }
      }
      const current = get(operationKey);
      if (current.result) return current.result;
      if (current.draftId && (current.draftId !== draft.id || current.candidateHash !== draft.candidate.hash)) {
        return { requestId, status: 'conflict', reason: '添加请求已绑定其他候选，请使用新的请求 ID。' };
      }
      const bound = { ...current, draftId: draft.id, candidateHash: draft.candidate.hash };
      put(operationKey, bound);
      const existing = binding.store.readVersion(collectionId, draft.candidate.manifest.skillId, draft.candidate.hash);
      if (existing) {
        const original = draft.savedReceipt?.publicationId === operation.publicationId;
        const result = resultFor(original ? 'added' : 'already_added', draft.candidate, { requestId, destination: 'flowkit',
          ...(original ? { publicationId: operation.publicationId } : {}) });
        put(operationKey, { ...bound, result });
        return result;
      }
      if (!trustedDraft(draft)) return { requestId, status: 'rejected', reason: untrustedReason };
      if (activeHash(draft) !== draft.previousHash) return { requestId, status: 'conflict', reason: changedTargetReason };
      if (draft.operation === 'import' && draft.status === 'needs-review' && draft.stateVersion === 1) {
        draft = await authorHost.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion,
          turnId: 'review-' + draft.candidate.hash.slice(7), input: '核对外部候选定义、来源与接收端原版本。', kind: 'review-only',
          candidateHash: draft.candidate.hash }, context);
      }
      const approvalRef = draft.approvalReceipt?.approvalRef;
      const proof = approval(approvalRef);
      if (!draft.reviewReceipt?.qualified) {
        return { requestId, status: 'needs_review', reason: '当前候选需要通过复审再确认添加。',
          draftId: draft.id, stateVersion: draft.stateVersion, candidateHash: draft.candidate.hash,
          review: publicReview({ receipt: draft.reviewReceipt, rejection: draft.reviewRejection }) };
      }
      if (proof?.publicationId !== operation.publicationId || proof.confirmed !== true) {
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
      const result = resultFor(visible ? 'added' : 'saved_pending_discovery', draft.candidate, { requestId, destination: 'flowkit', publicationId: receipt.publicationId });
      if (visible) put(operationKey, { ...bound, result });
      return result;
    }

    function present(draft) {
      const attempt = recoveryAttempt(draft);
      return { id: draft.id, draftId: draft.id, stateVersion: draft.stateVersion, status: draft.status,
        collectionId: draft.collectionId, previousHash: draft.previousHash, questions: draft.questions,
        diagnostics: draft.diagnostics?.map(({ code, message }) => ({ code, message })),
        review: publicReview({ receipt: draft.reviewReceipt, rejection: draft.reviewRejection }),
        ...(draft.documentProgress ? { documentProgress: draft.documentProgress } : {}),
        ...(attempt ? { recovery: { tool: 'flowkit_recover_workflow', turnId: attempt.turnId } } : {}),
        ...(draft.plan?.planHash ? { planHash: draft.plan.planHash } : {}),
        ...(draft.candidate ? { candidate: { name: draft.candidate.manifest.name, version: draft.candidate.manifest.version,
          candidateHash: draft.candidate.hash, previewUrl: previewUrl(draft), layoutRevision: layoutRevisionOf(draft.candidate.hash),
          layoutSource: get(selectedLayoutKey(draft.candidate.hash))?.source ?? 'pending',
          ...(draft.candidate.manifest.professionalSkills.length ? { requiredProfessionalSkills: draft.candidate.manifest.professionalSkills } : {}),
          requiredCapabilities: draft.candidate.manifest.workflowDefinition?.nodes?.flatMap(node => [node.action ?? node.verifier].filter(Boolean)) } } : {}) };
    }

    const resolveRunBinding = async runId => {
      if (typeof runId !== 'string' || !runId || runId.length>256) return null;
      const view = await dependencies.resolveRunViewer?.({ runId, requestContext: context });
      return view?.ref?.runId===runId ? view : null;
    };
    const runWorkflow = typeof dependencies.runWorkflow === 'function' && (async scope => {
      const candidate = binding.store.readVersion(scope.collectionId, scope.skillId, scope.candidateHash);
      if (!candidate) throw new Error('No approved Workflow Skill at the requested identity');
      const graph=checkCandidate(candidate);
      const result=await dependencies.runWorkflow(scope, { candidate, store: binding.store });
      if (graph.mode==='standard' || !result?.runId || !dependencies.resolveRunViewer) return result;
      try {
        const view=await resolveRunBinding(result.runId);
        if (!view || view.standardTrace || view.ref.artifactHash!==graph.artifactHash ||
          view.ref.graphDigest!==graph.graphDigest || (view.ref.candidateHash || view.candidate) &&
          (view.ref.candidateHash!==candidate.hash || view.ref.collectionId!==scope.collectionId ||
            view.candidate?.hash!==candidate.hash || view.candidate?.manifest?.collectionId!==scope.collectionId)) return result;
        await view.auth.readRunView(view.ref,view.options);
        return {...result,runUrl:origin+'/runs/'+encodeURIComponent(result.runId)};
      } catch {
        // Viewer binding is optional. Execution has already returned a Run.
        return result;
      }
    });
    const mcp = createFlowkitHttpHandler(req => exact(req.headers.authorization, 'Bearer ' + credential) ?
      { ...binding, ...(runWorkflow ? { runWorkflow } : {}), workflowUi: { defaultCollectionId: collectionId, review: publicReview, export: exportCandidate, add, recover, present, authoringMaterials,
        ...(model.planDesign ? { design: createDesign } : {}),
        ...(model.planLayout ? { relayout: relayoutCandidate } : {}) } } : null);

    async function web(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
        return json(res, 403, { error: 'Only the configured loopback origin is allowed' });
      }
      const url = new URL(req.url, origin);
      if (url.pathname === mcpPath) {
        // Local MCP is stateless. Codex may keep a socket idle while the user reviews an export.
        res.setHeader('Connection', 'close');
        return mcp(req, res);
      }
      const [, route, ref, action] = url.pathname.split('/');
      if (route === 'operator' && req.method === 'GET' && !bootstrapUsed && exact(ref, bootstrap)) {
        bootstrapUsed = true;
        res.writeHead(303, { Location: '/', 'Set-Cookie': operatorCookie + '=' + seal('operator', workspaceId) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' });
        return res.end();
      }
      if (url.pathname === '/' && req.method === 'GET' && operator(req)) {
        return html(res, sourcePanel);
      }
      if (route==='runs' && ref && action==='fork' && url.pathname==='/runs/'+ref+'/fork' &&
          dependencies.forkRun && dependencies.resolveRunViewer && ['GET','POST'].includes(req.method)) {
        if (!operator(req) || (req.method==='POST' && req.headers.origin!==origin)) {
          return json(res,403,{error:'需要本机操作员授权。'});
        }
        try {
          const runId=decodeURIComponent(ref);
          const view=await resolveRunBinding(runId);
          if (!view || view.standardTrace) return json(res,404,{error:'找不到可复跑的运行。'});
          await view.auth.readRunView(view.ref,view.options);
          if (req.method==='GET') {
            const before=url.searchParams.get('beforeRevision');
            return json(res,200,await listInteractiveForkPoints({ref:view.ref,nodeId:url.searchParams.get('nodeId'),
              ...(before===null?{}:{beforeRevision:Number(before)})},{...view.options,auth:view.auth}));
          }
          const input=JSON.parse(await readBody(req,4096));
          if (!input || Object.keys(input).length!==4 || !Number.isSafeInteger(input.revision) || input.revision<0 ||
              !Number.isSafeInteger(input.entryRevision) || input.entryRevision<0 || input.entryRevision>input.revision ||
              typeof input.startKey!=='string' || !/^[a-zA-Z0-9_.:@-]{1,128}$/.test(input.startKey) ||
              typeof input.redoWrites!=='boolean') return json(res,400,{error:'复跑请求不合法。'});
          const {revision,entryRevision,startKey,redoWrites}=input;
          const result=await dependencies.forkRun({source:view.ref,revision,entryRevision,startKey,redoWrites},{view,requestContext:context});
          if (!result?.runId || result.runId===runId) throw new Error('Host did not return a distinct Run');
          let runUrl=null;
          try {
            const next=await resolveRunBinding(result.runId);
            if (next?.ref.artifactHash===view.ref.artifactHash && next.ref.graphDigest===view.ref.graphDigest &&
                next.ref.candidateHash===view.ref.candidateHash && next.ref.collectionId===view.ref.collectionId &&
                next.ref.approvalRef===view.ref.approvalRef) {
              await next.auth.readRunView(next.ref,next.options);
              runUrl=origin+'/runs/'+encodeURIComponent(result.runId);
            }
          } catch { /* A launched Run remains valid even if its viewer is temporarily unavailable. */ }
          return json(res,200,{runId:result.runId,status:result.status,runUrl});
        } catch(error) {
          if (['FK_I_HOST_DENIED','FK_I_PROGRAM_MISMATCH'].includes(error?.code)) return json(res,403,{error:'宿主未授权复跑。'});
          if (['FK_I_FORK_UNAVAILABLE','FK_I_START_CONFLICT'].includes(error?.code)) return json(res,409,{error:'复跑点当前不可用。'});
          if (error instanceof SyntaxError || error?.code==='FK_I_INVALID_TRANSITION') return json(res,400,{error:'复跑请求不合法。'});
          return json(res,503,{error:'暂时无法发起复跑。'});
        }
      }
      if (route==='runs' && ref && ['artifacts','artifact-content'].includes(action) &&
        url.pathname==='/runs/'+ref+'/'+action && req.method==='GET' && dependencies.resolveRunViewer) {
        if (!operator(req)) return json(res,403,{error:'请先建立本机操作员会话。'});
        const runId=decodeURIComponent(ref);
        const signal=AbortSignal.timeout(config.authorTaskTimeoutMs??90000);
        try {
          const view=await resolveRunBinding(runId);
          if (!view || view.standardTrace) return json(res,404,{error:'运行或产物不可用。'});
          const options={...view.options,signal};
          if (action==='artifacts') {
            const after=Number(url.searchParams.get('after')??0);
            return json(res,200,await workflowRunArtifacts({...view,options,after}));
          }
          const artifactId=url.searchParams.get('artifactId'), versionId=url.searchParams.get('versionId');
          const audience=dependencies.readArtifactContent;
          if (typeof audience!=='function') return json(res,404,{error:'宿主未提供正文。'});
          const content=await view.auth.readRunArtifactContent({ref:view.ref,artifactId,versionId},options,
            version=>audience({...version,requestContext:context}));
          return content?json(res,200,content):json(res,404,{error:'该版本没有可阅读正文。'});
        } catch (error) {
          if (error.code==='FK_I_INVALID_OPERATION') return json(res,400,{error:'产物标识或分页位置不合法。'});
          if (error.code==='FK_I_ARTIFACT_CONTENT_INVALID') return json(res,409,{error:'正文与登记版本不符，无法打开。'});
          if (['FK_I_HOST_DENIED','FK_I_PROGRAM_MISMATCH','FK_I_BINDING_MISSING'].includes(error.code)) {
            return json(res,404,{error:'运行或产物不可用。'});
          }
          return json(res,503,{error:'暂时无法读取产物。'});
        }
      }
      if (route === 'runs' && ref && (!action || action==='progress') && req.method === 'GET' && dependencies.resolveRunViewer) {
        if (!operator(req)) return json(res, 403, { error: '请先建立本机操作员会话。' });
        const runId = decodeURIComponent(ref);
        const progress=action==='progress';
        const afterRevision=url.searchParams.has('afterRevision') ? Number(url.searchParams.get('afterRevision')) : undefined;
        const artifactAfter = Number(url.searchParams.get('artifactAfter') ?? 0);
        if (url.pathname !== '/runs/' + ref + (progress?'/progress':'') || !runId || runId.length>256 ||
            (afterRevision!==undefined && (!Number.isSafeInteger(afterRevision) || afterRevision< -1)) ||
            (progress && url.searchParams.has('artifactAfter')) ||
            !Number.isSafeInteger(artifactAfter) || artifactAfter < 0) {
          return json(res, 400, { error: '运行标识或分页位置不合法。' });
        }
        try {
          const view=await resolveRunBinding(runId);
          if (!view) return json(res, 404, { error: '找不到可查看的运行。' });
          if (view.standardTrace) {
            if (progress || (afterRevision??-1)!==-1 || artifactAfter!==0) return json(res,400,{error:'单次调用记录没有持久分页。'});
            return html(res,await workflowTracePage({...view,requestContext:context}));
          }
          if (progress) return json(res,200,await workflowRunProgress({...view,afterRevision}));
          return html(res,await workflowRunPage({...view,requestContext:context,afterRevision,artifactAfter,
            forkEnabled:typeof dependencies.forkRun==='function',
            artifactContentEnabled:typeof dependencies.readArtifactContent==='function'}));
        } catch (error) {
          if (error.code === 'FK_I_HOST_DENIED' || error.code === 'FK_I_PROGRAM_MISMATCH') {
            return json(res, 404, { error: '找不到可查看的运行。' });
          }
          if (error.code === 'FK_I_INVALID_TRANSITION') return json(res, 400, { error: '运行分页位置不合法。' });
          if (progress) return json(res,503,{error:'暂时无法读取运行进度。'});
          throw error;
        }
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
        const portable = !provenance && !changed ? readPortableExport(source, trustedExports) : {};
        const sourceRef = randomUUID();
        insert('upload:' + sourceRef, { candidate: portable.candidate ?? (compatible(source) ? source : null), provenance,
          changed: changed || portable.invalid === true, portable: !!portable.candidate, untrusted: portable.untrusted === true,
          exporterKey: portable.publicKey ?? null, codexSelector: form.get('codex') });
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
      if (route==='designs' && ref && action==='evidence' && req.method==='GET' && url.pathname==='/designs/'+ref+'/evidence') {
        if (!operator(req)) return json(res,403,{error:'请先建立本机操作员会话。'});
        const key=unseal('design',ref),record=key&&get(key);
        const sourceId=url.searchParams.get('source'),rangeId=url.searchParams.get('range');
        const source=record?.summary?.sources?.find(item=>item.id===sourceId);
        const range=rangeId&&record?.summary?.ranges?.find(item=>item.id===rangeId&&item.sourceId===sourceId);
        if (!record?.result || record.owner!==designOwner(context) || !source || rangeId&&!range) {
          return json(res,404,{error:'没有可打开的材料引用。'});
        }
        const selected=record.selection?.filter(item=>item.id===source.id);
        if (selected?.length!==1) return json(res,404,{error:'此导出仅保留来源引用。'});
        try {
          const signal=AbortSignal.timeout(config.authorTaskTimeoutMs??90000);
          const {materials}=await resolveSources(selected,context,signal,false);
          const evidence=designEvidence(source,materials[0],range);
          return evidence?json(res,200,evidence):json(res,413,{error:'原文件较大，请从节点选择具体证据片段。'});
        } catch {
          return json(res,404,{error:'无法取得已授权的原始版本。'});
        }
      }
      if (route === 'designs' && req.method === 'GET' && legacyDesignNames.includes(action)) {
        const key = unseal('design', ref);
        const record = key && get(key);
        const entry = record?.result;
        if (!entry || record.owner && record.owner !== designOwner(context)) return json(res, 403, { error: 'Invalid design link' });
        if (!designNames(entry).includes(action)) return json(res, 404, { error: 'Design file is unavailable' });
        if (record.selection?.some(source => source.kind === 'material')) {
          const signal = AbortSignal.timeout(config.authorTaskTimeoutMs ?? 90000);
          try { await resolveDesignMaterials(record, context, signal); }
          catch { return json(res, 403, { error: 'Design materials are unavailable' }); }
        }
        const contents = await readFile(path.join(entry.directory, action));
        if (artifactDigest(contents) !== entry.hashes[action]) return json(res, 409, { error: 'Design file changed' });
        if (action === 'design.html') return html(res, contents);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="design.mmd"' });
        return res.end(contents);
      }
      const preview = route === 'preview' && unseal('preview', ref);
      if (preview) {
        const draft = await readDraft(preview.draftId, preview.candidateHash);
        if (preview.layoutRevision && preview.layoutRevision !== layoutRevisionOf(preview.candidateHash)) {
          return json(res, 409, { error: '布局版本已变更，请打开当前预览。' });
        }
        const label = draft.candidate.manifest.name + ' ' + draft.candidate.manifest.version;
        if (req.method === 'GET' && !action) {
          const current = operator(req);
          const graph = checkCandidate(draft.candidate);
          await preparePreviewLayout(draft.candidate.hash, graph, current && (draft.savedReceipt || trustedDraft(draft)));
          const unavailable = [];
          if (current && trustedDraft(draft) && (draft.operation === 'import' || draft.savedReceipt)) {
            const scope = { collectionId, candidateHash: draft.candidate.hash, requestContext: context,
              signal: AbortSignal.timeout(config.authorTaskTimeoutMs ?? 90000) };
            for (const pin of draft.candidate.manifest.professionalSkills.filter(item => item.source)) {
              const resolved = await resolveTrustedProfessionalPin(binding.store, pin, { collectionId,
                resolve: dependencies.resolveRunProfessionalSkill, scope }).catch(() => null);
              if (!resolved) unavailable.push(`${pin.id} ${pin.version} (${pin.source})`);
            }
          }
          const viewLayout = selectedLayout(draft.candidate.hash);
          const layoutRevision = layoutRevisionOf(draft.candidate.hash);
          if (preview.layoutRevision && preview.layoutRevision !== layoutRevision) {
            return json(res, 409, { error: '布局版本已变更，请打开当前预览。' });
          }
          const challenge = seal('confirm', { ...preview, stateVersion: draft.stateVersion, layoutRevision });
          const skillDrafts = !draft.savedReceipt && !draft.approvalReceipt ? draft.resources?.skillDrafts ?? [] : [];
          const skillReview = current ? skillDrafts.map(({ manifest, files }) => '<details><summary>复审关联 Skill ' +
            escapeHtml(manifest.name + ' ' + manifest.version) + '</summary><pre>' +
            escapeHtml(files['SKILL.md']) + '</pre></details>').join('') : '';
          const pinned = preview.operation && draft.previousHash &&
            binding.store.readVersion(collectionId, draft.candidate.manifest.skillId, draft.previousHash);
          const controls = !draft.savedReceipt && !trustedDraft(draft) ? '<p>' + escapeHtml(untrustedReason) + '</p>' :
            preview.operation && draft.savedReceipt ? '<p>该版本已保存。</p>' :
            preview.operation && activeHash(draft) !== draft.previousHash ? '<p>' + escapeHtml(changedTargetReason) + '</p>' :
            draft.reviewReceipt?.qualified && current ? skillReview +
            (pinned ? '<p>当前版本 ' + escapeHtml(pinned.manifest.version) + '，更新到 ' + escapeHtml(draft.candidate.manifest.version) + '。</p>' : '') +
            '<form method="post" action="/preview/' + ref + '/confirm"><input type="hidden" name="challenge" value="' + challenge +
            '"><button type="submit" disabled>' + (pinned ? '确认并更新 FlowKit 工作流' :
              preview.operation ? '确认并加入 FlowKit' : '确认这个候选') + '</button></form>' :
            '<p>' + (current ? '候选需要通过复审。' : '请用本机启动信息建立操作员会话后刷新。') + '</p>';
          const dependencyStatus = unavailable.length ? '<p>当前宿主无法核对依赖，运行前需由宿主补齐或重新授权。</p><ul>' +
            unavailable.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>' : '';
          return html(res, workflowPage({ graph, candidateHash: draft.candidate.hash, controls: dependencyStatus + controls,
            mermaid: draft.candidate.files['workflow.mmd'], definition: draft.candidate.manifest.workflowDefinition,
            executionManifest: draft.candidate.manifest, pendingSkillDigests: new Set(skillDrafts.map(skill => skill.manifest.digest)), viewLayout }));
        }
        if (req.method === 'POST' && action === 'confirm' && operator(req) && req.headers.origin === origin) {
          const challenge = unseal('confirm', new URLSearchParams(await readBody(req, 8192)).get('challenge'));
          if (!challenge || challenge.draftId !== draft.id || challenge.candidateHash !== draft.candidate.hash ||
              challenge.stateVersion !== draft.stateVersion || challenge.operation !== preview.operation ||
              challenge.layoutRevision !== layoutRevisionOf(draft.candidate.hash) || !draft.reviewReceipt?.qualified) {
            return json(res, 409, { error: '候选已变更或未通过复审，请刷新。' });
          }
          const operation = preview.operation && get('add:' + preview.operation);
          if (preview.operation && (!operation || operation.draftId !== draft.id || operation.candidateHash !== draft.candidate.hash)) {
            return json(res, 409, { error: '添加请求已变更。' });
          }
          if (!draft.savedReceipt && !trustedDraft(draft)) return json(res, 403, { error: untrustedReason });
          if (operation && draft.savedReceipt) return json(res, 409, { error: '该版本已保存。请在 Codex 读取添加结果。' });
          if (operation && !draft.savedReceipt && activeHash(draft) !== draft.previousHash) {
            return json(res, 409, { error: changedTargetReason });
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
      url: origin + mcpPath, collectionId, operatorUrl: origin + '/operator/' + bootstrap, exportPublicKey: exportKey.publicKey,
      async close() {
        layoutAbort.abort();
        if (server.listening) {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
        }
        await Promise.allSettled([...designRequests.values(), ...layoutRequests.values()]);
        const outcome = await authorHost.close({ mode: 'cancel' });
        if (outcome.closed) await closeStorage();
        return outcome;
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
    process.stdout.write(JSON.stringify({ url: service.url, collectionId: service.collectionId, operatorUrl: service.operatorUrl,
      exportPublicKey: service.exportPublicKey }) + '\n');
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
