import { diagnostic } from './source.mjs';

export const pascalCase = id => id.split('-').map(segment => segment[0].toUpperCase() + segment.slice(1)).join('');
const label = text => `"${String(text).replace(/[&"<>\[\]{}|#]/g, character => `#${character.codePointAt(0)};`)}"`;

/** Diagnose user ids independently from private anchors used inside subgraphs. */
export function checkMermaidIds(analysis) {
  const seen = new Set();
  const diagnostics = [];
  analysis.literal.definition.nodes.forEach((node, index) => {
    const id = pascalCase(node.id);
    if (seen.has(id)) diagnostics.push(diagnostic(analysis.snapshot, 'FK_C090', `Mermaid id collision: ${id}`,
      analysis.literal.locations.get(`/nodes/${index}/id`), node.id));
    seen.add(id);
  });
  return diagnostics;
}

/** Render semantic edges, not the loop's pass sentinel or a guessed graph of generated JS. */
export function renderMermaid(analysis) {
  const { graph } = analysis;
  const nodes = analysis.literal.definition.nodes;
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const start = id => `_Flowkit${indices.get(id)}Start`;
  const join = id => `_Flowkit${indices.get(id)}Join`;
  const endpoint = id => {
    const node = graph.byId.get(id);
    return node.type === 'parallel' ? start(id) : node.type === 'loop' ? pascalCase(node.body) : pascalCase(id);
  };
  const lines = ['flowchart TD'];
  function declaration(node, indent) {
    const id = pascalCase(node.id);
    const shape = node.type === 'terminal' ? `(${label(node.name)})` :
      ['condition', 'human'].includes(node.type) || node.type === 'verification' &&
        graph.regions.get(graph.owners.get(node.id))?.kind !== 'loop' ? `{${label(node.name)}}` : `[${label(node.name)}]`;
    lines.push(`${indent}${id}${shape}`);
  }
  const drawn = new Set();
  for (const node of nodes) {
    if (drawn.has(node.id) || graph.owners.get(node.id) && graph.regions.get(graph.owners.get(node.id)).kind !== 'human') continue;
    if (['parallel', 'loop'].includes(node.type)) {
      lines.push(`  subgraph ${pascalCase(node.id)}[${label(`${node.name} · ${node.type === 'parallel' ? node.join.strategy : `最多 ${node.maxIterations} 次`}`)}]`);
      if (node.type === 'parallel') lines.push(`    ${start(node.id)}((${label('并行')}))`);
      for (const member of nodes.filter(member => graph.owners.get(member.id) === node.id)) { declaration(member, '    '); drawn.add(member.id); }
      if (node.type === 'parallel') lines.push(`    ${join(node.id)}((${label('汇合')}))`);
      lines.push('  end');
    } else declaration(node, '  ');
    drawn.add(node.id);
  }
  const edge = (from, to, text = '', dashed = false) => lines.push(`  ${from} ${text
    ? dashed ? `-. ${label(text)} .->` : `-- ${label(text)} -->` : dashed ? '-.->' : '-->'} ${to}`);
  let exception = false;
  for (const item of graph.executionEdges) {
    if (item.role === 'loop-body' || item.role === 'parallel-return') continue;
    const node = graph.byId.get(item.from);
    const from = node.type === 'parallel' ? start(node.id) : endpoint(item.from);
    let text = '';
    let dashed = false;
    if (item.role === 'condition-branch') text = node.branches[Number(item.path.split('/')[2])].when;
    if (item.role === 'verification-success') text = '通过';
    if (item.role === 'verification-failure') text = '失败';
    if (item.role === 'human-approve') text = '批准';
    if (item.role === 'human-reject') text = '拒绝';
    if (item.role === 'loop-pass') text = '成功';
    if (item.role === 'loop-repair') { const owner = graph.byId.get(graph.owners.get(item.from));
      if (owner.maxIterations === 1) continue;
      text = `失败（第1–${owner.maxIterations - 1}次）`; }
    if (item.role === 'loop-exhausted') {
      text = `超过次数（第${graph.byId.get(graph.owners.get(item.from)).maxIterations}次失败不再修复）`; dashed = true;
    }
    if (item.role === 'action-failure') { text = '出错'; dashed = true; }
    edge(from, endpoint(item.to), text, dashed);
  }
  for (const node of nodes.filter(node => node.type === 'parallel')) {
    for (const id of node.branches) edge(endpoint(id), join(node.id));
    edge(join(node.id), endpoint(node.join.next));
    edge(join(node.id), '_FlowkitException', node.join.strategy === 'any' ? '控制信号 / 全部业务失败' : '控制信号（最先拒绝者）', true);
    exception = true;
  }
  if (exception) lines.push(`  _FlowkitException(${label('异常结束')})`);
  return lines.join('\n') + '\n';
}
