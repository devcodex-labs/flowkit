import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';
import { checkCandidate } from '../src/author/standard-artifact.mjs';
import { graphContentHash } from '../src/compiler/graph-snapshot.mjs';

const resource = name => readFileSync(new URL('./workflow-viewer/' + name, import.meta.url), 'utf8');
const template = resource('viewer.html').replace(/\r\n/g, '\n');
const reference = JSON.parse(resource('v45-layout.json'));
const embeddedData = '@@FLOWKIT_WORKFLOW_DATA@@';
const controlsSlot = '<!-- FLOWKIT_HOST_CONTROLS -->';
const dataStart = '<script id="workflow-data" type="application/json">';
const viewerScript = template.match(/<script>\n?([\s\S]*?)<\/script>/)?.[0].slice(8, -9);
if (!viewerScript || template.split(embeddedData).length !== 2 || template.split(controlsSlot).length !== 2) {
  throw new TypeError('Invalid FlowKit viewer template');
}
const scriptHash = createHash('sha256').update(viewerScript).digest('base64');
const shell = template.replace(/script-src 'sha256-[^']+'/, "script-src 'sha256-" + scriptHash + "'");
export const viewerHash = artifactDigest(JSON.stringify([1, shell, reference]));

const edgeStyles = new Map([
  ['condition-branch', ['branch', '条件分支']],
  ['verification-success', ['success', '校验通过']],
  ['verification-failure', ['error', '校验失败']],
  ['action-error', ['error', '技术失败']],
  ['human-approve', ['success', '批准']],
  ['human-reject', ['loop', '要求修订']],
  ['human-decline', ['error', '拒绝']],
  ['parallel-member', ['parallel', '进入并行分支']],
  ['parallel-join', ['parallel', '汇合']],
]);

/** Curated placements bind to the projected topology, independent of Program bytes and source locations. */
export function viewerTopologyDigest(graph) {
  const ordered = (rows, key) => rows.sort((left, right) => left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
  const edges = rows => ordered(rows.map(({ sourcePath: _path, ...edge }) => edge), 'edgeId');
  return graphContentHash({
    mode: graph.mode, workflowId: graph.workflowId, entryNodeId: graph.entryNodeId,
    contractDigest: graph.contract?.digest ?? null,
    nodes: ordered(graph.nodes.map(({ sourcePath: _path, line: _line, column: _column, ...node }) => node), 'id'),
    regions: ordered([...graph.regions], 'ownerId'),
    referenceEdges: edges(graph.referenceEdges), executionEdges: edges(graph.executionEdges)
  });
}

function layoutFor(graph, definition) {
  if (graph.graphDigest === reference.graphDigest ||
    graph.workflowId === 'v45-software-delivery' && graph.mode === 'interactive-p2' &&
    viewerTopologyDigest(graph) === reference.topologyDigest &&
    // GraphSnapshot redacts predicate literals. Curated descriptions also depend on the exact predicates.
    definition && graphContentHash(definition.nodes.filter(node => node.type === 'condition')
      .map(({ id, branches }) => [id, branches]).sort()) === reference.conditionDigest) return reference.layout;
  return defaultLayout(graph);
}

export function defaultLayout(graph) {
  const placements = new Map();
  const nodes = [];
  function place(node, helper) {
    const position = nodes.length;
    const id = 'n' + position;
    nodes.push({ id, nodeId: node.id, phase: 'flow', x: 72 + position % 7 * 284,
      y: 148 + Math.floor(position / 7) * 156, w: helper ? 70 : 224, h: helper ? 70 : 96,
      ...(helper ? { helper, label: helper === 'parallel-start' ? '并行入口' : '并行汇合' } : {}) });
    return id;
  }
  for (const node of graph.nodes) {
    if (node.type === 'parallel') {
      placements.set(node.id, { entry: place(node, 'parallel-start'), join: place(node, 'parallel-join') });
    } else {
      placements.set(node.id, { entry: place(node) });
    }
  }
  const edges = graph.referenceEdges.map((edge, index) => {
    const [kind, label] = edgeStyles.get(edge.role) ?? ['normal', ''];
    const from = placements.get(edge.from);
    const to = placements.get(edge.to);
    if (!from || !to) throw new TypeError('Workflow viewer edge lacks its declared endpoint');
    return { id: 'e' + index, edgeId: edge.edgeId, source: edge.role === 'parallel-join' ? from.join : from.entry,
      target: to.entry, kind, label, dashed: kind === 'error' || kind === 'loop' };
  });
  const coordinates = new Map(nodes.map(node => [node.id, node]));
  const names = new Map(graph.nodes.map(node => [node.id, node.name ?? node.id]));
  const groups = graph.regions.map(region => {
    const cards = [region.ownerId, ...region.memberIds].flatMap(id =>
      Object.values(placements.get(id)).map(visualId => coordinates.get(visualId)));
    const x = Math.min(...cards.map(node => node.x)) - 18;
    const y = Math.min(...cards.map(node => node.y)) - 24;
    const right = Math.max(...cards.map(node => node.x + node.w)) + 18;
    const bottom = Math.max(...cards.map(node => node.y + node.h)) + 14;
    return { ownerId: region.ownerId, phase: 'flow', x, y, w: right - x, h: bottom - y,
      title: names.get(region.ownerId) + (region.joinStrategy ? ' · ' + region.joinStrategy : '') };
  });
  return { nodes, edges, groups, phases: [{ id: 'flow', title: graph.name ?? '工作流', x: 40, y: 58,
    w: 64 + Math.min(7, nodes.length) * 284, h: 124 + Math.ceil(nodes.length / 7) * 156, color: '#64748b' }] };
}

function scriptData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function annotatedLayout(graph,manifest,definition,viewLayout) {
  const layout=viewLayout??layoutFor(graph,definition);
  if(manifest?.schemaVersion!==1||manifest.graphDigest!==graph.graphDigest||
      !Array.isArray(manifest.nodeDescriptions)||manifest.nodeDescriptions.length>graph.nodes.length)return layout;
  const nodeIds=new Set(graph.nodes.map(node=>node.id));
  const descriptions=new Map();
  for(const item of manifest.nodeDescriptions) {
    if(!item||!nodeIds.has(item.nodeId)||descriptions.has(item.nodeId)||
        typeof item.text!=='string'||!item.text.trim()||item.text.length>4096)return layout;
    descriptions.set(item.nodeId,item.text);
  }
  return {...layout,nodes:layout.nodes.map(node=>descriptions.has(node.nodeId)
    ?{...node,description:descriptions.get(node.nodeId),descriptionSource:'host'}:node)};
}

async function authorizedManifest({viewManifest,authorizeViewManifest,requestContext,ref}) {
  if(viewManifest&&typeof authorizeViewManifest==='function'&&
      await authorizeViewManifest({requestContext,ref:{...ref},viewManifest})===true)return viewManifest;
}

export function readWorkflowPageData(html) {
  const start = html.indexOf(dataStart);
  const end = html.indexOf('</script>', start + dataStart.length);
  if (start < 0 || end < 0 || start !== html.lastIndexOf(dataStart)) throw new TypeError('Invalid workflow page data');
  return JSON.parse(html.slice(start + dataStart.length, end));
}

/** Assemble the confirmed offline viewer. The caller owns the same-origin confirmation form. */
export function workflowPage({ graph, candidateHash, mermaid, definition, controls = '', runView, viewManifest, viewLayout, executionManifest, pendingSkillDigests, design }) {
  if (!graph?.nodes?.length || typeof graph.graphDigest !== 'string') throw new TypeError('Missing compiled workflow graph');
  const executionBindings = new Map();
  for (const { nodeId, id, label } of executionManifest?.nodeRoles ?? []) executionBindings.set(nodeId, { nodeId, role: { id, label }, skills: [] });
  for (const { nodeId, id, version, digest, source } of executionManifest?.professionalSkills ?? []) {
    const binding = executionBindings.get(nodeId) ?? { nodeId, skills: [] };
    binding.skills.push({ id, version, digest, ...(source ? { source } : {}),
      ...(pendingSkillDigests?.has(digest) ? { pendingApproval: true } : {}) });
    executionBindings.set(nodeId, binding);
  }
  const data = scriptData({ schemaVersion: 1, graph, layout: annotatedLayout(graph,viewManifest,definition,viewLayout),
    ...(candidateHash ? { candidateHash } : {}), ...(typeof mermaid==='string'?{mermaid}:{}), ...(runView ? { runView } : {}),
    ...(design ? { design } : {}),
    ...(executionBindings.size ? { executionBindings: [...executionBindings.values()] } : {}) });
  const html = controls ? shell.replace("form-action 'none'", "form-action 'self'")
    .replace(controlsSlot, () => '<aside id="flowkit-host-controls">' + controls + '</aside>') : shell.replace(controlsSlot, '');
  return html.replace(embeddedData, () => data);
}

async function viewSection(operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code !== 'FK_I_HOST_DENIED') throw error;
    return null;
  }
}

/** Render an observed, authorized Standard invocation without projecting a journal or edges. */
export async function workflowTracePage({candidate,ref,standardTrace,authorizeTrace,requestContext,viewManifest,authorizeViewManifest}) {
  const reject=()=>Object.assign(new Error('Standard trace is not accessible'),{code:'FK_I_HOST_DENIED'});
  if(!ref?.runId||typeof authorizeTrace!=='function'||
      await authorizeTrace({requestContext,ref:{...ref}})!==true)throw reject();
  const graph=checkCandidate(candidate);
  if(graph.mode!=='standard'||ref.candidateHash!==candidate.hash||ref.artifactHash!==graph.artifactHash||
      ref.graphDigest!==graph.graphDigest)throw reject();
  const {status,events}=standardTrace;
  if(!['succeeded','failed','errored','cancelled'].includes(status)||!Array.isArray(events)||events.length>5000)throw reject();
  const nodeIds=new Set(graph.nodes.map(node=>node.id));
  const projected=events.map(event=>{
    if(!event||typeof event!=='object')throw reject();
    const {nodeId,kind,outcome}=event;
    if(!nodeIds.has(nodeId)||!(kind==='start'&&outcome===undefined||
        kind==='end'&&['ok','control','error'].includes(outcome)))throw reject();
    return {nodeId,kind,...(outcome?{outcome}:{})};
  });
  const manifest=await authorizedManifest({requestContext,ref,viewManifest,authorizeViewManifest});
  return workflowPage({graph,candidateHash:candidate.hash,mermaid:candidate.files['workflow.mmd'],viewManifest:manifest,executionManifest:candidate.manifest,
    runView:{type:'standard-trace',status,events:projected,pending:[],artifacts:null}});
}

/** The integrating Host supplies a request-scoped authority. Queries never advance the Run. */
export async function workflowRunPage({ auth, ref, options, candidate, afterRevision = -1, artifactAfter = 0,
  viewManifest, authorizeViewManifest, requestContext }) {
  options = { ...options, graphSnapshot: structuredClone(options.graphSnapshot) };
  const graph=options.graphSnapshot;
  const snapshot = await auth.readRunView(ref, options);
  let candidateHash, mermaid;
  if (candidate || ref.candidateHash) {
    try {
      if (!candidate || candidate.hash!==ref.candidateHash || candidate.manifest?.collectionId!==ref.collectionId ||
        checkCandidate(candidate).graphDigest!==graph.graphDigest) {
        throw new Error('candidate identity differs');
      }
    } catch {
      throw Object.assign(new Error('Viewer candidate does not match the running Program and graph'),{code:'FK_I_PROGRAM_MISMATCH'});
    }
    candidateHash=candidate.hash;
    mermaid=candidate.files['workflow.mmd'];
  }
  const manifest=await authorizedManifest({requestContext,ref,viewManifest,authorizeViewManifest});
  if(afterRevision>snapshot.revision)throw Object.assign(new Error('Viewer cursor exceeds Run revision'),{code:'FK_I_INVALID_TRANSITION'});
  const [events, artifacts] = await Promise.all([
    viewSection(() => auth.listRunViewEvents({ ref, afterRevision }, options)),
    viewSection(() => auth.readRunArtifacts({ ref, after: artifactAfter }, options)),
  ]);
  const page=events?.events.filter(event=>event.revision<=snapshot.revision);
  const cursor=page?.at(-1)?.revision??afterRevision;
  const runPath = '/runs/' + encodeURIComponent(ref.runId);
  const links = ['<a href="' + runPath + '">刷新运行状态</a>'];
  if (events && cursor < snapshot.revision) {
    links.push('<a href="' + runPath + '?afterRevision=' + cursor + '&amp;artifactAfter=' + artifactAfter +
      '">后续事件</a>');
  }
  if (artifacts?.next != null) {
    links.push('<a href="' + runPath + '?afterRevision=' + afterRevision + '&amp;artifactAfter=' + artifacts.next +
      '">更多产物</a>');
  }
  return workflowPage({ graph, candidateHash, mermaid, definition: candidate?.manifest.workflowDefinition, executionManifest: candidate?.manifest,
    controls: links.join(' '), viewManifest:manifest, runView: {
    type:'interactive-journal', revision: snapshot.revision, status: snapshot.status, pauseReason: snapshot.pauseReason,
    pending: snapshot.pending.map(({ nodeId, kind, activation, attempt }) => ({ nodeId, kind, activation, attempt })),
    events: page?.map(({ revision, nodeId, kind, activation, attempt, receiptOutcome }) =>
      ({ revision, nodeId, kind, activation, attempt, receiptOutcome })) ?? null,
    artifacts: artifacts?.items.map(({ artifactId, versionId, nodeId, contentHash, mimeType,
      sizeBytes, latestVersionId, effectiveVersionId }) =>
      ({ artifactId, versionId, nodeId, contentHash, mimeType, sizeBytes, latestVersionId, effectiveVersionId })) ?? null,
  } });
}
