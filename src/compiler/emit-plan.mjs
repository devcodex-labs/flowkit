import { EXIT, forwardAnalysis } from './graph-algorithms.mjs';

class Crossing extends Error {}

export function branchTargets(node) {
  if (node.type === 'condition') return node.branches.map(branch => branch.next);
  if (node.type === 'verification') return [node.onSuccess, node.onFailure];
  if (node.type === 'loop') return [node.onSuccess, node.onMaxExceeded];
  return [];
}

export function nextTarget(node) {
  return node.type === 'parallel' ? node.join.next : node.type === 'human' ? node.onApprove : node.next;
}

/** Freeze traversal choices before printing; a crossing uses static reachable blocks. */
export function createEmitPlan(analysis) {
  const { graph } = analysis;
  const contexts = new Map();
  function context(key, forward, ids, entry, resolve) {
    const allowed = new Set(ids);
    const visited = new Set();
    function sequence(raw, stop) {
      const steps = typeof raw === 'string' ? [{ kind: 'enter', target: raw }] : [];
      let current = resolve(raw);
      while (current !== stop && current !== EXIT) {
        if (!allowed.has(current) || visited.has(current)) throw new Crossing();
        visited.add(current);
        const node = graph.byId.get(current);
        if (branchTargets(node).length) {
          const join = resolve(forward.joins.get(current) ?? EXIT);
          const before = new Set(visited);
          try { steps.push({ kind: 'decision', id: current, branches: branchTargets(node).map(target => sequence(target, join)) }); }
          catch (error) {
            if (!(error instanceof Crossing)) throw error;
            for (const id of [...visited]) if (!before.has(id)) visited.delete(id);
            const members = new Set();
            const pending = [current];
            while (pending.length) {
              const id = pending.pop();
              if (id === join || id === EXIT || members.has(id)) continue;
              if (!allowed.has(id) || before.has(id) && id !== current) throw new Crossing();
              members.add(id);
              const member = graph.byId.get(id);
              const targets = branchTargets(member);
              for (const target of targets.length ? targets : member.type === 'terminal' ? [] : [nextTarget(member)]) pending.push(resolve(target));
            }
            for (const id of members) visited.add(id);
            const crossing = { key: `${key}:${current}`, mode: 'topological', entry: current,
              ids: ids.filter(id => members.has(id)), order: forward.topologicalOrder.filter(id => members.has(id)),
              resolve: target => resolve(target) === join ? EXIT : resolve(target) };
            contexts.set(crossing.key, crossing);
            steps.push({ kind: 'crossing', context: crossing });
          }
          current = join;
        } else {
          steps.push({ kind: 'node', id: current });
          if (node.type === 'terminal') break;
          const target = nextTarget(node);
          if (typeof target === 'string') steps.push({ kind: 'enter', target });
          current = resolve(target);
        }
      }
      return { kind: 'sequence', steps };
    }
    let plan;
    try {
      const body = sequence(entry, EXIT);
      if (visited.size !== allowed.size) throw new Crossing();
      plan = { key, mode: 'structured', entry, body, ids, resolve };
    } catch (error) {
      if (!(error instanceof Crossing)) throw error;
      plan = { key, mode: 'topological', entry, ids,
        order: forward.topologicalOrder.filter(id => allowed.has(id)), resolve };
    }
    contexts.set(key, plan);
    return plan;
  }
  const rootIds = graph.forward.ids.filter(id => typeof id === 'string');
  // Action failure skips the verification call, but still enters its one printed decision block.
  const forward = graph.forward.edges.some(edge => edge.role === 'action-failure')
    ? forwardAnalysis(rootIds, graph.forward.edges.filter(edge => edge.role !== 'action-failure'), graph.forward.entry) : graph.forward;
  const root = context('root', forward, rootIds, graph.forward.entryTarget,
    id => typeof id === 'string' ? graph.owners.get(id) ?? id : EXIT);
  for (const region of graph.regions.values()) if (region.kind === 'loop') {
    const ids = analysis.literal.definition.nodes.filter(node => region.members.has(node.id) && node.id !== region.body).map(node => node.id);
    context(region.id, region.forward, ids, graph.byId.get(region.body).onFailure,
      id => id === region.body || !region.members.has(id) ? EXIT : id);
  }
  return { root, contexts, layouts: [...contexts.values()].map(({ key, mode }) => ({ key, mode })) };
}
