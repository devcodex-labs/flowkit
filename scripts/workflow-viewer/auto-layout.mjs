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

class LayoutOutputError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

function arrangeOnGrid(index, count, span, direction) {
  const line = Math.floor(index / span);
  const length = Math.min(span, count - line * span);
  const reverse = (direction === 'RL' || direction === 'BT') !== (line % 2 !== 0);
  const point = reverse ? length - 1 - index % span : index % span;
  return direction === 'LR' || direction === 'RL' ? { col: point, row: line } : { col: line, row: point };
}

function splitUnits(units, size) {
  const target = Math.max(12, Math.ceil(size / 9));
  const chunks = [];
  let current = [], weight = 0;
  for (const unit of units) {
    if (weight + unit.members.size > target && current.length) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(unit);
    weight += unit.members.size;
  }
  if (current.length) chunks.push(current);
  if (chunks.length === 1 && units.length > 1) {
    const mid = Math.ceil(units.length / 2);
    return [units.slice(0, mid), units.slice(mid)];
  }
  // Merge neighboring units when the current scope would exceed the display phase budget.
  while (chunks.length > limits.phases) {
    let lightest = 0, weight = Infinity;
    for (let i = 0; i < chunks.length - 1; i++) {
      const sum = [...chunks[i], ...chunks[i + 1]].reduce((total, unit) => total + unit.members.size, 0);
      if (sum < weight) { lightest = i; weight = sum; }
    }
    chunks.splice(lightest, 2, [...chunks[lightest], ...chunks[lightest + 1]]);
  }
  return chunks;
}

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
  }));
  // A loop can contain a repair group by its owner without listing all descendants
  // as loop members. Keep the subtree together for layout while leaving graph membership intact.
  const ownedGroups = uniqueMap(original, 'id');
  for (const region of original) {
    for (const id of region.members) {
      const nested = ownedGroups.get(id);
      if (nested && nested !== region) for (const member of nested.members) region.members.add(member);
    }
  }
  original.sort((a, b) => a.members.size - b.members.size);
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
    let feedback, repair, failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      if (++requested > limits.requests) throw new Error('Layout request budget exhausted');
      let receipt;
      try {
        const payload = { schemaVersion, graphDigest: graph.graphDigest, task,
          grid: { columnGap: limits.colGap, rowGap: limits.rowGap, maxPhases: limits.phases },
          ...input, ...(feedback ? { feedback } : {}), ...(repair ? { repair } : {}) };
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
        repair = error instanceof LayoutOutputError ? error.details : undefined;
        failure = receipt ? new LayoutOutputError(feedback, repair) : error;
        if (receipt) Object.assign(receipt, { reason: feedback, ...(repair ? { diagnostics: repair } : {}) });
        else receipts.push({ task, reason: feedback });
      }
    }
    throw failure;
  }
  const edgeData = e => [e.id, e.source, e.target, e.role, e.origin];
  async function assembleChildren(pending, groups, hints) {
    const children = await Promise.allSettled(pending);
    const failure = children.find(child => child.status === 'rejected');
    if (failure) throw failure.reason;
    const results = children.map(child => child.value);
    for (const { layout } of results) for (const [id, hint] of layout.hints) hints.set(id, hint);
    const geometry = mergeRegions(results);
    groupFrames(geometry.nodes, groups, true);
    return { ...geometry, hints };
  }
  async function compactLayout(ids, fixed, depth, direction, boundary) {
    if (depth > limits.depth) throw new Error('Nested layout exceeds its display budget');
    const groups = projection.original.filter(g => setContains(ids, g.members));
    const selected = projection.modelNodes.filter(n => ids.has(n.id));
    const order = new Map(selected.map(({ id, label }, index) => [id, { index, label }]));
    const units = makeUnits(ids, groups).sort((a, b) => order.get(a.id).index - order.get(b.id).index);
    const leaf = ids.size <= 12 && units.every(unit => unit.members.size === 1);
    const parts = leaf ? units : splitUnits(units, ids.size).map((items, i) => ({
      id: 'region' + i, members: new Set(items.flatMap(unit => [...unit.members])),
      label: items.map(unit => order.get(unit.id).label).slice(0, 3).join(' / ').slice(0, 100)
    }));
    if (!leaf && (parts.length < 2 || parts.some(part => part.members.size >= ids.size))) {
      throw new Error('Layout scope cannot be reduced within its groups');
    }
    const byId = uniqueMap(parts, 'id');
    const owner = new Map(parts.flatMap(part => [...part.members].map(id => [id, part.id])));
    const scopedEdges = projection.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    const visibleEdges = scopedEdges.filter(e => owner.get(e.source) !== owner.get(e.target));
    const allowed = new Set(visibleEdges.map(e => e.id));
    const plan = await query('arrangement', {
      direction, units: parts.map(p => ({ id: p.id, label: p.label ?? order.get(p.id).label, size: p.members.size })),
      edges: visibleEdges.map(e => [e.id, owner.get(e.source), owner.get(e.target), e.role, e.origin]),
      boundary: boundary.map(p => ({ ...p, node: owner.get(p.node) }))
    }, result => {
      if (!Array.isArray(result.order) || result.order.length !== parts.length || new Set(result.order).size !== parts.length ||
        result.order.some(id => !byId.has(id)) || !directions.includes(result.direction) || !validTitle(result.title) ||
        !Number.isInteger(result.span) || result.span < 1 || result.span > Math.min(8, parts.length)) {
        throw new LayoutOutputError('Return every supplied unit exactly once and a valid direction, title and span',
          { expectedIds: [...byId.keys()], maxSpan: Math.min(8, parts.length) });
      }
      return { ...result, hints: readHints(result.routes ?? [], allowed) };
    });
    const hints = new Map([...plan.hints, ...fixed]);
    const positions = plan.order.map((id, index) => ({
      id, ...arrangeOnGrid(index, parts.length, plan.span, plan.direction)
    }));
    if (leaf) {
      const phase = { id: 'scope', title: plan.title, direction: plan.direction };
      return { ...framesFor(positions.map(pos => ({ ...projection.nodes.get(pos.id), ...pos, phase: phase.id })), [phase]), hints };
    }
    return assembleChildren(positions.map(async pos => {
      const part = byId.get(pos.id);
      const ports = scopeBoundary(part.members, visibleEdges, hints, boundary);
      const layout = await compactLayout(part.members, hints, depth + 1, plan.direction, ports);
      return { region: { ...pos, title: layout.phases[0].title, direction: plan.direction }, layout };
    }), groups, hints);
  }
  function scopeBoundary(members, edges, hints, boundary) {
    const ports = boundary.filter(item => members.has(item.node));
    for (const edge of edges) {
      const from = members.has(edge.source), to = members.has(edge.target);
      if (from === to) continue;
      ports.push({ edge: edge.id, node: from ? edge.source : edge.target, side: from ? 'out' : 'in',
        port: from ? hints.get(edge.id)?.sourcePort : hints.get(edge.id)?.targetPort, role: edge.role });
    }
    return ports;
  }
  async function arrange(ids, fixed, depth, direction, boundary = []) {
    if (depth > limits.depth) throw new Error('Nested layout exceeds its display budget');
    const groups = projection.original.filter(g => setContains(ids, g.members));
    const selected = projection.modelNodes.filter(n => ids.has(n.id));
    const inside = projection.edges.filter(e => ids.has(e.source) && ids.has(e.target));
    const edgeIds = new Set(inside.map(e => e.id));
    const input = {
      entry: ids.has(projection.entry) ? projection.entry : boundary.find(b => b.side === 'in')?.node ?? selected[0].id,
      nodeCount: selected.length, direction, boundary
    };
    const recover = error => {
      if (!(error instanceof LayoutOutputError)) throw error;
      return compactLayout(ids, fixed, depth, direction, boundary);
    };
    if (selected.length <= limits.compact) return query('placement', {
      ...input, nodes: selected, edges: inside.map(edgeData),
      groups: groups.map(g => ({ id: g.id, kind: g.kind, members: [...g.members], strategy: g.strategy, lanes: g.lanes }))
    }, result => {
      const phasesValid = boundedArray(result.phases, limits.phases) && result.phases.length &&
        result.phases.every(p => p && validId(p.id) && validTitle(p.title) && directions.includes(p.direction));
      if (!phasesValid || !boundedArray(result.placements, limits.nodes)) {
        throw new LayoutOutputError('Missing phases or placements', {
          expectedPlacementCount: ids.size, actualPlacementCount: Array.isArray(result.placements) ? result.placements.length : 0,
          expectedIds: [...ids], invalidPhases: !phasesValid
        });
      }
      const phases = uniqueMap(result.phases, 'id'), seen = new Set(), occupied = new Set();
      if (phases.size !== result.phases.length) throw new LayoutOutputError('Duplicate phase ID', { expectedIds: [...ids] });
      const placements = [], findings = [];
      for (const p of result.placements) {
        if (!p || !ids.has(p.id)) { findings.push({ issue: 'unknown-node' }); continue; }
        const cell = p.col + ':' + p.row;
        const issue = seen.has(p.id) ? 'duplicate-node' : !phases.has(p.phase) ? 'unknown-phase' :
          !validCell(p, ids.size) ? 'out-of-bounds' : occupied.has(cell) ? 'occupied-cell' : null;
        if (issue) {
          findings.push({ id: p.id, issue, ...(issue === 'occupied-cell' ? { col: p.col, row: p.row } : {}) });
          continue;
        }
        seen.add(p.id);
        occupied.add(cell);
        placements.push({ id: p.id, phase: p.phase, col: p.col, row: p.row });
      }
      if (findings.length || seen.size !== ids.size) throw new LayoutOutputError('Incomplete or conflicting node placements', {
        expectedPlacementCount: ids.size, actualPlacementCount: result.placements.length,
        missingIds: [...ids].filter(id => !seen.has(id)), findings: findings.slice(0, 20), acceptedPlacements: placements
      });
      const nodes = placements.map(p => ({ ...projection.nodes.get(p.id), ...p }));
      const usedPhases = new Set(nodes.map(n => n.phase));
      if (usedPhases.size !== phases.size) throw new Error('Unused phase');
      const layout = framesFor(nodes, result.phases.map(({ id, title, direction }) => ({ id, title, direction })));
      groupFrames(layout.nodes, groups, true);
      return { ...layout, hints: new Map([...readHints(result.routes, edgeIds), ...fixed]) };
    }).catch(recover);
    const units = makeUnits(ids, groups);
    const members = uniqueMap(units, 'id');
    const owner = new Map(units.flatMap(unit => [...unit.members].map(id => [id, unit.id])));
    const betweenUnits = inside.filter(e => owner.get(e.source) !== owner.get(e.target));
    let plan;
    try {
      plan = await query('partition', {
      ...input, entry: owner.get(input.entry),
      units: units.map(u => ({ id: u.id, label: selected.find(n => n.id === u.id).label, size: u.members.size })),
      edges: betweenUnits.map(e => [e.id, owner.get(e.source), owner.get(e.target), e.role, e.origin]),
      boundary: boundary.map(p => ({ ...p, node: owner.get(p.node) }))
    }, result => {
      if (!boundedArray(result.regions, limits.phases) || result.regions.length < 2) throw new LayoutOutputError(
        'Split the large graph into smaller regions', {
          minRegions: 2, maxRegions: limits.phases, actualRegions: Array.isArray(result.regions) ? result.regions.length : 0,
          unitIds: [...members.keys()]
        });
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
      if (seen.size !== units.length) throw new LayoutOutputError('Region membership must be a complete partition',
        { missingIds: [...members.keys()].filter(id => !seen.has(id)) });
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
    } catch (error) {
      return recover(error);
    }
    const hints = new Map([...plan.hints, ...fixed]);
    return assembleChildren(plan.regions.map(async region => {
      const membersInRegion = new Set(region.members.flatMap(id => [...members.get(id).members]));
      const incoming = scopeBoundary(membersInRegion, plan.joins, hints, boundary);
      const layout = await arrange(membersInRegion, hints, depth + 1, region.direction, incoming);
      return { region, layout };
    }), groups, hints);
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
