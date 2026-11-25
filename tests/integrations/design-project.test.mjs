import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectDesignSections, mergeDesignSections, planDesignCanvas, projectDesignLayoutGraph } from '../../scripts/workflow-viewer/project-design.mjs';
import { localModel } from '../../scripts/local-mcp-model.mjs';

test('project partitions preserve UTF-8 evidence, all outcomes and cross-view navigation without a graph count ceiling', async () => {
  const materials = Array.from({ length: 7 }, (_, index) => ({ id: 'source-' + index,
    title: 'Phase ' + index, content: index === 0 ? '🙂中'.repeat(1700) + '\r\n末尾' : 'Reference ' + index }));
  const cache = new Map(), ranges = [];
  let calls = 0;
  let fail = true;
  const inputs = {
    title: 'Project diagram', materials, signal: new AbortController().signal, modelIdentity: 'fixture',
    async authorize(ids) { assert.ok(ids.every(id => materials.some(material => material.id === id))); },
    load: key => cache.get(key), save: (key, value) => cache.set(key, value),
    async plan({ materials: [material], section }) {
      if (++calls === 2 && fail) throw new Error('Interrupted provider');
      ranges.push(...section.ranges.map(range => ({ ...range, content: material.content })));
      const first = material.id === 'source-1';
      const nodes = Array.from({ length: 61 }, (_, index) => ({ id: 'step-' + index, name: 'Step ' + index,
        key: first && !index ? 'cross-target' : section.key + '-' + index, description: 'Evidence backed step', sources: [material.id],
        ...(!index ? { subflow: { key: 'registered-entry', name: 'Registered entry' } } : {}) }));
      return { status: 'completed', requestId: 'test-' + calls, proposal: { schemaVersion: 1, nodes,
        edges: [...nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: nodes[index + 1].id,
          description: 'next', sources: [material.id] })),
          { from: 'step-0', to: 'step-1', description: 'alternative', sources: [material.id] },
          { from: 'step-1', to: 'step-1', description: 'retry', sources: [material.id] }],
        unresolved: Array.from({ length: 4 }, (_, i) => ({ question: 'Verify exit ' + i, sources: [material.id] })),
        handoffs: first ? [] : [{ from: 'step-0', target: 'cross-target', description: 'hand off', sources: [material.id] }],
        coverage: [{ source: material.id, status: 'represented', reason: 'evidenced' }]
      } };
    }
  };
  await assert.rejects(collectDesignSections(inputs), /Interrupted provider/);
  assert.equal(cache.size, 1);
  fail = false;
  const sections = await collectDesignSections(inputs);
  assert.equal(calls, sections.length + 1);
  for (const source of materials) {
    const parts = ranges.filter(part => part.sourceId === source.id).sort((a, b) => a.start - b.start);
    assert.equal(parts.map(part => part.content).join(''), source.content);
    assert.equal(parts.at(-1).end, Buffer.byteLength(source.content));
  }
  const result = mergeDesignSections(inputs.title, materials, sections);
  assert.ok(result.graph.nodes.length > 360);
  assert.ok(result.graph.referenceEdges.length > 120);
  assert.ok(result.design.unresolved.length > 20);
  assert.equal(result.graph.nodes.length, sections.length * 61);
  assert.equal(result.graph.referenceEdges.length, sections.length * 62 + sections.length - 1);
  const plain = structuredClone(sections);
  plain.forEach(section => section.proposal.nodes.forEach(node => delete node.subflow));
  assert.equal(result.graph.graphDigest, mergeDesignSections(inputs.title, materials, plain).graph.graphDigest);
  const { layoutGraphs, groups, root } = planDesignCanvas(result.graph, result.design);
  assert.equal(layoutGraphs[0].id, 'overview');
  assert.ok(layoutGraphs[0].graph.referenceEdges.length > 0);
  assert.equal(groups.find(group => group.title === 'Registered entry').count, sections.length);
  assert.ok(root.length < sections.length * 2);
  const nodeIds = new Set(result.graph.nodes.map(node => node.id));
  const arranged = layoutGraphs.flatMap(scope => scope.graph.nodes.map(node => node.id)).filter(id => nodeIds.has(id));
  assert.deepEqual(arranged.sort(), [...nodeIds].sort());
  const edgeIds = layoutGraphs.flatMap(scope => scope.graph.referenceEdges.map(edge => edge.edgeId));
  assert.deepEqual(edgeIds.sort(), result.graph.referenceEdges.map(edge => edge.edgeId).sort());
});

test('a fresh static design repairs a title-only description without adding workflow fields', async () => {
  const material = { id: 'approval-notes', title: 'Approval notes',
    content: 'A reviewer checks the candidate hash and starts the export if it matches.' };
  const cache = new Map(), feedback = [];
  const sections = await collectDesignSections({ title: 'Export', materials: [material],
    signal: new AbortController().signal, modelIdentity: 'fixture',
    async authorize(ids) { assert.deepEqual(ids, [material.id]); },
    load: key => cache.get(key), save: (key, value) => cache.set(key, value),
    async plan({ correction }) {
      feedback.push(correction);
      return { status: 'completed', requestId: correction ? 'corrected' : 'initial', proposal: {
        schemaVersion: 1, nodes: [{ id: 'review', name: 'Approval', sources: [material.id],
          description: correction ? material.content : 'Approval.' }],
        edges: [], unresolved: [], coverage: [{ source: material.id, status: 'represented', reason: 'Approval step' }]
      } };
    }
  });
  assert.equal(feedback[0], undefined);
  assert.match(feedback[1], /Description for node review repeats its title/);
  assert.equal(sections[0].proposal.nodes[0].description, material.content);
});

test('layout budgets apply to every overview layer and keep all original directed outcomes', () => {
  const source = { id: 'source', title: 'Project notes', content: 'Registered flow start and paths.' };
  const nodes = Array.from({ length: 361 }, (_, i) => ({ id: 'step-' + i, name: 'Step ' + i,
    description: 'A sourced step', sources: [source.id], subflow: { key: 'flow-' + i, name: 'Flow ' + i } }));
  const edges = Array.from({ length: 901 }, (_, i) => ({ from: nodes[0].id, to: nodes[1].id,
    description: 'Outcome ' + i, sources: [source.id] }));
  edges.push({ from: nodes[1].id, to: nodes[0].id, description: 'Retry original step', sources: [source.id] });
  const data = mergeDesignSections(source.title, [source], [{ id: source.id, title: source.title,
    ranges: [{ id: source.id, sourceId: source.id, start: 0, end: source.content.length }],
    proposal: { nodes, edges, unresolved: [], coverage: [], handoffs: [] } }]);
  const canvas = planDesignCanvas(data.graph, data.design);
  assert.ok(canvas.root.length < 361);
  const originalIds = new Set(data.graph.nodes.map(node => node.id));
  assert.equal(canvas.groups.filter(group => group.members.length === 1 && originalIds.has(group.members[0])).length, 361);
  assert.equal(canvas.root.reduce((sum, id) => sum + canvas.groups.find(group => group.id === id).count, 0), 361);
  const projected = canvas.layoutGraphs.map(({ graph }) => projectDesignLayoutGraph(graph));
  assert.ok(projected.every(scope => scope.nodes.length <= 360 && scope.referenceEdges.length <= 900));
  assert.equal(projected.flatMap(scope => scope.referenceEdges).length, 2);
  assert.deepEqual(canvas.layoutGraphs.flatMap(scope => scope.graph.referenceEdges.map(edge => edge.edgeId)).sort(),
    data.graph.referenceEdges.map(edge => edge.edgeId).sort());
});

test('subflow names are corrected across source sections without replacing the source graph', async () => {
  const materials = Array.from({ length: 7 }, (_, i) => ({ id: 'source-' + i, title: 'Section ' + i, content: 'Flow material.' }));
  const cache = new Map(), corrections = [], authorization = [];
  const sections = await collectDesignSections({ title: 'Project', materials, signal: new AbortController().signal,
    modelIdentity: 'fixture', load: key => cache.get(key), save: (key, value) => cache.set(key, value),
    async authorize(ids) { authorization.push(ids); },
    async plan({ materials: [source], correction }) {
      const index = Number(source.id.at(-1));
      if (correction) corrections.push({ index, correction, authorized: authorization.at(-1) });
      const alias = !correction && index===1;
      const conflicting = index===2;
      const unrelated = index===3;
      const uncertain = index===4;
      return { status: 'completed', requestId: source.id + (correction ? '-corrected' : ''),
        proposal: { schemaVersion: 1, nodes: [{ id: 'step', name: 'Step ' + index, description: 'Purpose ' + index,
          sources: [source.id], subflow: {
            key: conflicting && correction ? 'failure' : unrelated ? 'independent' : 'review',
            name: alias ? 'Review steps' : conflicting ? 'Failure handling' : uncertain ? 'Unverified' : 'Review',
          } }], edges: [], unresolved: [], handoffs: [],
          coverage: [{ source: source.id, status: 'represented', reason: 'evidenced' }] } };
    } });
  assert.deepEqual(corrections.map(item => item.index), [1, 2, 4]);
  assert.match(corrections[0].correction, /Purpose 0/);
  assert.deepEqual(corrections[0].authorized, ['source-1', 'source-0']);
  assert.equal(sections[1].proposal.nodes[0].subflow.name, 'Review');
  assert.equal(sections[2].proposal.nodes[0].subflow.key, 'failure');
  assert.equal(sections[4].proposal.nodes[0].subflow, undefined);
  assert.match(sections[4].proposal.unresolved[0].question, /待核对同键子流程/);
  const data = mergeDesignSections('Project', materials, sections);
  const canvas = planDesignCanvas(data.graph, data.design);
  assert.deepEqual(canvas.groups.filter(group => group.title === 'Review').map(group => group.count), [4, 1]);
  assert.equal(data.graph.nodes.length, materials.length);
});

test('renews a failed coverage receipt and retains represented steps and unresolved evidence together', async () => {
  const source = { id: 'registry', title: 'Registry', content: 'One registered route and one unknown branch.' };
  const cache = new Map();
  let calls = 0;
  const options = { title: 'Registry project', materials: [source], signal: new AbortController().signal,
    modelIdentity: 'fixture', load: key => cache.get(key) ?? { invalid: 'Design section did not account for each material range' },
    save: (key, value) => cache.set(key, value), async authorize(ids) { assert.deepEqual(ids, [source.id]); },
    async plan({ correction }) {
      calls++;
      assert.match(correction, /did not account/);
      return { status: 'completed', requestId: 'observed-retry', proposal: { schemaVersion: 1,
        nodes: [{ id: 'known-route', name: 'Known route', description: 'Verify registered route', sources: [source.id] }],
        edges: [], unresolved: [], handoffs: [],
        coverage: [{ source: source.id, status: 'unresolved', reason: 'The unknown branch has no registered target' }] } };
    } };
  const [section] = await collectDesignSections(options);
  assert.equal(section.proposal.coverage[0].status, 'represented');
  assert.deepEqual(section.proposal.unresolved, [{
    question: 'The unknown branch has no registered target', sources: [source.id],
  }]);
  assert.deepEqual(await collectDesignSections(options), [section]);
  assert.equal(calls, 1);
  const merged = mergeDesignSections(options.title, [source], [section]);
  assert.equal(merged.graph.nodes[0].id, 'known-route');
  assert.equal(merged.design.unresolved.length, 1);
});

test('a partial Responses result cannot become an artifact even when its JSON is valid', async () => {
  const model = localModel({ provider: 'openai', model: 'fixture', apiKey: 'fixture',
    fetcher: async () => Response.json({ id: 'receipt', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"schemaVersion":1,"nodes":[]}' }] }] }) });
  await assert.rejects(model.planDesign({ title: 'Fixture', materials: [] }), { code: 'FKA_DESIGN_RESPONSE_LIMIT' });
});

test('an explicit Responses refusal cannot become a successful section or a correction request', async () => {
  let calls = 0;
  const refusal = { type: 'refusal', refusal: 'Declined' };
  const validProposal = JSON.stringify({ schemaVersion: 1,
    nodes: [{ id: 'start', name: 'Start', description: 'Read request', sources: ['source'] }],
    edges: [], unresolved: [], coverage: [{ source: 'source', status: 'represented', reason: 'First step' }] });
  for (const content of [[refusal], [{ type: 'output_text', text: validProposal }, refusal]]) {
    const model = localModel({ provider: 'openai', model: 'fixture', apiKey: 'fixture',
      fetcher: async () => {
        calls++;
        return Response.json({ id: 'refused', status: 'completed', output: [{ type: 'message', content }] });
      } });
    await assert.rejects(collectDesignSections({ title: 'Fixture', materials: [{ id: 'source', title: 'Guide', content: 'Read' }],
      modelIdentity: 'fixture', authorize: async () => {}, load: () => null, save: () => assert.fail('Refusal was saved'),
      plan: input => model.planDesign(input), signal: new AbortController().signal }), { code: 'FKA_DESIGN_RESPONSE_REFUSED' });
  }
  assert.equal(calls, 2);
});

test('a completed malformed section permits one retained correction subject to fresh authorization', async () => {
  const cache = new Map();
  const corrections = [];
  let checks = 0;
  let fix = true;
  let malformedField = 'key';
  const input = {
    title: 'Design', materials: [{ id: 'source', title: 'Source', content: 'First step' }],
    signal: new AbortController().signal, modelIdentity: 'fixture',
    async authorize() { if (++checks === 2) throw new Error('Authorization revoked'); },
    load: key => cache.get(key), save: (key, value) => cache.set(key, value),
    async plan({ correction }) {
      corrections.push(correction);
      const node = { id: 'step', name: 'Step', description: 'First step', sources: ['source'] };
      if (!correction || !fix) {
        if (malformedField === 'key') node.key = null;
        else node.name = '"Step"';
      }
      return { status: 'completed', requestId: 'test-' + corrections.length, proposal: { schemaVersion: 1,
        nodes: [node], edges: [], unresolved: [], coverage: [{ source: 'source', status: 'represented', reason: 'Observed' }] } };
    }
  };
  await assert.rejects(collectDesignSections(input), /Authorization revoked/);
  assert.equal(corrections.length, 1);
  const [section] = await collectDesignSections(input);
  assert.match(corrections[1], /nodes\[0\]\.key/);
  assert.equal(section.requestId, 'test-2');
  await collectDesignSections(input);
  assert.equal(corrections.length, 2);

  cache.clear();
  fix = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(collectDesignSections(input), { code: 'FKA_DESIGN_SECTION_INVALID', message: /nodes\[0\]\.key/ });
  }
  assert.equal(corrections.length, 4);

  cache.clear();
  fix = true;
  malformedField = 'name';
  const [withCompatibleName] = await collectDesignSections(input);
  assert.match(corrections[5], /nodes\[0\]\.name/);
  assert.equal(withCompatibleName.requestId, 'test-6');
});

test('one populated scope can still be selected and retains its own unresolved handoff evidence', async () => {
  const materials = Array.from({length: 7}, (_, index) => ({ id: 'part-' + index, title: 'Part ' + index, content: 'fixture' }));
  const sections = await collectDesignSections({ title: 'Sparse project', materials, signal: new AbortController().signal,
    modelIdentity: 'fixture', authorize: async () => {}, load: () => null, save() {},
    async plan({ materials: [material] }) {
      const populated = material.id === 'part-6';
      const proposal = { schemaVersion: 1, nodes: populated ? [{ id:'start',name:'Start',description:'Starts work',sources:[material.id] }] : [],
        edges: [], unresolved: [], handoffs: populated ? [{ from:'start',target:'not-found',description:'External handoff',sources:[material.id] }] : [],
        coverage: [{ source:material.id, status:populated?'represented':'no-steps', reason:'Reviewed material' }] };
      return { status:'completed', requestId:material.id, proposal };
    }
  });
  const result = mergeDesignSections('Sparse project', materials, sections);
  const canvas = planDesignCanvas(result.graph, result.design);
  assert.equal(canvas.root.length, 1);
  assert.equal(canvas.groups[0].members[0], result.graph.nodes[0].id);
  assert.equal(result.design.groups.at(-1).id, sections.at(-1).id);
  assert.equal(result.design.groups.at(-1).unresolved[0].question, '确认跨组目标 not-found');
  assert.deepEqual(result.design.groups.at(-1).unresolved[0].ranges, ['part-6']);
  assert.ok(result.design.groups.slice(0, -1).every(group => group.unresolved.length === 0));
});
