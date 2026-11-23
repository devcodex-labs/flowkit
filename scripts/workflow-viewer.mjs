import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { artifactDigest } from '../src/shared/artifact-identity.mjs';

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

function layoutFor(graph) {
  if (graph.graphDigest === reference.graphDigest) return reference.layout;
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

export function readWorkflowPageData(html) {
  const start = html.indexOf(dataStart);
  const end = html.indexOf('</script>', start + dataStart.length);
  if (start < 0 || end < 0 || start !== html.lastIndexOf(dataStart)) throw new TypeError('Invalid workflow page data');
  return JSON.parse(html.slice(start + dataStart.length, end));
}

/** Assemble the confirmed offline viewer. The caller owns the same-origin confirmation form. */
export function workflowPage({ graph, candidateHash, controls = '', runView }) {
  if (!graph?.nodes?.length || typeof graph.graphDigest !== 'string') throw new TypeError('Missing compiled workflow graph');
  const data = scriptData({ schemaVersion: 1, graph, layout: layoutFor(graph),
    ...(candidateHash ? { candidateHash } : {}), ...(runView ? { runView } : {}) });
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

/** The integrating Host supplies a request-scoped authority. Queries never advance the Run. */
export async function workflowRunPage({ auth, ref, options, afterRevision = -1, artifactAfter = 0 }) {
  options = { ...options, graphSnapshot: structuredClone(options.graphSnapshot) };
  const [events, artifacts] = await Promise.all([
    viewSection(() => auth.listRunViewEvents({ ref, afterRevision }, options)),
    viewSection(() => auth.readRunArtifacts({ ref, after: artifactAfter }, options)),
  ]);
  const snapshot = await auth.readRunView(ref, options);
  const runPath = '/runs/' + encodeURIComponent(ref.runId);
  const links = ['<a href="' + runPath + '">刷新运行状态</a>'];
  if (events && events.cursor < events.headRevision) {
    links.push('<a href="' + runPath + '?afterRevision=' + events.cursor + '&amp;artifactAfter=' + artifactAfter +
      '">后续事件</a>');
  }
  if (artifacts?.next != null) {
    links.push('<a href="' + runPath + '?afterRevision=' + afterRevision + '&amp;artifactAfter=' + artifacts.next +
      '">更多产物</a>');
  }
  return workflowPage({ graph: options.graphSnapshot, candidateHash: ref.candidateHash, controls: links.join(' '), runView: {
    revision: snapshot.revision, status: snapshot.status, pauseReason: snapshot.pauseReason,
    pending: snapshot.pending.map(({ nodeId, kind, attempt }) => ({ nodeId, kind, attempt })),
    events: events?.events.map(({ revision, nodeId, kind, receiptOutcome }) => ({ revision, nodeId, kind, receiptOutcome })) ?? null,
    artifacts: artifacts?.items.map(({ artifactId, versionId, nodeId, contentHash, mimeType,
      sizeBytes, latestVersionId, effectiveVersionId }) =>
      ({ artifactId, versionId, nodeId, contentHash, mimeType, sizeBytes, latestVersionId, effectiveVersionId })) ?? null,
  } });
}
