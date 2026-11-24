import { readFileSync } from 'node:fs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { ports, routeEdges } from './layout-routes.mjs';

const guide = readFileSync(new URL('./layout-skill.md', import.meta.url), 'utf8');
const schemaVersion = 1;
const limits = Object.freeze({ compact: 60, nodes: 360, edges: 900, phases: 12, depth: 8, requests: 30, colGap: 58, rowGap: 52 });
export const layoutSkillHash = artifactDigest(guide);
export const layoutContractHash = artifactDigest(JSON.stringify([schemaVersion, limits, layoutSkillHash]));
const directions = ['LR', 'RL', 'TB', 'BT'];
const safeId = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const validId = value => typeof value === 'string' && safeId.test(value);
const validTitle = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 64;
const uniqueMap = (items, key) => new Map(items.map(item => [item[key], item]));
const setContains = (a, b) => [...b].every(id => a.has(id));
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const validCell = (p, max) => Number.isInteger(p.col) && Number.isInteger(p.row) &&
  p.col >= 0 && p.row >= 0 && p.col < max && p.row < max;
const color = '#64748b';
const boundedArray = (value, size) => Array.isArray(value) && value.length <= size;
const parseReply = text => JSON.parse(text.trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/g, ''));

function bounds(items, xPad, top, bottom = xPad) {
  const x = Math.min(...items.map(n => n.x)) - xPad, y = Math.min(...items.map(n => n.y)) - top;
  return { x, y, w: Math.max(...items.map(n => n.x + n.w)) + xPad - x,
    h: Math.max(...items.map(n => n.y + n.h)) + bottom - y };
}

function project(graph, base) {
  const nodes = uniqueMap(base.nodes, 'id');
  const byNodeId = new Map();
  for (const n of base.nodes) {
    if (!byNodeId.has(n.nodeId)) byNodeId.set(n.nodeId, []);
    byNodeId.get(n.nodeId).push(n.id);
  }
  const refs = uniqueMap(graph.referenceEdges, 'edgeId');
  const specs = uniqueMap(graph.nodes, 'id');
  const original = [...graph.regions].map(r => ({
    ownerId: r.ownerId, id: byNodeId.get(r.ownerId)[0], kind: r.kind,
    title: specs.get(r.ownerId).name + (r.joinStrategy ? ' · ' + r.joinStrategy : ''),
    members: new Set([...new Set([r.ownerId, ...r.memberIds])].flatMap(id => byNodeId.get(id))),
    ...(r.lanes ? { strategy: r.joinStrategy, lanes: r.lanes.map(lane => ({
      entry: byNodeId.get(lane.entry)[0], members: lane.memberIds.flatMap(id => byNodeId.get(id))
    })) } : {})
  })).sort((a, b) => a.members.size - b.members.size);
  const edges = base.edges.map(e => {
    const edge = refs.get(e.edgeId);
    const innermostJoin = graph.regions.filter(r => r.kind === 'parallel' && r.memberIds.includes(edge.from) &&
      r.normalExits.includes(edge.to)).sort((a, b) => a.memberIds.length - b.memberIds.length)[0];
    const target = innermostJoin && e.kind !== 'error' ? byNodeId.get(innermostJoin.ownerId)[1] : e.target;
    return { ...e, target, role: edge.role, origin: edge.origin };
  });
  for (const edge of graph.executionEdges.filter(e => e.origin === 'derived')) {
    edges.push({ id: 'e' + edges.length, edgeId: edge.edgeId, source: byNodeId.get(edge.from)[0],
      target: byNodeId.get(edge.to)[0], role: edge.role, origin: edge.origin,
      kind: ['action-failure', 'loop-exhausted'].includes(edge.role) ? 'error' :
        ['loop-repair', 'repair-return'].includes(edge.role) ? 'loop' : 'normal',
      label: edge.role === 'action-failure' ? '技术异常（派生）' : '', dashed: edge.role === 'action-failure' });
  }
  for (const e of edges) {
    if (['loop-continue', 'human-reject'].includes(e.role)) e.kind = 'loop';
  }
  const modelNodes = base.nodes.map(({ id, nodeId, helper, w, h }) => ({
    id, type: helper ?? specs.get(nodeId).type, label: String(specs.get(nodeId).name ?? nodeId).slice(0, 120), w, h
  }));
  return { nodes, edges, original, modelNodes, entry: byNodeId.get(graph.entryNodeId)[0] };
}

function framesFor(nodes, definitions) {
  const rowSpans = definitions.map(p => {
    const cards = nodes.filter(n => n.phase === p.id);
    return { id: p.id, first: Math.min(...cards.map(n => n.row)), last: Math.max(...cards.map(n => n.row)) };
  }).sort((a, b) => a.first - b.first);
  const stacked = rowSpans.every((p, i) => i === 0 || rowSpans[i - 1].last < p.first);
  const yGap = new Map(rowSpans.map((p, i) => [p.id, stacked ? i * 76 : 0]));
  const w = Math.max(...nodes.map(n => n.w)), h = Math.max(...nodes.map(n => n.h));
  const placed = nodes.map(({ col, row, ...n }) => ({ ...n,
    x: 30 + col * (w + limits.colGap) + (w - n.w) / 2,
    y: 90 + row * (h + limits.rowGap) + (h - n.h) / 2 + yGap.get(n.phase) }));
  const phases = definitions.map(p => ({ ...p, color, ...bounds(placed.filter(n => n.phase === p.id), 24, 86, 21) }));
  if (phases.some((p, i) => phases.slice(i + 1).some(q => overlap(p, q)))) {
    throw new Error('Phase frames overlap; keep each phase in its own rectangle');
  }
  return { nodes: placed, phases };
}

function groupFrames(nodes, groups, validateOnly = false) {
  const built = [];
  for (const group of groups) {
    const cards = nodes.filter(n => group.members.has(n.id));
    const children = built.filter(child => child.group.members.size < group.members.size &&
      setContains(group.members, child.group.members)).map(c => c.box);
    const box = bounds([...cards, ...children], 13, 27, 13);
    const foreign = nodes.filter(n => !group.members.has(n.id) && overlap(n, box));
    if (foreign.length) throw new Error('Group ' + group.id + ' contains unrelated ' + foreign.map(n => n.id).join(', '));
    built.push({ group, box: { ownerId: group.ownerId, phase: cards.find(n => n.id === group.id).phase,
      title: group.title, ...box } });
  }
  return validateOnly ? undefined : built.map(c => c.box);
}

function readHints(rows, allowed) {
  if (!boundedArray(rows, limits.edges)) throw new Error('Invalid routes array');
  const hints = new Map();
  const duplicates = new Set();
  // Hints refine geometry. They cannot introduce an edge or replace an inherited port.
  for (const p of rows) {
    if (!p || !allowed.has(p.id) || !ports.includes(p.sourcePort) || !ports.includes(p.targetPort) || duplicates.has(p.id)) continue;
    if (hints.has(p.id)) {
      hints.delete(p.id);
      duplicates.add(p.id);
    } else {
      hints.set(p.id, { sourcePort: p.sourcePort, targetPort: p.targetPort });
    }
  }
  return hints;
}

function makeUnits(ids, groups) {
  // Keep complete original groups atomic in the parent's region plan. The child call can open them.
  const partitioned = [];
  for (const group of [...groups].reverse()) {
    if (group.members.size >= ids.size || partitioned.some(unit => setContains(unit.members, group.members))) continue;
    const intersections = partitioned.filter(unit => [...group.members].some(id => unit.members.has(id)));
    const members = new Set([...group.members, ...intersections.flatMap(unit => [...unit.members])]);
    if (members.size >= ids.size) continue;
    for (const unit of intersections) partitioned.splice(partitioned.indexOf(unit), 1);
    partitioned.push({ id: group.id, members });
  }
  const taken = new Set(partitioned.flatMap(unit => [...unit.members]));
  for (const id of ids) if (!taken.has(id)) partitioned.push({ id, members: new Set([id]) });
  return partitioned;
}

function mergeRegions(children) {
  const extent = (child, key) => Math.max(...child.layout.phases.map(p => key === 'col' ? p.x + p.w : p.y + p.h));
  const offsets = key => {
    const indices = [...new Set(children.map(child => child.region[key]))].sort((a, b) => a - b);
    let offset = 0;
    return new Map(indices.map(index => {
      const position = offset;
      offset += Math.max(...children.filter(child => child.region[key] === index).map(child => extent(child, key))) + 84;
      return [index, position];
    }));
  };
  const xs = offsets('col'), ys = offsets('row');
  const nodes = [], phases = [];
  for (const { region, layout } of children) {
    const phase = region.id;
    const move = n => ({ ...n, x: n.x + xs.get(region.col) + 24, y: n.y + ys.get(region.row) + 26 });
    const parts = layout.nodes.map(n => ({ ...move(n), phase }));
    nodes.push(...parts);
    phases.push({ id: phase, title: region.title, direction: region.direction, color, ...bounds(parts, 26, 88, 24) });
  }
  return { nodes, phases };
}

/** The only model outputs we adopt are validated visual positions and port hints. */
export async function generateLayout(graph, base, model, signal) {
  if (base.nodes.length > limits.nodes || graph.referenceEdges.length + graph.executionEdges.length > limits.edges * 2) {
    return { reason: 'graph-limit', receipts: [] };
  }
  const projection = project(graph, base);
  if (projection.edges.length > limits.edges) return { reason: 'graph-limit', receipts: [] };
  const receipts = [];
  let requested = 0;
  async function query(task, input, validate) {
    let feedback;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      if (++requested > limits.requests) throw new Error('Layout request budget exhausted');
      let receipt;
      try {
        const payload = { schemaVersion, graphDigest: graph.graphDigest, task,
          grid: { columnGap: limits.colGap, rowGap: limits.rowGap, maxPhases: limits.phases },
          ...input, ...(feedback ? { feedback } : {}) };
        const response = await model({ guide, input: payload, signal });
        receipt = { task, inputHash: artifactDigest(JSON.stringify(payload)),
          responseHash: artifactDigest(response.text), provider: response.provider, model: response.model,
          ...(response.requestId ? { requestId: response.requestId } : {}) };
        receipts.push(receipt);
        if (!response.text || Buffer.byteLength(response.text) > 192 * 1024) throw new Error('Layout output exceeds its bounds');
        const result = parseReply(response.text);
        if (result?.schemaVersion !== schemaVersion || result.graphDigest !== graph.graphDigest) throw new Error('Invalid schema or graph digest');
        const accepted = await validate(result);
        receipt.accepted = true;
        return accepted;
      } catch (error) {
        signal?.throwIfAborted();
        feedback = error instanceof SyntaxError ? 'Return only one valid JSON object' : String(error.message).slice(0, 240);
        if (receipt) receipt.reason = feedback;
        else receipts.push({ task, reason: feedback });
      }
    }
    throw new Error(feedback);
  }
  async function arrange(ids, fixed, depth, direction, boundary = []) {
    if (depth > limits.depth) throw new Error('Nested layout exceeds its display budget');
    const groups = projection.original.filter(g => setContains(ids, g.members));
    const selected = projection.modelNodes.filter(n => ids.has(n.id));
    const inside = projection.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    const edgeData = e => [e.id, e.source, e.target, e.role, e.origin];
    const edgeIds = new Set(inside.map(e => e.id));
    const input = {
      entry: ids.has(projection.entry) ? projection.entry : boundary.find(b => b.side === 'in')?.node ?? selected[0].id,
      nodeCount: selected.length, direction, boundary
    };
    if (selected.length <= limits.compact) return query('placement', {
      ...input, nodes: selected, edges: inside.map(edgeData),
      groups: groups.map(g => ({ id: g.id, kind: g.kind, members: [...g.members], strategy: g.strategy, lanes: g.lanes }))
    }, result => {
      if (!boundedArray(result.phases, limits.phases) || !result.phases.length ||
          !boundedArray(result.placements, ids.size) || result.placements.length !== ids.size) throw new Error('Missing phases or placements');
      const phases = uniqueMap(result.phases, 'id'), seen = new Set(), occupied = new Set();
      if (phases.size !== result.phases.length || result.phases.some(p => !validId(p.id) || !validTitle(p.title) ||
          !directions.includes(p.direction))) throw new Error('Invalid phase IDs, titles, or directions');
      const nodes = result.placements.map(p => {
        const cell = p.col + ':' + p.row;
        if (!ids.has(p.id) || seen.has(p.id) || !phases.has(p.phase) || !validCell(p, ids.size) || occupied.has(cell)) {
          throw new Error('Invalid, missing, or duplicate placement ' + String(p.id));
        }
        seen.add(p.id);
        occupied.add(cell);
        return { ...projection.nodes.get(p.id), phase: p.phase, col: p.col, row: p.row };
      });
      const usedPhases = new Set(nodes.map(n => n.phase));
      if (usedPhases.size !== phases.size) throw new Error('Unused phase');
      const layout = framesFor(nodes, result.phases.map(({ id, title, direction }) => ({ id, title, direction })));
      groupFrames(layout.nodes, groups, true);
      return { ...layout, hints: new Map([...readHints(result.routes, edgeIds), ...fixed]) };
    });
    const units = makeUnits(ids, groups);
    const members = uniqueMap(units, 'id');
    const owner = new Map(units.flatMap(unit => [...unit.members].map(id => [id, unit.id])));
    const betweenUnits = inside.filter(e => owner.get(e.source) !== owner.get(e.target));
    const plan = await query('partition', {
      ...input, entry: owner.get(input.entry),
      units: units.map(u => ({ id: u.id, label: selected.find(n => n.id === u.id).label, size: u.members.size })),
      edges: betweenUnits.map(e => [e.id, owner.get(e.source), owner.get(e.target), e.role, e.origin]),
      boundary: boundary.map(p => ({ ...p, node: owner.get(p.node) }))
    }, result => {
      if (!boundedArray(result.regions, limits.phases) || result.regions.length < 2) throw new Error('Split the large graph into smaller regions');
      const seen = new Set(), regionIds = new Set(), cells = new Set(), division = new Map();
      for (const r of result.regions) {
        const cell = r.col + ':' + r.row;
        if (!validId(r.id) || regionIds.has(r.id) || cells.has(cell) || !validTitle(r.title) ||
            !directions.includes(r.direction) || !validCell(r, limits.phases) ||
            !boundedArray(r.members, units.length) || !r.members.length) throw new Error('Invalid or overlapping region cells');
        regionIds.add(r.id);
        cells.add(cell);
        for (const id of r.members) {
          if (!members.has(id) || seen.has(id)) throw new Error('Unknown or repeated unit ' + String(id));
          seen.add(id);
          division.set(id, r.id);
        }
      }
      if (seen.size !== units.length) throw new Error('Region membership must be a complete partition');
      const joins = betweenUnits.filter(e => division.get(owner.get(e.source)) !== division.get(owner.get(e.target)));
      const hints = readHints(result.routes, new Set(joins.map(e => e.id)));
      const regions = uniqueMap(result.regions, 'id');
      for (const edge of joins) {
        if (hints.has(edge.id)) continue;
        const from = regions.get(division.get(owner.get(edge.source)));
        const to = regions.get(division.get(owner.get(edge.target)));
        const dx = to.col - from.col, dy = to.row - from.row;
        const [sourcePort, targetPort] = Math.abs(dx) >= Math.abs(dy)
          ? dx > 0 ? ['right', 'left'] : ['left', 'right']
          : dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
        hints.set(edge.id, { sourcePort, targetPort });
      }
      return { regions: result.regions, joins, hints };
    });
    const hints = new Map([...plan.hints, ...fixed]);
    const children = [];
    for (const region of plan.regions) {
      const membersInRegion = new Set(region.members.flatMap(id => [...members.get(id).members]));
      const incoming = boundary.filter(b => membersInRegion.has(b.node));
      for (const edge of plan.joins) {
        const [from, to] = [membersInRegion.has(edge.source), membersInRegion.has(edge.target)];
        if (from || to) incoming.push({ edge: edge.id, node: from ? edge.source : edge.target, side: from ? 'out' : 'in',
          port: from ? hints.get(edge.id)?.sourcePort : hints.get(edge.id)?.targetPort, role: edge.role });
      }
      const layout = await arrange(membersInRegion, hints, depth + 1, region.direction, incoming);
      for (const [id, hint] of layout.hints) hints.set(id, hint);
      children.push({ region, layout });
    }
    const geometry = mergeRegions(children);
    groupFrames(geometry.nodes, groups, true);
    return { ...geometry, hints };
  }
  try {
    const { nodes, phases, hints } = await arrange(new Set(projection.nodes.keys()), new Map(), 0);
    const groups = groupFrames(nodes, projection.original);
    const shapes = [...nodes, ...phases, ...groups];
    const dx = 24 - Math.min(24, ...shapes.map(p => p.x));
    const dy = 24 - Math.min(24, ...shapes.map(p => p.y));
    for (const shape of shapes) { shape.x += dx; shape.y += dy; }
    const edges = routeEdges(nodes, projection.edges, hints, phases).map(({ role: _role, origin: _origin, ...edge }) => edge);
    return { layout: { nodes, edges, groups, phases }, receipts };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { reason: String(error.message).slice(0, 240), receipts };
  }
}
