import { EXIT } from './graph-algorithms.mjs';
import { branchTargets, nextTarget } from './emit-plan.mjs';
import { quote, commentText, printValue, localName } from './values.mjs';
import { emitHelpers } from './helpers.mjs';
import { hasTaskSpec } from '../shared/task-spec.mjs';

/** Share the exact static Skill reference between readable node and header metadata. */
export function agentSkillMetadata(node, skillsRoot) {
  const explicit = Object.hasOwn(node, 'skill');
  const reference = explicit ? node.skill : `${skillsRoot.replace(/\/$/, '')}/${node.agent}.md`;
  return { explicit, reference, remote: /^https:\/\//i.test(reference), integrity: node.integrity ?? null };
}

/** Print the compiler-owned plan as native statements; no node lookup is emitted. */
export function emitWorkflow(analysis, plan) {
  const { graph, literal, context } = analysis;
  const nodes = literal.definition.nodes;
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const name = id => localName(indices.get(id), id);
  const helper = emitHelpers(nodes, context.trace, nodes.some(node => node.type === 'action' && node.onError));
  const output = ['export async function workflow(ctx) {'];
  const line = (level, text = '') => output.push(text ? `${'  '.repeat(level)}${text}` : '');
  for (const text of helper.code.split('\n')) if (helper.code) line(1, text);
  const humanRepairs = new Map();
  for (const region of graph.regions.values()) if (region.kind === 'human') {
    const repairs = [];
    const review=graph.byId.get(region.id);
    if (review.onDecline) {
      if (region.entryTargets.size > 1) line(1, `let ${name(region.id)}BeforeApproval = false;`);
      continue;
    }
    if (plan.contexts.has(review.id)) {
      if (region.entryTargets.size > 1) line(1, `let ${name(review.id)}RepairStart;`);
      continue;
    }
    let current = review.onReject;
    while (current !== region.id) { repairs.push(current); current = graph.byId.get(current).next; }
    humanRepairs.set(region.id, repairs);
    if (region.entryTargets.size > 1) for (const id of repairs) line(1, `let ${name(id)}BeforeApproval = false;`);
  }
  function activate(target, level) {
    const owner = graph.owners.get(target);
    const region = graph.regions.get(owner);
    if (region?.kind !== 'human') return;
    if (!graph.byId.get(owner).onDecline && plan.contexts.has(owner)) {
      if (region.entryTargets.size > 1) line(level, `${name(owner)}RepairStart = ${quote(target)};`);
      return;
    }
    const repairs = humanRepairs.get(owner);
    if (!repairs) {
      if (region.entryTargets.size > 1 && target === graph.byId.get(owner).onReject) {
        line(level, `${name(owner)}BeforeApproval = true;`);
      }
      return;
    }
    for (const id of repairs.slice(repairs.indexOf(target))) line(level, `${name(id)}BeforeApproval = true;`);
  }
  function nodeComment(node, level) {
    let detail = node.type;
    if (node.type === 'agent') {
      if (hasTaskSpec(node)) {
        detail = `agent task; description refs: ${node.descriptionRefs?.length ?? 0}; required Skills: ${node.requiredSkills?.length ?? 0}`;
      } else {
        const skill = agentSkillMetadata(node, context.skillsRoot);
        detail = skill.explicit ? `skill: ${skill.reference}${node.agent ? ` (explicit skill; agent ${node.agent} is not called)` : ''}`
          : `agent: ${node.agent} -> ${skill.reference}`;
        if (skill.remote) detail += `; remote; integrity: ${skill.integrity ?? 'not provided'}`;
      }
      detail += `; inputs: ${(node.inputs ?? []).join(', ') || 'none'}; results: ${Object.keys(node.output.properties ?? {}).join(', ') || 'object'}; attempts: ${(node.retries ?? 2) + 1}`;
    } else if (node.type === 'action') detail += `: ${node.action}${node.onError ? `; error -> ${node.onError}` : ''}`;
    else if (node.type === 'verification') detail += `: ${node.verifier}`;
    line(level, `// [${node.id}] ${commentText(node.name)} · ${commentText(detail)}`);
  }
  function tracedCall(node, expression, level) {
    line(level, `await ${helper.tracing ? `traced(${quote(node.id)}, ${quote(node.name)}, () => ${expression})` : expression};`);
  }
  function agentCall(node) {
    const common = `id: ${quote(node.id)}, name: ${quote(node.name)}`;
    const options = `inputs: ${printValue(node.inputs ?? [])}, output: ${printValue(node.output, `/nodes/${indices.get(node.id)}/output`, literal.propertyOrder)}, retries: ${node.retries ?? 2}, verify: ${quote(node.verify ?? null)}, overview: ${node.overview ?? false}`;
    if (hasTaskSpec(node)) {
      const task = Object.fromEntries(['description', 'descriptionRefs', 'requiredSkills']
        .filter(field => Object.hasOwn(node, field)).map(field => [field, node[field]]));
      const { id, version } = literal.definition;
      return `runPreparedStep({ ${common}, workflow: ${printValue({ id, version })}, task: ${printValue(task)}, ${options} })`;
    }
    const skill = Object.hasOwn(node, 'skill') ? `loadSkill(${quote(node.skill)}${Object.hasOwn(node, 'integrity') ? `, { integrity: ${quote(node.integrity)} }` : ''})`
      : `loadSkillByAgent(${quote(node.agent)})`;
    return `runStep({ ${common}, skill: () => ${skill}, ${options} })`;
  }
  function action(node, level) {
    const call = `runAction(${quote(node.action)}, ${quote(node.name)}, ctx)`;
    if (!node.onError) { tracedCall(node, call, level); return; }
    const flag = `${name(node.id)}ActionOk`;
    line(level, `let ${flag} = true;`);
    line(level, 'try {'); tracedCall(node, call, level + 1);
    line(level, '} catch (error) {');
    line(level + 1, 'if (isControlSignal(error)) throw error;');
    line(level + 1, 'writeOwn(ctx, "error", error);');
    line(level + 1, `${flag} = false;`);
    line(level, '}');
    return flag;
  }
  function leaf(node, level, parallelMember = false) {
    nodeComment(node, level);
    if (node.type === 'agent') tracedCall(node, agentCall(node), level);
    else if (node.type === 'action') action(node, level);
    else if (node.type === 'verification' && parallelMember) line(level,
      `writeOwn(ctx.state, ${quote(node.id)}, await verifyStep(${quote(node.id)}, ${quote(node.verifier)}, ${quote(node.name)}));`);
    else if (node.type === 'terminal') line(level, `return { status: ${quote(node.status)}, terminal: ${quote(node.id)} };`);
  }
  function parallel(node, level) {
    nodeComment(node, level);
    const base = name(node.id);
    const inner = helper.tracing ? level + 1 : level;
    if (helper.tracing) line(level, `await traced(${quote(node.id)}, ${quote(node.name)}, async () => {`);
    line(inner, node.join.strategy === 'any' ? `const ${base}Branches = [` : 'await Promise.all([');
    for (const id of node.branches) {
      line(inner + 1, '(async () => {'); leaf(graph.byId.get(id), inner + 2, true); line(inner + 1, '})(),');
    }
    line(inner, node.join.strategy === 'any' ? '];' : ']);');
    if (node.join.strategy === 'any') {
      line(inner, `const ${base}Pending = new Promise(() => {});`);
      line(inner, '// Install control listeners before Promise.any can settle AggregateError.');
      line(inner, `const ${base}Signals = ${base}Branches.map(p => p.then(() => ${base}Pending, error => { if (isControlSignal(error)) throw error; return ${base}Pending; }));`);
      line(inner, `await Promise.race([...${base}Signals, Promise.any(${base}Branches)]);`);
    }
    if (helper.tracing) line(level, '});');
  }
  function human(node, level) {
    nodeComment(node, level);
    const repairs = humanRepairs.get(node.id);
    const call = `await askHuman(${quote(node.id)}, ${quote(node.name)})`;
    const revisions = `${name(node.id)}Revisions`;
    if (node.maxRevisions !== undefined) line(level, `let ${revisions} = 0;`);
    function checkRejection(inner) {
      if (node.maxRevisions === undefined) return;
      line(inner, `if (${revisions} >= ${node.maxRevisions}) throw Object.assign(new Error("FK_R004 Human revision limit reached"), { code: "FK_R004" });`);
      line(inner, `${revisions}++;`);
    }
    const repair = plan.contexts.get(node.id);
    if (repair) {
      const runRepair = `${name(node.id)}Repair`;
      const start = `${name(node.id)}RepairStart`;
      const initial = graph.regions.get(node.id).entryTargets.size > 1;
      line(level, `const ${runRepair} = async (${initial ? `entry = ${quote(node.onReject)}` : ''}) => {`);
      emitContext(repair, level + 1, () => {}, initial ? 'entry' : undefined);
      line(level, '};');
      if (initial) line(level, `if (${start} !== undefined) await ${runRepair}(${start});`);
      line(level, `while (!(${call})) {`);
      checkRejection(level + 1);
      line(level + 1, `await ${runRepair}();`);
      line(level, '}');
      return;
    }
    if (graph.regions.get(node.id).entryTargets.size === 1) {
      line(level, `while (!(${call})) {`);
      checkRejection(level + 1);
      for (const id of repairs) leaf(graph.byId.get(id), level + 1);
      line(level, '}');
    } else {
      // Only the initial prefix is gated; every rejection runs the full fixed repair chain.
      const first = `${name(node.id)}FirstApproval`;
      line(level, `let ${first} = true;`);
      line(level, 'while (true) {');
      for (const id of repairs) {
        line(level + 1, `if (!${first} || ${name(id)}BeforeApproval) {`);
        leaf(graph.byId.get(id), level + 2); line(level + 1, '}');
      }
      line(level + 1, `${first} = false;`);
      line(level + 1, `if (${call}) break;`);
      checkRejection(level + 1);
      line(level, '}');
    }
  }
  function humanDecision(node,level) {
    nodeComment(node,level);
    const base=name(node.id);
    const call=`reviewHuman(${quote(node.id)}, ${quote(node.name)})`;
    const reviewed=helper.tracing?`traced(${quote(node.id)}, ${quote(node.name)}, () => ${call})`:call;
    const region = graph.regions.get(node.id);
    const initialRepair = region.entryTargets.size > 1;
    const repair = `${base}Repair`;
    const usesRepairRoutine = initialRepair || region.hasFailureExit;
    if (usesRepairRoutine) {
      line(level, `const ${repair} = async () => {`);
      emitContext(plan.contexts.get(node.id), level + 1, (target, inner) => {
        if (target === node.onDecline) line(inner, 'return false;');
      });
      line(level + 1, 'return true;');
      line(level, '};');
    }
    line(level,`let ${base}Approved = false;`);
    if (initialRepair) line(level, `const ${base}Ready = !${base}BeforeApproval || await ${repair}();`);
    line(level,`for (let ${base}Revision = 0; ${initialRepair ? `${base}Ready` : ''}; ${base}Revision++) {`);
    line(level+1,`const decision = await ${reviewed};`);
    line(level+1,`if (decision === "approve") { ${base}Approved = true; break; }`);
    line(level+1,'if (decision === "decline") break;');
    line(level+1,`if (${base}Revision >= ${node.maxRevisions}) { writeOwn(ctx, "error", {code: "FK_R004", message: "Human revision limit reached"}); break; }`);
    if (usesRepairRoutine) line(level + 1, `if (!(await ${repair}())) break;`);
    else emitContext(plan.contexts.get(node.id),level+1);
    line(level,'}');
    return `${base}Approved`;
  }
  function loop(node, level) {
    nodeComment(node, level);
    const base = name(node.id);
    const body = graph.byId.get(node.body);
    line(level, `const ${base}Max = ${node.maxIterations};`);
    line(level, `let ${base}Ok = false;`);
    line(level, `for (let ${base}Attempt = 0; ${base}Attempt < ${base}Max; ${base}Attempt++) {`);
    nodeComment(body, level + 1);
    line(level + 1, `if (await verifyStep(${quote(body.id)}, ${quote(body.verifier)}, ${quote(body.name)})) { ${base}Ok = true; break; }`);
    line(level + 1, `if (${base}Attempt === ${base}Max - 1) break; // No repair after the last failure.`);
    emitContext(plan.contexts.get(node.id), level + 1);
    line(level, '}');
    return `${base}Ok`;
  }
  function ordinary(node, level) {
    if (node.type === 'parallel') parallel(node, level);
    else if (node.type === 'human') human(node, level);
    else leaf(node, level);
  }
  function decision(node, level, branches) {
    let condition;
    if (node.type === 'loop') condition = loop(node, level);
    else if (node.type === 'human') condition=humanDecision(node,level);
    else {
      nodeComment(node, level);
      if (node.type === 'action') condition = action(node, level);
      else if (node.type === 'verification') condition = `(await verifyStep(${quote(node.id)}, ${quote(node.verifier)}, ${quote(node.name)}))`;
    }
    if (node.type === 'condition' && node.branches.length === 1) { branches(0, level); return; }
    const count = branchTargets(node).length;
    for (let index = 0; index < count; index++) {
      const last = index === count - 1;
      line(level, index === 0 ? `if (${node.type === 'condition' ? `evalWhen(ctx, ${quote(node.branches[index].when)})` : condition}) {`
        : last ? '} else {' : `} else if (evalWhen(ctx, ${quote(node.branches[index].when)})) {`);
      const before = output.length;
      branches(index, level + 1);
      if (output.length === before) line(level + 1, `// [${node.id} -> ${branchTargets(node)[index]}] Continue at the shared join.`);
    }
    line(level, '}');
  }
  function sequence(body, level, onEnter) {
    for (const step of body.steps) {
      if (step.kind === 'enter') onEnter(step.target, level);
      else if (step.kind === 'crossing') emitContext(step.context, level, onEnter);
      else if (step.kind === 'decision') decision(graph.byId.get(step.id), level, (index, inner) => sequence(step.branches[index], inner, onEnter));
      else ordinary(graph.byId.get(step.id), level);
    }
  }
  function emitContext(current, level, onEnter = activate, entry) {
    if (current.mode === 'structured') { sequence(current.body, level, onEnter); return; }
    const flag = id => `${name(id)}Reach`;
    for (const id of current.ids) line(level, `let ${flag(id)} = false;`);
    function hop(target, inner) {
      onEnter(target, inner);
      const resolved = current.resolve(target);
      if (resolved !== EXIT) line(inner, `${flag(resolved)} = true;`);
    }
    if (entry && current.entries.length > 1) {
      for (const target of current.entries) {
        line(level, `if (${entry} === ${quote(target)}) {`);
        hop(target, level + 1);
        line(level, '}');
      }
    } else hop(current.entry, level);
    for (const id of current.order) {
      const node = graph.byId.get(id);
      line(level, `if (${flag(id)}) {`);
      if (branchTargets(node).length) decision(node, level + 1, (index, inner) => hop(branchTargets(node)[index], inner));
      else { ordinary(node, level + 1); if (node.type !== 'terminal') hop(nextTarget(node), level + 1); }
      line(level, '}');
    }
  }
  emitContext(plan.root, 1);
  output.push('}');
  return output.join('\n') + '\n';
}
