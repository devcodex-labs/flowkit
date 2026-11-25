import { isWorkflowId, isWorkflowNodeName } from '../../src/shared/contracts.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { graphContentHash } from '../../src/compiler/graph-snapshot.mjs';
import { mermaidLabel } from '../../src/compiler/mermaid.mjs';

const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const bad = detail => Object.assign(new TypeError(detail), { code: 'FKA_DESIGN_SECTION_INVALID' });

/** A design diagram does not create executable nodes, a Program or a Run reference. */
export function designDiagram(title, materials, proposal) {
  const sources = materials.map(({ id, title, content }) => ({ id, title, digest: artifactDigest(content) }));
  const sourceIds = new Set(sources.map(source => source.id));
  const referenced = refs => Array.isArray(refs) && refs.length > 0 && new Set(refs).size === refs.length && refs.every(id => sourceIds.has(id));
  const { schemaVersion, nodes, edges, unresolved } = proposal ?? {};
  if (schemaVersion !== 1 || !Array.isArray(nodes) || nodes.length < 1 ||
      !Array.isArray(edges) || !Array.isArray(unresolved)) throw bad('Design diagram requires nodes, edges and unresolved arrays with at least one node');
  const invalidNode = nodes.findIndex(node => !isWorkflowId(node?.id) || !isWorkflowNodeName(node.name) ||
    !text(node.description, 1_000) || !referenced(node.sources));
  if (invalidNode >= 0) {
    const node = nodes[invalidNode];
    const reason = !isWorkflowId(node?.id) ? 'id must be a lowercase kebab-case ID of at most 64 characters' :
      !isWorkflowNodeName(node.name) ? 'name must fit within 40 characters with no quote, backtick, backslash, newline or comment terminator' :
      !text(node.description, 1_000) ? 'description must be nonblank and fit within 1000 characters' :
      'sources must list distinct supplied material IDs';
    throw bad(`nodes[${invalidNode}].${reason}`);
  }
  const invalidGap = unresolved.findIndex(gap => !text(gap?.question, 500) || !referenced(gap.sources));
  if (invalidGap >= 0) throw bad(`unresolved[${invalidGap}] requires a question and distinct supplied source references`);
  const identities = new Set(nodes.map(({ id }) => id));
  if (identities.size !== nodes.length) throw bad('nodes[].id must be unique inside the design section');
  const invalidEdge = edges.findIndex(edge => !identities.has(edge?.from) || !identities.has(edge.to) ||
    !text(edge.description, 240) || edge.sources !== undefined && !referenced(edge.sources));
  if (invalidEdge >= 0) throw bad(`edges[${invalidEdge}] must use local from/to IDs, a nonblank description up to 240 characters and supplied source references`);
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const relationships = new Map();
  for (const { from, to, description, sources = byNode.get(from).sources } of edges) {
    const edgeId = artifactDigest(JSON.stringify([from, to, description]));
    const edge = relationships.get(edgeId) ?? { edgeId, from, to, description, sources: [] };
    edge.sources = [...new Set([...edge.sources, ...sources])];
    relationships.set(edgeId, edge);
  }
  const links = [...relationships.values()];
  const design = { sources, nodeSources: nodes.map(({ id, sources, key }) => ({ id, sources, ...(key ? { key } : {}) })),
    edgeSources: links.map(({ edgeId, sources }) => ({ edgeId, sources })),
    unresolved: unresolved.map(({ question, sources }) => ({ question, sources })) };
  const identity = artifactDigest(JSON.stringify([title, design, nodes, links]));
  const graph = { schemaVersion: 1, mode: 'design', workflowId: 'design-' + identity.slice(7, 23), workflowVersion: '设计图', name: title,
    entryNodeId: nodes[0].id, regions: [], contract: {}, executionEdges: [],
    nodes: nodes.map(({ id, name }) => ({ id, name, type: 'design', ownerIds: [], inputs: [], outputs: [] })),
    referenceEdges: links.map(({ from, to, description, edgeId }) => ({ from, to, role: 'next', origin: 'declared', condition: description, edgeId })) };
  graph.graphDigest = graphContentHash(graph);
  const anchors = new Map(nodes.map(({ id }, i) => [id, 'Design' + i]));
  const line = value => mermaidLabel(value.replace(/\s+/g, ' '));
  const mermaid = ['flowchart TD', ...nodes.map(({ id, name }) => `  ${anchors.get(id)}[${line(name)}]`),
    ...links.map(({ from, to, description }) => `  ${anchors.get(from)} -->|${line(description)}| ${anchors.get(to)}`)].join('\n') + '\n';
  return { identity, graph, design, mermaid, viewManifest: { schemaVersion: 1, graphDigest: graph.graphDigest,
    nodeDescriptions: nodes.map(({ id, description }) => ({ nodeId: id, text: description })) } };
}
