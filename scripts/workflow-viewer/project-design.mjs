import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { isWorkflowId, isWorkflowNodeName } from '../../src/shared/contracts.mjs';
import { graphContentHash } from '../../src/compiler/graph-snapshot.mjs';
import { designDiagram } from './design.mjs';
import { routeEdges } from './layout-routes.mjs';
import { layoutTaskCapacity } from './auto-layout.mjs';

const sectionBytes = 8000;
const scopeSize = Math.min(layoutTaskCapacity.nodes, Math.floor(Math.sqrt(layoutTaskCapacity.edges)));
const coverageFailure = 'Design section did not account for each material range';
const id = (prefix, value) => prefix + artifactDigest(JSON.stringify(value)).slice(7, 39);
const bad = message => Object.assign(new Error(message), { code: 'FKA_DESIGN_SECTION_INVALID' });
const unique = values => [...new Set(values)];
const utf8Bytes = text => Buffer.byteLength(text);

function splitAt(bytes, start, maximum) {
  let end = Math.min(bytes.length, start + maximum);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const newline = bytes.lastIndexOf(10, end - 1);
  if (end < bytes.length && newline > start + maximum / 2) end = newline + 1;
  return end;
}

function splitPart(part, maximum = sectionBytes) {
  const bytes = Buffer.from(part.content);
  if (bytes.length <= maximum) return [part];
  const parts = [];
  for (let start = 0; start < bytes.length;) {
    const end = splitAt(bytes, start, maximum);
    const offset = part.start + start;
    parts.push({ id: id('section-', [part.sourceId, offset, part.start + end]),
      sourceId: part.sourceId, start: offset, end: part.start + end,
      title: part.title, content: bytes.subarray(start, end).toString('utf8') });
    start = end;
  }
  return parts;
}

/** Every UTF-8 byte belongs to one section. Material identifiers are never inferred by the model. */
export function designInputBatches(materials) {
  const parts = materials.map(({ id, title, content }) => ({ id, title, content, sourceId: id, start: 0, end: utf8Bytes(content) }));
  if (parts.length <= 6 && utf8Bytes(JSON.stringify(materials)) <= sectionBytes) return [parts];
  return parts.flatMap(part => splitPart(part)).map(part => [part]);
}

function smallerBatches(parts) {
  if (parts.length > 1) {
    const middle = Math.ceil(parts.length / 2);
    return [parts.slice(0, middle), parts.slice(middle)];
  }
  const size = utf8Bytes(parts[0].content);
  if (size <= 64) return [];
  return splitPart(parts[0], Math.ceil(size / 2)).map(part => [part]);
}

function validateFragment(result, parts, reviewDescriptions = false) {
  const { proposal, requestId } = result ?? {};
  if (result?.status !== 'completed' || typeof requestId !== 'string' || !requestId) {
    throw bad('Design section has no observed completed model request');
  }
  if (proposal?.schemaVersion !== 1 || !Array.isArray(proposal.nodes) ||
      !Array.isArray(proposal.edges) || !Array.isArray(proposal.unresolved)) {
    throw bad('Return one valid JSON object with schemaVersion 1 and nodes, edges and unresolved arrays');
  }
  const known = new Set(parts.map(part => part.id));
  const refs = values => Array.isArray(values) && values.length &&
    new Set(values).size === values.length && values.every(source => known.has(source));
  const invalidKey = proposal.nodes.findIndex(node => node?.key !== undefined &&
    (typeof node.key !== 'string' || !node.key.trim() || node.key.length > 160));
  if (invalidKey >= 0) throw bad(`nodes[${invalidKey}].key must be a nonblank string of at most 160 characters or be omitted`);
  const invalidSubflow = proposal.nodes.findIndex(node => node?.subflow !== undefined &&
    (!isWorkflowId(node.subflow?.key) || !isWorkflowNodeName(node.subflow?.name)));
  if (invalidSubflow >= 0) throw bad(`nodes[${invalidSubflow}].subflow requires a valid key and name or must be omitted`);
  if (proposal.edges.some(edge => !refs(edge?.sources))) throw bad('Design relation has no source range');
  const gap = item => typeof item?.question === 'string' && item.question.trim() && item.question.length <= 500 && refs(item.sources);
  if (!proposal.unresolved.every(gap)) throw bad('Design unresolved question has invalid source evidence');
  if (proposal.nodes.length) designDiagram('Section', parts, proposal);
  else if (proposal.edges.length) throw bad('An empty design section contains relations');
  if (reviewDescriptions) {
    const comparable = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]+/gu, '');
    const repeatsTitle = proposal.nodes.find(node => comparable(node.description) === comparable(node.name));
    if (repeatsTitle) throw bad('Description for node ' + repeatsTitle.id +
      ' repeats its title. Explain an actual responsibility, trigger, outcome, or relationship from the cited source.');
  }
  const ids = new Set(proposal.nodes.map(node => node.id));
  const handoffs = proposal.handoffs ?? [];
  if (!Array.isArray(handoffs) || handoffs.some(link => !ids.has(link?.from) || typeof link.target !== 'string' ||
      !link.target.trim() || link.target.length > 160 || typeof link.description !== 'string' ||
      !link.description.trim() || link.description.length > 240 || !refs(link.sources))) {
    throw bad('Invalid design handoff');
  }
  const represented = new Set(proposal.nodes.flatMap(node => node.sources));
  const coverage = proposal.coverage;
  if (!Array.isArray(coverage) || coverage.length !== known.size ||
      new Set(coverage.map(row => row?.source)).size !== known.size || coverage.some(row =>
        !known.has(row?.source) || !['represented', 'no-steps', 'unresolved'].includes(row.status) ||
        typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 400 ||
        (row.status !== 'unresolved' && (row.status === 'represented') !== represented.has(row.source)))) {
    throw bad(coverageFailure);
  }
  const unresolved = [...proposal.unresolved];
  const normalizedCoverage = coverage.map(row => {
    if (row.status !== 'unresolved' || !represented.has(row.source)) return row;
    if (!unresolved.some(gap => gap.question === row.reason && gap.sources.includes(row.source))) {
      unresolved.push({ question: row.reason, sources: [row.source] });
    }
    return { ...row, status: 'represented' };
  });
  return { status: 'completed', proposal: { ...proposal, coverage: normalizedCoverage, unresolved, handoffs },
    requestId, provider: result.provider, model: result.model };
}

/** Stores exact successful section receipts. Limits apply to each physical call and can bisect on exhaustion. */
export async function collectDesignSections({ title, materials, signal, authorize, plan, load, save, modelIdentity }) {
  const sections = [];
  const acceptedFlows = new Map();
  function reviewSubflows(result, ranges) {
    const sources = new Map(ranges.map(range => [range.id, range.sourceId]));
    const additions = new Map(), conflicts = new Map();
    for (const node of result.proposal.nodes) {
      const flow = node.subflow;
      if (!flow) continue;
      const known = acceptedFlows.get(flow.key) ?? additions.get(flow.key);
      if (known && known.name !== flow.name) {
        conflicts.set(flow.key, known);
      }
      if (!known) additions.set(flow.key, { name: flow.name, description: node.description.slice(0, 180),
        sourceIds: unique(node.sources.map(id => sources.get(id))) });
    }
    if (conflicts.size) {
      const evidence = [...conflicts].map(([key, { name, description }]) => ({ key, name, description }));
      throw Object.assign(bad('Review these subflows against the supplied source: ' + JSON.stringify(evidence) +
        '. If a key refers to the same flow use its exact existing name. Use a distinct key for evidenced different semantics, or omit the hint when uncertain. Preserve other facts.'), { conflicts });
    }
    return additions;
  }
  const pending = designInputBatches(materials).reverse();
  while (pending.length) {
    signal.throwIfAborted();
    const parts = pending.pop();
    const sourceIds = unique(parts.map(part => part.sourceId));
    await authorize(sourceIds);
    const ranges = parts.map(({ sourceId, id, start, end, content }) => ({
      sourceId, id, start, end, digest: artifactDigest(content)
    }));
    const key = id('scope-', ['design-section-v3', title, modelIdentity, ranges]);
    const previous = load(key);
    if (previous?.split === true) {
      const children = smallerBatches(parts);
      if (!children.length) throw bad('Stored design section split has no children');
      pending.push(...children.reverse());
      continue;
    }
    let result;
    const retryCoverage = previous?.invalid === coverageFailure && !previous.validationRevision;
    if (previous?.invalid && !retryCoverage) throw bad(previous.invalid);
    if (previous?.status === 'completed') result = validateFragment(previous, parts);
    else {
      try {
        const input = parts.map(({ id, title, content }) => ({ id, title, content }));
        let correction = retryCoverage ? coverageFailure : previous?.correction;
        let correctionSources = previous?.correctionSources ?? [];
        for (;;) {
          signal.throwIfAborted();
          if (correctionSources.length) await authorize(unique([...sourceIds, ...correctionSources]));
          const output = await plan({ title, materials: input, section: { key, ranges }, correction, signal });
          signal.throwIfAborted();
          let validated;
          try {
            validated = validateFragment(output, parts, true);
            reviewSubflows(validated, ranges);
            result = validated;
            break;
          } catch (error) {
            if (error.code !== 'FKA_DESIGN_SECTION_INVALID' || output?.status !== 'completed' ||
                typeof output.requestId !== 'string' || !output.requestId) throw error;
            if (correction && error.conflicts) {
              const unresolved = [...validated.proposal.unresolved];
              const nodes = validated.proposal.nodes.map(node => {
                if (!error.conflicts.has(node.subflow?.key)) return node;
                const { subflow, ...rest } = node;
                unresolved.push({ question: '待核对同键子流程 ' + subflow.key + ' · ' + subflow.name, sources: node.sources });
                return rest;
              });
              result = { ...validated, proposal: { ...validated.proposal, nodes, unresolved } };
              break;
            }
            if (correction) {
              save(key, { invalid: error.message, validationRevision: 2 });
              throw error;
            }
            correction = error.message;
            correctionSources = error.conflicts ? unique([...error.conflicts.values()].flatMap(flow => flow.sourceIds)) : [];
            save(key, { correction, correctionSources });
            await authorize(sourceIds);
          }
        }
      } catch (error) {
        const children = error.code === 'FKA_DESIGN_RESPONSE_LIMIT' ? smallerBatches(parts) : [];
        if (!children.length) throw error;
        save(key, { split: true });
        pending.push(...children.reverse());
        continue;
      }
      signal.throwIfAborted();
      save(key, result);
    }
    for (const [key, flow] of reviewSubflows(result, ranges)) acceptedFlows.set(key, flow);
    sections.push({ id: key, title: parts[0].title, ranges, ...result });
  }
  return sections;
}

/** Merge recorded facts. Ambiguous or unavailable cross-section targets remain visible. */
export function mergeDesignSections(title, materials, sections) {
  const nodes = [], edges = [], unresolved = [], groups = [], handoffs = [];
  const keys = new Map();
  const rangesByEdge = new Map();
  for (const section of sections) {
    const { proposal, ranges } = section;
    const parents = new Map(ranges.map(range => [range.id, range.sourceId]));
    const sources = refs => unique(refs.map(ref => parents.get(ref)));
    const global = new Map(proposal.nodes.map(node => [node.id,
      sections.length === 1 ? node.id : id('step-', [section.id, node.id])]));
    for (const node of proposal.nodes) {
      const globalId = global.get(node.id);
      nodes.push({ ...node, id: globalId, sources: sources(node.sources) });
      const key = node.key ?? node.id;
      const matches = keys.get(key) ?? [];
      matches.push(globalId);
      keys.set(key, matches);
    }
    edges.push(...proposal.edges.map(edge => ({ ...edge, from: global.get(edge.from), to: global.get(edge.to),
      ranges: edge.sources, sources: sources(edge.sources) })));
    handoffs.push(...proposal.handoffs.map(link => ({ ...link, groupId: section.id, from: global.get(link.from),
      ranges: link.sources, sources: sources(link.sources) })));
    const gaps = [...proposal.unresolved.map(gap => ({ ...gap, ranges: gap.sources, sources: sources(gap.sources) })),
      ...proposal.coverage.filter(row => row.status === 'unresolved')
        .map(row => ({ question: row.reason, sources: sources([row.source]), ranges: [row.source] }))];
    unresolved.push(...gaps);
    groups.push({ id: section.id, title: section.title, ranges, nodeIds: [...global.values()], coverage: proposal.coverage,
      requestId: section.requestId, provider: section.provider, model: section.model,
      steps: proposal.nodes.map(({ id, name, description, key }) => ({ id: global.get(id), name, description, key })),
      relations: proposal.edges.map(({ from, to, description, sources }) => ({ from: global.get(from), to: global.get(to),
        description, ranges: sources })),
      boundaries: proposal.handoffs.map(({ from, target, description, sources }) => ({ from: global.get(from), target,
        description, ranges: sources })),
      unresolved: gaps,
      nodeRanges: proposal.nodes.map(node => ({ id: global.get(node.id), ranges: node.sources })) });
  }
  const byGroup = new Map(groups.map(group => [group.id, group]));
  for (const { groupId, ...handoff } of handoffs) {
    const targets = keys.get(handoff.target);
    if (targets?.length === 1) edges.push({ ...handoff, to: targets[0] });
    else {
      const gap = { question: '确认跨组目标 ' + handoff.target, sources: handoff.sources, ranges: handoff.ranges };
      unresolved.push(gap);
      byGroup.get(groupId).unresolved.push(gap);
    }
  }
  const project = { schemaVersion: 1, nodes: nodes.map(({ subflow, ...node }) => node), edges, unresolved };
  const merged = designDiagram(title, materials, project);
  for (const edge of edges) {
    const edgeId = artifactDigest(JSON.stringify([edge.from, edge.to, edge.description]));
    rangesByEdge.set(edgeId, unique([...(rangesByEdge.get(edgeId) ?? []), ...edge.ranges]));
  }
  merged.design.groups = groups;
  merged.design.nodeRanges = groups.flatMap(group => group.nodeRanges);
  merged.design.ranges = groups.flatMap(group => group.ranges);
  merged.design.edgeRanges = [...rangesByEdge].map(([edgeId, ranges]) => ({ edgeId, ranges }));
  merged.design.subflows = nodes.filter(node => node.subflow).map(({ id, subflow }) => ({ id, ...subflow }));
  merged.identity = artifactDigest(JSON.stringify([merged.identity, merged.design.edgeRanges,
    groups.map(({ requestId, provider, model, ...group }) => group)]));
  return { ...merged, project };
}

function stepsByConnection(ids, neighbors) {
  const remaining = new Set(ids);
  const ordered = [];
  for (const start of ids) {
    if (!remaining.delete(start)) continue;
    const pending = [start];
    for (let i = 0; i < pending.length; i++) {
      const step = pending[i];
      ordered.push(step);
      for (const next of neighbors.get(step)) if (remaining.delete(next)) pending.push(next);
    }
  }
  return ordered;
}

/** The master graph and its authoring receipts stay intact. Compute only view membership and layout tasks. */
export function planDesignCanvas(graph, design) {
  const steps = new Map(graph.nodes.map(node => [node.id, node]));
  const supplied = new Map((design.subflows ?? []).map(row => [row.id, row]));
  if (graph.nodes.length <= scopeSize && design.groups.length === 1 && !supplied.size) return null;

  const origins = new Map(design.nodeSources.map(row => [row.id, row.sources[0]]));
  const neighbors = new Map(graph.nodes.map(node => [node.id, new Set()]));
  const incoming = new Map(graph.nodes.map(node => [node.id, new Set()]));
  for (const edge of graph.referenceEdges) {
    neighbors.get(edge.from).add(edge.to);
    neighbors.get(edge.to).add(edge.from);
    incoming.get(edge.to).add(edge.from);
  }
  const buckets = new Map();
  const flowNames = new Map(), conflicting = new Set();
  for (const { key, name } of supplied.values()) {
    if (flowNames.has(key) && flowNames.get(key) !== name) conflicting.add(key);
    else flowNames.set(key, name);
  }
  for (const node of graph.nodes) {
    const hint = supplied.get(node.id);
    const flow = hint && !conflicting.has(hint.key) ? hint : undefined;
    const key = JSON.stringify(flow ? ['subflow', flow.key] : ['material', origins.get(node.id)]);
    if (!buckets.has(key)) buckets.set(key, { name: flow?.name, ids: [] });
    buckets.get(key).ids.push(node.id);
  }
  const groups = [], counts = new Map(), topByStep = new Map();
  let root = [];
  const used = new Set(steps.keys());
  const entrances = members => {
    const ids = new Set(members);
    return members.filter(nodeId => ![...incoming.get(nodeId)].some(id => ids.has(id)));
  };
  function addBlock(title, members) {
    let blockId = id('block-', members);
    while (used.has(blockId)) blockId = id('block-', [blockId, members]);
    used.add(blockId);
    const block = { id: blockId, title, members, count: members.reduce((sum, member) => sum + (counts.get(member) ?? 1), 0) };
    counts.set(blockId, block.count);
    groups.push(block);
    return block;
  }
  function titleFor(members) {
    const entries = entrances(members);
    const entry = entries.find(nodeId => neighbors.get(nodeId).size) ?? entries[0] ?? members[0];
    return steps.get(entry).name;
  }
  function boundLayer(members, describe) {
    while (members.length > scopeSize) {
      const next = [];
      for (let start = 0; start < members.length; start += scopeSize) {
        const children = members.slice(start, start + scopeSize);
        next.push(addBlock(describe(children), children).id);
      }
      members = next;
      const priorNames = new Map(groups.map(group => [group.id, group.title]));
      describe = children => priorNames.get(children[0]);
    }
    return members;
  }
  for (const { name, ids } of buckets.values()) {
    const ordered = stepsByConnection([...new Set([...entrances(ids), ...ids])], neighbors);
    const block = addBlock(name ?? titleFor(ids), boundLayer(ordered, titleFor));
    for (const step of ordered) topByStep.set(step, block.id);
    root.push(block.id);
  }
  if (root.length > scopeSize) {
    const adjacent = new Map(root.map(id => [id, new Set()]));
    for (const edge of graph.referenceEdges) {
      const from = topByStep.get(edge.from), to = topByStep.get(edge.to);
      adjacent.get(from).add(to);
      adjacent.get(to).add(from);
    }
    const names = new Map(groups.map(group => [group.id, group.title]));
    root = boundLayer(stepsByConnection(root, adjacent), members => names.get(members[0]));
  }

  const byGroup = new Map(groups.map(group => [group.id, group]));
  const scopes = [{ id: 'overview', title: graph.name, members: root }, ...groups];
  const links = new Map(scopes.map(scope => [scope.id, []]));
  const paths = new Map();
  function visit(members, ancestors) {
    for (const member of members) {
      const path = [...ancestors, member];
      if (byGroup.has(member)) visit(byGroup.get(member).members, path);
      else paths.set(member, path);
    }
  }
  visit(root, ['overview']);
  for (const edge of graph.referenceEdges) {
    const fromPath = paths.get(edge.from), toPath = paths.get(edge.to);
    let i = 1;
    while (i < fromPath.length - 1 && fromPath[i] === toPath[i]) i++;
    links.get(fromPath[i - 1]).push({ ...edge, from: fromPath[i], to: toPath[i] });
  }
  const layoutGraphs = scopes.map(scope => {
    const nodes = scope.members.map(member => steps.get(member) ?? { id: member, name: byGroup.get(member).title,
      type: 'design', ownerIds: [], inputs: [], outputs: [] });
    const referenceEdges = links.get(scope.id);
    const targets = new Set(referenceEdges.filter(edge => edge.from !== edge.to).map(edge => edge.to));
    const entryNodeId = nodes.find(node => !targets.has(node.id))?.id ?? nodes[0].id;
    const forLayout = { ...graph, name: scope.title, entryNodeId, nodes, referenceEdges };
    forLayout.graphDigest = graphContentHash(forLayout);
    return { id: scope.id, graph: forLayout };
  });
  return { root, groups, expandInitially: graph.nodes.length <= scopeSize, layoutGraphs };
}

/** Layout uses one visible direction per pair. The master graph retains all original relations. */
export function projectDesignLayoutGraph(graph) {
  const directions = new Map();
  for (const edge of graph.referenceEdges) {
    const key = edge.from + '>' + edge.to;
    if (!directions.has(key)) directions.set(key, edge);
  }
  const projected = { ...graph, referenceEdges: [...directions.values()] };
  projected.graphDigest = graphContentHash(projected);
  return projected;
}

/** Store scope positions and route the collapsed overview between real block endpoints. */
export function packDesignScope(id, graph, layout, modelArranged) {
  let tiles = layout.nodes.map(({ nodeId, x, y, w, h }) => ({ id: nodeId, x, y, w, h }));
  if (modelArranged) return { id, tiles,
    routes: layout.edges.filter(edge => edge.route).map(({ edgeId, route }) => ({ edgeId, route })) };
  if (id !== 'overview') return { id, tiles };
  if (!modelArranged) {
    const columns = Math.ceil(Math.sqrt(tiles.length * 1.4));
    tiles = tiles.map((tile, i) => ({ ...tile,
      x: i % columns * (tile.w + 84), y: Math.floor(i / columns) * (tile.h + 84) }));
  }
  const bundles = new Map();
  for (const { edgeId, from, to } of graph.referenceEdges) {
    const key = from + '>' + to;
    if (from !== to && !bundles.has(key)) bundles.set(key, { id: edgeId, source: from, target: to, kind: 'normal' });
  }
  const result = { id, tiles };
  try {
    result.routes = routeEdges(tiles, [...bundles.values()], new Map(), [])
      .map(({ id: edgeId, route }) => ({ edgeId, route }));
  } catch {
    // The bounded router can fall back to viewer curves for tightly packed model geometry.
  }
  return result;
}
