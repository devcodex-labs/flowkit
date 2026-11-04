import { diagnostic } from './source.mjs';
import { declaredWrites } from './dataflow.mjs';
import { EXIT, adjacency, reachableFrom, findBackEdges, dominators, forwardAnalysis } from './graph-algorithms.mjs';

const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.role, edge.path]);

/** Build reference, execution and folded graphs separately; they have different edge semantics. */
export function analyzeGraph(literal, context) {
  const nodes = literal.definition.nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ids = [...byId.keys()];
  const diagnostics = [];
  const indices = new Map(ids.map((id, index) => [id, index]));
  const edges = [];
  const regions = new Map();
  const owners = new Map();
  const parallelOwners = new Map();
  const loops = new Map(nodes.filter(node => node.type === 'loop').map(node => [node.id, node]));
  const loopBodies = new Set([...loops.values()].map(node => node.body));
  const report = (code, id, path, message) => {
    const pointer = `/nodes/${indices.get(id)}`;
    diagnostics.push(diagnostic(context.source, code, message, literal.locations.get(pointer + path) ?? literal.locations.get(pointer), id));
  };
  const add = (node, target, role, path) => {
    if (target === undefined) return;
    edges.push({ from: node.id, to: target, role, path });
    if (!byId.has(target)) report('FK_C015', node.id, path, `Unknown referenced node: ${target}`);
  };
  for (const node of nodes) {
    if (['agent', 'action'].includes(node.type)) add(node, node.next, 'next', '/next');
    else if (node.type === 'verification') {
      add(node, node.onSuccess, 'verification-success', '/onSuccess'); add(node, node.onFailure, 'verification-failure', '/onFailure');
    } else if (node.type === 'condition') node.branches.forEach((branch, index) => add(node, branch.next, 'condition-branch', `/branches/${index}/next`));
    else if (node.type === 'parallel') {
      node.branches.forEach((id, index) => add(node, id, 'parallel-member', `/branches/${index}`));
      add(node, node.join.next, 'parallel-join', '/join/next');
    } else if (node.type === 'loop') {
      add(node, node.body, 'loop-body', '/body'); add(node, node.onSuccess, 'loop-success', '/onSuccess'); add(node, node.onMaxExceeded, 'loop-exhausted', '/onMaxExceeded');
    } else if (node.type === 'human') {
      add(node, node.onApprove, 'human-approve', '/onApprove'); add(node, node.onReject, 'human-reject', '/onReject');
    }
  }
  if (diagnostics.length) return { graph: null, diagnostics };
  const reached = reachableFrom(ids[0], adjacency(ids, edges));
  for (const id of ids) if (!reached.has(id)) report('FK_C017', id, '/id', 'Node is unreachable from the first declaration');
  function own(region, id, code) {
    if (owners.has(id) && owners.get(id) !== region.id) report(code, region.id, '', `Node ${id} belongs to multiple regions`);
    else owners.set(id, region.id);
    region.members.add(id);
  }
  for (const node of nodes.filter(node => node.type === 'parallel')) {
    const region = { id: node.id, kind: 'parallel', members: new Set(), backEdges: new Set() };
    regions.set(node.id, region);
    node.branches.forEach((id, index) => {
      if (!['agent', 'action', 'verification'].includes(byId.get(id).type)) report('FK_C022', node.id, `/branches/${index}`, 'Invalid parallel member type');
      if (parallelOwners.has(id)) report('FK_C024', node.id, `/branches/${index}`, 'Parallel members must have a single occurrence and owner');
      parallelOwners.set(id, node.id); own(region, id, 'FK_C024');
    });
  }
  for (const edge of edges) if (parallelOwners.has(edge.to) &&
    !(edge.role === 'parallel-member' && parallelOwners.get(edge.to) === edge.from)) {
    report('FK_C024', edge.from, edge.path, 'Parallel member referenced outside its owner');
  }

  function repairRegion(node, kind, start, stop) {
    const region = { id: node.id, kind, members: new Set(), backEdges: new Set(), body: kind === 'loop' ? stop : undefined };
    regions.set(node.id, region);
    if (kind === 'loop') own(region, stop, 'FK_C042');
    const stack = [edges.find(edge => edge.from === (kind === 'loop' ? stop : node.id) &&
      edge.role === (kind === 'loop' ? 'verification-failure' : 'human-reject'))];
    const repair = new Set();
    while (stack.length) {
      const item = stack.pop();
      if (item.to === stop) { region.backEdges.add(edgeKey(item)); continue; }
      if (repair.has(item.to)) continue;
      const current = byId.get(item.to);
      if (kind === 'loop' && item.to === node.id) { report('FK_C047', item.from, '', 'Repair must return to the body, not the loop container'); continue; }
      const allowed = kind === 'loop' ? ['agent', 'action', 'condition'] : ['agent', 'action'];
      if (!allowed.includes(current.type)) {
        const code = kind === 'human' ? 'FK_C061' : current.type === 'parallel' ? 'FK_C043'
          : current.type === 'loop' ? 'FK_C045' : current.type === 'human' ? 'FK_C046' : 'FK_C042';
        report(code, current.id, '', `Invalid ${kind} repair member: ${current.type}`); continue;
      }
      repair.add(current.id); own(region, current.id, kind === 'loop' ? 'FK_C042' : 'FK_C060');
      for (const edge of edges.filter(edge => edge.from === current.id)) stack.push(edge);
    }
    // Every repair path must terminate at the agreed return, including condition alternatives.
    const returning = new Set([stop]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of repair) if (!returning.has(id)) {
        const successors = edges.filter(edge => edge.from === id);
        if (successors.length && successors.every(edge => returning.has(edge.to))) { returning.add(id); changed = true; }
      }
    }
    if (!returning.has(start) || [...repair].some(id => !returning.has(id))) report(kind === 'loop' ? 'FK_C042' : 'FK_C060', node.id,
      kind === 'loop' ? '/body' : '/onReject', 'Every repair path must return to its owner');
    return region;
  }
  for (const node of loops.values()) {
    const body = byId.get(node.body);
    if (body.type !== 'verification') { report('FK_C041', node.id, '/body', 'Loop body must be a verification'); continue; }
    if (body.onSuccess !== node.id) report('FK_C042', body.id, '/onSuccess', 'Loop body success must return to its loop');
    if (body.onFailure === body.id) report('FK_C042', body.id, '/onFailure', 'Loop failure must enter its repair chain');
    repairRegion(node, 'loop', body.onFailure, body.id);
  }
  for (const node of nodes.filter(node => node.type === 'human')) repairRegion(node, 'human', node.onReject, node.id);

  for (const edge of edges) {
    const owner = owners.get(edge.to);
    if (owner && owners.get(edge.from) !== owner && edge.from !== owner) {
      const region = regions.get(owner);
      const code = region.kind === 'parallel' ? 'FK_C024'
        : byId.get(edge.from).type === 'action' ? 'FK_C044' : 'FK_C042';
      // Parallel diagnostics were already emitted with the explicit reference check.
      if (region.kind === 'loop') report(code, edge.from, edge.path, 'Reference enters the interior of another region');
    }
    if (loops.has(edge.to)) {
      const target = regions.get(edge.to);
      const pass = target?.body === edge.from && edge.role === 'verification-success';
      if (!pass && owners.has(edge.from)) report('FK_C047', edge.from, edge.path, 'Illegal loop container reference from a region');
    }
  }
  if (owners.has(ids[0]) && regions.get(owners.get(ids[0])).kind !== 'human') {
    report(regions.get(owners.get(ids[0])).kind === 'parallel' ? 'FK_C024' : 'FK_C042', ids[0], '/id', 'Workflow entry cannot be an interior region member');
  }
  // A repair return may be shared, but normal approval/success/exhaustion cannot use it to loop.
  for (const region of regions.values()) {
    const node = byId.get(region.id);
    const exits = region.kind === 'human' ? ['onApprove'] : region.kind === 'loop' ? ['onSuccess', 'onMaxExceeded'] : [];
    for (const field of exits) if (node[field] === region.id || region.members.has(node[field])) {
      report('FK_C080', region.id, `/${field}`, 'Region exit cannot re-enter its own body or repair chain');
    }
  }
  const writeSets = declaredWrites(nodes, parallelOwners);
  for (const node of nodes.filter(node => node.type === 'parallel')) {
    const written = new Set();
    node.branches.forEach((id, index) => {
      for (const key of writeSets.get(id)) {
        if (written.has(key)) report('FK_C026', node.id, `/branches/${index}`, `Parallel branches both declare key ${key}`);
        written.add(key);
      }
    });
  }
  for (const node of nodes.filter(node => node.type === 'human')) {
    if (nodes.some(other => other.id !== node.id && writeSets.get(other.id).has(node.id))) report('FK_C026', node.id, '/id', 'Human id conflicts with another declared write key');
  }
  if (diagnostics.length) return { graph: null, diagnostics };

  const executionEdges = [];
  const legalBackEdges = new Set([...regions.values()].flatMap(region => [...region.backEdges]));
  for (const edge of edges) {
    if (['loop-success', 'loop-exhausted', 'parallel-join'].includes(edge.role)) continue;
    const owner = owners.get(edge.from);
    if (owner && regions.get(owner).kind === 'loop' && regions.get(owner).body === edge.from) {
      const loop = byId.get(owner);
      if (edge.role === 'verification-success') executionEdges.push({ ...edge, to: loop.onSuccess, role: 'loop-pass' });
      else {
        executionEdges.push({ ...edge, role: 'loop-repair' });
        executionEdges.push({ ...edge, to: loop.onMaxExceeded, role: 'loop-exhausted' });
      }
    } else executionEdges.push({ ...edge, role: legalBackEdges.has(edgeKey(edge)) ? 'repair-return' : edge.role });
  }
  for (const [id, owner] of parallelOwners) executionEdges.push({ from: id, to: byId.get(owner).join.next, role: 'parallel-return', path: '' });
  for (const node of nodes.filter(node => node.type === 'action' && node.next && !loopBodies.has(node.next))) {
    const next = byId.get(node.next);
    if (next.type === 'verification' && !parallelOwners.has(next.id)) executionEdges.push({ from: node.id, to: next.onFailure, role: 'action-failure', path: '/next' });
  }
  const acyclic = executionEdges.filter(edge => edge.role !== 'repair-return');
  for (const edge of findBackEdges(ids, acyclic)) report('FK_C080', edge.from, edge.path, 'Cycle is not an agreed repair return');
  if (diagnostics.length) return { graph: null, diagnostics };

  const outgoing = adjacency(ids, executionEdges);
  const domination = dominators(ids, executionEdges, ids[0]);
  const rootIds = ids.filter(id => !owners.has(id));
  const representative = id => owners.get(id) ?? id;
  // Retain the actual target so folding a human never skips a valid initial repair prefix.
  const foldedEdges = executionEdges.map(edge => ({ ...edge, sourceNode: edge.from, targetNode: edge.to,
    from: representative(edge.from), to: representative(edge.to) }))
    .filter(edge => edge.from !== edge.to);
  for (const edge of findBackEdges(rootIds, foldedEdges)) report('FK_C080', edge.sourceNode, edge.path, 'Cycle crosses region boundaries');
  if (diagnostics.length) return { graph: null, diagnostics };
  for (const node of nodes.filter(node => node.type === 'terminal')) foldedEdges.push({ from: node.id, to: EXIT, role: 'exit', path: '' });
  const forward = { ...forwardAnalysis(rootIds, foldedEdges, representative(ids[0])), entryTarget: ids[0] };
  for (const region of regions.values()) {
    const localIds = [region.id, ...region.members];
    const localSet = new Set(localIds);
    const localEdges = executionEdges.filter(edge => localSet.has(edge.from)).map(edge => ({ ...edge,
      sourceNode: edge.from, targetNode: edge.to, to: localSet.has(edge.to) ? edge.to : EXIT }));
    region.entryTargets = new Set([region.id, ...executionEdges.filter(edge => !localSet.has(edge.from) && localSet.has(edge.to)).map(edge => edge.to)]);
    if (localSet.has(ids[0])) region.entryTargets.add(ids[0]);
    region.entryForwards = new Map();
    for (const entry of region.entryTargets) {
      // Human repair prefixes may be entered before the first approval. Each entry has its own iteration cut.
      const cuts = region.kind === 'human' ? new Set(findBackEdges([entry, ...localIds.filter(id => id !== entry)], localEdges).map(edgeKey)) : null;
      const iterationEdges = localEdges.map(edge => ({ ...edge,
        to: cuts ? cuts.has(edgeKey(edge)) ? EXIT : edge.to : edge.role === 'repair-return' ? EXIT : edge.to }));
      region.entryForwards.set(entry, forwardAnalysis(localIds, iterationEdges, entry));
    }
    region.forward = region.entryForwards.get(region.id);
  }
  return { graph: { byId, referenceEdges: edges, executionEdges, outgoing, incoming: adjacency(ids, executionEdges, true),
    regions, owners, parallelOwners, legalBackEdges, writeSets, dominators: domination, forward }, diagnostics };
}
