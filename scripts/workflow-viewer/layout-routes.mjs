export const ports = ['top', 'right', 'bottom', 'left'];
const opposite = { top: 'bottom', bottom: 'top', right: 'left', left: 'right' };
const horizontal = side => side === 'left' || side === 'right';
const center = node => [node.x + node.w / 2, node.y + node.h / 2];

function choosePort(from, to, edge, phase) {
  const [x, y] = center(from), [tx, ty] = center(to);
  if (edge.kind === 'loop' && from.phase === to.phase && phase) {
    return ['LR', 'RL'].includes(phase.direction) ? 'top' : 'left';
  }
  return Math.abs(tx - x) >= Math.abs(ty - y) * .85 ? tx >= x ? 'right' : 'left' : ty >= y ? 'bottom' : 'top';
}

function anchor(node, side, offset) {
  const [x, y] = center(node);
  if (horizontal(side)) return [side === 'left' ? node.x : node.x + node.w, y + offset];
  return [x + offset, side === 'top' ? node.y : node.y + node.h];
}

function lead([x, y], side) {
  return [x + (side === 'left' ? -14 : side === 'right' ? 14 : 0),
    y + (side === 'top' ? -14 : side === 'bottom' ? 14 : 0)];
}

const covers = ([x, y], [tx, ty], n, pad = 7) =>
  Math.min(x, tx) < n.x + n.w + pad && Math.max(x, tx) > n.x - pad &&
  Math.min(y, ty) < n.y + n.h + pad && Math.max(y, ty) > n.y - pad;

class MinQueue {
  items = [];
  push(item) {
    let i = this.items.push(item) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][0] <= item[0]) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (!this.items.length) return first;
    let current = 0;
    while (current * 2 + 1 < this.items.length) {
      let child = current * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1][0] < this.items[child][0]) child++;
      if (last[0] <= this.items[child][0]) break;
      this.items[current] = this.items[child];
      current = child;
    }
    this.items[current] = last;
    return first;
  }
}

function simplify(points) {
  const result = [];
  for (const p of points) {
    const b = result.at(-1), a = result.at(-2);
    if (b && b[0] === p[0] && b[1] === p[1]) continue;
    if (a && (a[0] === b[0] && b[0] === p[0] && (b[1]-a[1])*(p[1]-b[1]) >= 0 ||
      a[1] === b[1] && b[1] === p[1] && (b[0]-a[0])*(p[0]-b[0]) >= 0)) result.pop();
    result.push(p);
  }
  return result;
}

/** Use orthogonal channels between cards. Each route starts at its actual visual port. */
export function routeEdges(nodes, edges, hints, phases) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const phasesById = new Map(phases.map(p => [p.id, p]));
  const loads = new Map();
  function reserve(node, side) {
    const key = node.id + ':' + side;
    const index = loads.get(key) ?? 0;
    loads.set(key, index + 1);
    return { node, side, key, index };
  }
  const routes = edges.map(edge => {
    const from = byId.get(edge.source), to = byId.get(edge.target);
    const hinted = hints.get(edge.id);
    const side = choosePort(from, to, edge, phasesById.get(from.phase));
    return { edge, start: reserve(from, hinted?.sourcePort ?? side),
      end: reserve(to, hinted?.targetPort ?? (edge.kind === 'loop' && from.phase === to.phase ? side : opposite[side])) };
  });
  const coordinates = axis => {
    const [start, len] = axis === 0 ? ['x', 'w'] : ['y', 'h'];
    const values = nodes.flatMap(node => [node[start] - 27, node[start] - 14,
      node[start] + node[len] + 14, node[start] + node[len] + 27]);
    for (const { start: from, end: to } of routes) values.push(from.lead[axis], to.lead[axis]);
    return [...new Set(values)].sort((a, b) => a - b);
  };
  for (const { start, end } of routes) for (const p of [start, end]) {
    const dimension = horizontal(p.side) ? p.node.h : p.node.w;
    const count = loads.get(p.key);
    p.anchor = anchor(p.node, p.side, (p.index - (count - 1) / 2) * Math.min(12, (dimension - 16) / count));
    p.lead = lead(p.anchor, p.side);
  }
  const xs = coordinates(0), ys = coordinates(1);
  const nx = xs.length, size = nx * ys.length;
  if (size > 360_000) throw new Error('Routing grid exceeds its bounded display size');
  const indexX = new Map(xs.map((x, i) => [x, i]));
  const indexY = new Map(ys.map((y, i) => [y, i]));
  const cell = ([x, y]) => indexY.get(y) * nx + indexX.get(x);
  const point = at => [xs[at % nx], ys[Math.floor(at / nx)]];
  const used = [new Uint16Array(size), new Uint16Array(size)];
  const cost = new Float64Array(size * 2);
  const back = new Int32Array(size * 2);
  const seen = new Uint16Array(size * 2);
  let search = 0, remaining = 7_000_000;
  // Cache occupied channel segments across all edge searches.
  const occupied = [new Uint8Array(size), new Uint8Array(size)];
  function blocked(from, to, direction) {
    const index = Math.min(from, to), saved = occupied[direction][index];
    if (saved) return saved === 2;
    const hit = nodes.some(n => covers(point(from), point(to), n));
    occupied[direction][index] = hit ? 2 : 1;
    return hit;
  }
  function find(start, end) {
    const first = cell(start.lead), last = cell(end.lead);
    const queue = new MinQueue();
    search++;
    const initial = first * 2 + (horizontal(start.side) ? 0 : 1);
    seen[initial] = search;
    back[initial] = -1;
    cost[initial] = 0;
    queue.push([0, initial, 0]);
    while (queue.items.length) {
      const [, state, spent] = queue.pop();
      if (spent !== cost[state]) continue;
      if (--remaining < 0) throw new Error('Routing exceeds its bounded search size');
      const at = state >> 1;
      if (at === last) {
        const path = [];
        for (let cursor = state; cursor >= 0; cursor = back[cursor]) path.push(cursor >> 1);
        path.reverse();
        for (let k = 1; k < path.length; k++) {
          const a = path[k - 1], b = path[k];
          used[Math.abs(a - b) === nx ? 1 : 0][Math.min(a, b)]++;
        }
        return simplify([start.anchor, ...path.map(point), end.anchor]);
      }
      const [x, y] = point(at);
      const adjacent = [[at % nx > 0, at - 1, 0], [at % nx < nx - 1, at + 1, 0],
        [at >= nx, at - nx, 1], [at < size - nx, at + nx, 1]];
      for (const [valid, next, direction] of adjacent) {
        if (!valid || blocked(at, next, direction)) continue;
        const [tx, ty] = point(next);
        const distance = Math.abs(x - tx) + Math.abs(y - ty);
        const score = spent + distance * (1 + 2.4 * used[direction][Math.min(at, next)]) +
          (state % 2 === direction ? 0 : 38);
        const id = next * 2 + direction;
        if (seen[id] === search && score >= cost[id]) continue;
        seen[id] = search;
        cost[id] = score;
        back[id] = state;
        queue.push([score + Math.abs(end.lead[0] - tx) + Math.abs(end.lead[1] - ty), id, score]);
      }
    }
    throw new Error('No unobstructed channel between the supplied ports');
  }
  return routes.sort((a, b) => Number(a.edge.kind === 'error') - Number(b.edge.kind === 'error')).map(({ edge, start, end }) => {
    const route = find(start, end);
    if (route.slice(1).some((p, i) => nodes.some(n => n.id !== edge.source && n.id !== edge.target && covers(route[i], p, n, 2)))) {
      throw new Error('A route intersects an unrelated card');
    }
    return { ...edge, route };
  });
}
