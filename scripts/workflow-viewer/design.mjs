import { isWorkflowId, isWorkflowNodeName } from '../../src/shared/contracts.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { graphContentHash } from '../../src/compiler/graph-snapshot.mjs';
import { mermaidLabel } from '../../src/compiler/mermaid.mjs';

const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
const bad = () => new TypeError('Design diagram needs bounded steps and relationships, with references to the supplied materials');

/** A design diagram does not create executable nodes, a Program or a Run reference. */
export function designDiagram(title, materials, proposal) {
  const sources = materials.map(({ id, title, content }) => ({ id, title, digest: artifactDigest(content) }));
  const sourceIds = new Set(sources.map(source => source.id));
  const referenced = refs => Array.isArray(refs) && refs.length > 0 && new Set(refs).size === refs.length && refs.every(id => sourceIds.has(id));
  const { schemaVersion, nodes, edges, unresolved } = proposal ?? {};
  if (schemaVersion !== 1 || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 40 ||
      !Array.isArray(edges) || edges.length > 120 || !Array.isArray(unresolved) || unresolved.length > 20 ||
      nodes.some(node => !isWorkflowId(node?.id) || !isWorkflowNodeName(node.name) || !text(node.description, 1000) || !referenced(node.sources)) ||
      unresolved.some(gap => !text(gap?.question, 500) || !referenced(gap.sources))) throw bad();
  const identities = new Set(nodes.map(({ id }) => id));
  if (identities.size !== nodes.length || edges.some(e => !identities.has(e?.from) || !identities.has(e.to) ||
      e.from === e.to || !text(e.description, 240)) ||
      new Set(edges.map(({ from, to }) => JSON.stringify([from, to]))).size !== edges.length) throw bad();
  const design = { sources, nodeSources: nodes.map(({ id, sources }) => ({ id, sources })),
    unresolved: unresolved.map(({ question, sources }) => ({ question, sources })) };
  const identity = artifactDigest(JSON.stringify([title, design, nodes, edges]));
  const graph = { schemaVersion: 1, mode: 'design', workflowId: 'design-' + identity.slice(7, 23), workflowVersion: '设计图', name: title,
    entryNodeId: nodes[0].id, regions: [], contract: {}, executionEdges: [],
    nodes: nodes.map(({ id, name }) => ({ id, name, type: 'design', ownerIds: [], inputs: [], outputs: [] })),
    referenceEdges: edges.map(({ from, to, description }) => ({ from, to, role: 'next', origin: 'declared', condition: description,
      edgeId: artifactDigest(JSON.stringify([from, to, description])) })) };
  graph.graphDigest = graphContentHash(graph);
  const anchors = new Map(nodes.map(({ id }, i) => [id, 'Design' + i]));
  const line = value => mermaidLabel(value.replace(/\s+/g, ' '));
  const mermaid = ['flowchart TD', ...nodes.map(({ id, name }) => `  ${anchors.get(id)}[${line(name)}]`),
    ...edges.map(({ from, to, description }) => `  ${anchors.get(from)} -->|${line(description)}| ${anchors.get(to)}`)].join('\n') + '\n';
  return { identity, graph, design, mermaid, viewManifest: { schemaVersion: 1, graphDigest: graph.graphDigest,
    nodeDescriptions: nodes.map(({ id, description }) => ({ nodeId: id, text: description })) } };
}
