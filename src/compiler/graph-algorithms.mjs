export const EXIT = Symbol('flowkit-exit');

/** Keep adjacency order stable and preserve the original edge objects. */
export function adjacency(ids, edges, reverse = false) {
  const result = new Map(ids.map(id => [id, []]));
  for (const edge of edges) result.get(reverse ? edge.to : edge.from)?.push(edge);
  return result;
}

export function reachableFrom(entry, outgoing) {
  const reached = new Set();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    for (const edge of outgoing.get(id) ?? []) stack.push(edge.to);
  }
  return reached;
}

/** Iterative DFS returns actual cycle-closing edges, without blaming downstream nodes. */
export function findBackEdges(ids, edges) {
  const outgoing = adjacency(ids, edges);
  const colors = new Map();
  const result = [];
  for (const id of ids) {
    if (colors.has(id)) continue;
    colors.set(id, 1);
    const stack = [{ id, index: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      const edge = outgoing.get(frame.id)?.[frame.index++];
      if (!edge) { colors.set(frame.id, 2); stack.pop(); continue; }
      if (colors.get(edge.to) === 1) result.push(edge);
      else if (!colors.has(edge.to)) { colors.set(edge.to, 1); stack.push({ id: edge.to, index: 0 }); }
    }
  }
  return result;
}

/** Bit intersections keep a reversed 500-node declaration order inexpensive. */
export function dominators(ids, edges, entry) {
  const incoming = adjacency(ids, edges, true);
  const bits = new Map(ids.map((id, index) => [id, 1n << BigInt(index)]));
  const all = (1n << BigInt(ids.length)) - 1n;
  const values = new Map(ids.map(id => [id, id === entry ? bits.get(id) : all]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (id === entry) continue;
      const predecessors = incoming.get(id);
      let value = predecessors.length ? all : 0n;
      for (const edge of predecessors) value &= values.get(edge.from);
      value |= bits.get(id);
      if (value !== values.get(id)) { values.set(id, value); changed = true; }
    }
  }
  return new Map(ids.map(id => [id, new Set(ids.filter(other => (values.get(id) & bits.get(other)) !== 0n))]));
}

export function nearestCommonPostDominator(targets, postDominators) {
  if (!targets.length) return null;
  const common = [...postDominators.get(targets[0]) ?? []].filter(id => targets.every(target => postDominators.get(target)?.has(id)));
  common.sort((a, b) => postDominators.get(b).size - postDominators.get(a).size);
  return common[0] ?? null;
}

/** A forward analysis owns its EXIT; it never introduces a public DSL node. */
export function forwardAnalysis(ids, edges, entry) {
  const withExit = [...ids, EXIT];
  const outgoing = adjacency(withExit, edges);
  const degree = new Map(withExit.map(id => [id, 0]));
  for (const edge of edges) degree.set(edge.to, degree.get(edge.to) + 1);
  const ready = withExit.filter(id => degree.get(id) === 0);
  const order = [];
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const edge of outgoing.get(id)) {
      degree.set(edge.to, degree.get(edge.to) - 1);
      if (degree.get(edge.to) === 0) ready.push(edge.to);
    }
  }
  const postDominators = dominators(withExit, edges.map(edge => ({ ...edge, from: edge.to, to: edge.from })), EXIT);
  const immediatePostDominators = new Map(ids.map(id => [id,
    [...postDominators.get(id)].filter(other => other !== id)
      .sort((a, b) => postDominators.get(b).size - postDominators.get(a).size)[0] ?? null]));
  const joins = new Map(ids.map(id => [id, nearestCommonPostDominator(outgoing.get(id).map(edge => edge.to), postDominators)]));
  return { entry, exit: EXIT, ids: withExit, edges, outgoing, topologicalOrder: order, postDominators, immediatePostDominators, joins };
}
