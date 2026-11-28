import { diagnostic } from './source.mjs';

export const pascalCase = id => id.split('-').map(segment => segment[0].toUpperCase() + segment.slice(1)).join('');
const label = text => `"${String(text).replace(/[&"<>\[\]{}|#]/g, character => `#${character.codePointAt(0)};`)}"`;
export { label as mermaidLabel };

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
  const visualOwners=new Map([...graph.owners].filter(([,owner])=>graph.regions.get(owner).kind!=='human'));
  const subflows=[...graph.subflowBranches].map(([id,branches])=>
    ({id,members:new Set([...branches.values()].flatMap(members=>[...members]))}))
    .sort((left,right)=>left.members.size-right.members.size);
  for (const {id,members} of subflows) for (const member of members) {
    if (!visualOwners.has(member)) visualOwners.set(member,id);
  }
  function draw(node,indent) {
    if (drawn.has(node.id)) return;
    drawn.add(node.id);
    if (['parallel', 'loop'].includes(node.type)) {
      lines.push(`${indent}subgraph ${pascalCase(node.id)}[${label(`${node.name} · ${node.type === 'parallel' ? node.join.strategy : `最多 ${node.maxIterations} 次`}`)}]`);
      const inner=indent+'  ';
      if (node.type === 'parallel') lines.push(`${inner}${start(node.id)}((${label('并行')}))`);
      for (const member of nodes.filter(member=>visualOwners.get(member.id)===node.id)) draw(member,inner);
      if (node.type === 'parallel') lines.push(`${inner}${join(node.id)}((${label('汇合')}))`);
      lines.push(indent+'end');
    } else declaration(node,indent);
  }
  for (const node of nodes) if (!visualOwners.has(node.id)) draw(node,'  ');
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
    if (item.role === 'human-reject' && node.onDecline) text = '请求修改';
    if (item.role === 'human-decline') text = '拒绝或用尽修改次数';
    if (item.role === 'loop-pass') text = '成功';
    if (item.role === 'loop-repair') { const owner = graph.byId.get(graph.owners.get(item.from));
      if (owner.maxIterations === 1) continue;
      text = `失败（第1–${owner.maxIterations - 1}次）`; }
    if (item.role === 'loop-exhausted') {
      text = `超过次数（第${graph.byId.get(graph.owners.get(item.from)).maxIterations}次失败不再修复）`; dashed = true;
    }
    if (item.path === '/onError') { text = '出错'; dashed = true; }
    const enclosing=subflows.find(({id,members})=>members.has(item.from)&&graph.byId.get(id).join.next===item.to);
    edge(from,enclosing?join(enclosing.id):endpoint(item.to),text,dashed);
  }
  for (const node of nodes.filter(node => node.type === 'parallel')) {
    if (node.branchMode!=='subflow') for (const id of node.branches) edge(endpoint(id), join(node.id));
    const enclosing=subflows.find(({id,members})=>members.has(node.id)&&graph.byId.get(id).join.next===node.join.next);
    edge(join(node.id),enclosing?join(enclosing.id):endpoint(node.join.next));
    edge(join(node.id), '_FlowkitException', node.join.strategy === 'any' ? '控制信号 / 全部业务失败' : '控制信号（最先拒绝者）', true);
    exception = true;
  }
  for (const node of nodes.filter(node=>node.type==='terminal'&&node.status==='succeeded')) {
    const enclosing=subflows.find(({members})=>members.has(node.id));
    if (enclosing) edge(endpoint(node.id),join(enclosing.id));
  }
  if (exception) lines.push(`  _FlowkitException(${label('异常结束')})`);
  return lines.join('\n') + '\n';
}
