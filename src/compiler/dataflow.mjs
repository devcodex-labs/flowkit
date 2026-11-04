import { diagnostic } from './source.mjs';

/** Own declared keys only; no prototype-sensitive object is used as a key dictionary. */
export function declaredWrites(nodes, parallelOwners) {
  return new Map(nodes.map(node => [node.id, new Set(node.type === 'agent' ? Object.keys(node.output.properties ?? {})
    : node.type === 'action' ? node.writes ?? []
    : node.type === 'human' || node.type === 'verification' && parallelOwners.has(node.id) ? [node.id] : [])]));
}

/** A may-written fixed point warns only when every reaching path lacks a declared key. */
export function analyzeDataflow(graph, literal, context) {
  const ids = [...graph.byId.keys()];
  const inputs = new Map(ids.map(id => [id, new Set()]));
  const outputs = new Map(ids.map(id => [id, new Set(graph.writeSets.get(id))]));
  const pending = [...ids];
  const queued = new Set(ids);
  while (pending.length) {
    const id = pending.shift(); queued.delete(id);
    const output = outputs.get(id);
    for (const key of inputs.get(id)) output.add(key);
    for (const edge of graph.outgoing.get(id)) {
      const target = inputs.get(edge.to);
      const before = target.size;
      for (const key of output) target.add(key);
      if (target.size !== before && !queued.has(edge.to)) { pending.push(edge.to); queued.add(edge.to); }
    }
  }
  const declared = new Set([...graph.writeSets.values()].flatMap(keys => [...keys]));
  const diagnostics = [];
  literal.definition.nodes.forEach((node, index) => {
    if (node.type !== 'agent') return;
    (node.inputs ?? []).forEach((key, inputIndex) => {
      if (declared.has(key) && !inputs.get(node.id).has(key)) diagnostics.push(diagnostic(context.source, 'FK_C053',
        `Declared input ${key} has no writer on any reaching path`, literal.locations.get(`/nodes/${index}/inputs/${inputIndex}`), node.id));
    });
  });
  return { inputs, outputs, declared, diagnostics };
}
