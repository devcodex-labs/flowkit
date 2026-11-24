import { evaluateWhenAst } from '../../when/evaluate.mjs';
import { interactiveDiagnostic } from './feature-gate.mjs';

const PRESENT = 1;
const MISSING = 2;
const UNAVAILABLE = 4;
const RACE_MISSING = 8;
const states = [PRESENT, MISSING, UNAVAILABLE, RACE_MISSING];
const unknownValue = Symbol('unknown predicate input');

function predicateValue(ast, key, available) {
  if (ast.kind === 'literal') return typeof ast.value === 'boolean' ? ast.value : null;
  const input = Object.create(null);
  const pending = [ast];
  while (pending.length) {
    const part = pending.pop();
    if (part.kind === 'path') {
      const root = part.parts[0];
      if ((available || root !== key) && !Object.hasOwn(input, root)) {
        // Let the real evaluator short-circuit before it reaches an unknown input.
        Object.defineProperty(input, root, { get() { throw unknownValue; } });
      }
    }
    if (part.operand) pending.push(part.operand);
    if (part.left) pending.push(part.left, part.right);
  }
  try { return evaluateWhenAst(ast, input); }
  catch (error) {
    if (error === unknownValue) return undefined;
    if (error.code !== 'FK_R002') throw error;
    return null; // This path stops on a predicate error.
  }
}

function afterStep(node, key, state) {
  if (node.type === 'action' && node.writes?.includes(key)) {
    // Action patches may omit or remove any declared write.
    return PRESENT | (state === PRESENT ? MISSING : state);
  }
  if (node.type === 'agent' && Object.hasOwn(node.output.properties ?? {}, key)) {
    const required = Array.isArray(node.output.required) && node.output.required.includes(key);
    return required ? PRESENT : PRESENT | state;
  }
  return node.type === 'human' && node.id === key ? PRESENT : state;
}

function afterJoin(result, state, marksRaceKeys) {
  if (result === 0 || result === PRESENT) return result;
  if (marksRaceKeys || state === UNAVAILABLE) return (result & PRESENT) | UNAVAILABLE;
  // A child scope returns its patch, without its local runtime guard.
  // Explicit Action reads still require the underlying key to be present.
  return (result & (PRESENT | MISSING)) |
    (result & (UNAVAILABLE | RACE_MISSING) ? RACE_MISSING : 0);
}

/** Detect a consumer that can miss a declared branch key on a successful P2 race. */
export function parallelInputDiagnostics(literal, graph, context, conditions) {
  const nodes = literal.definition.nodes;
  if (!nodes.some(node => node.type === 'parallel' && node.join.strategy === 'any')) return [];
  const indices = new Map(nodes.map((node, index) => [node.id, index]));
  const scopes = new Map();
  const raceKeys = new Set();
  for (const node of nodes) {
    if (node.type !== 'parallel') continue;
    const branches = graph.subflowBranches.get(node.id);
    const lanes = node.branches.map(entry => {
      const members = branches?.get(entry);
      const keys = new Set([...(members ?? [entry])].flatMap(id => [...graph.writeSets.get(id)]));
      if (node.join.strategy === 'any') for (const key of keys) raceKeys.add(key);
      return { entry, members, keys };
    });
    scopes.set(node.id, lanes);
  }
  const unsafe = new Map();
  for (const key of raceKeys) {
    const memo = new Map();
    const requireInput = (node, state) => {
      const actionRead = node.type === 'action' && node.reads?.includes(key);
      const wholeState = node.type === 'action' && node.reads === undefined;
      const agentInput = node.type === 'agent' && node.inputs?.includes(key);
      const lost = state === UNAVAILABLE || actionRead && state === RACE_MISSING;
      const blocked = actionRead && state !== PRESENT || state === UNAVAILABLE && (wholeState || agentInput);
      if (blocked && lost) {
        if (!unsafe.has(node.id)) unsafe.set(node.id, new Set());
        unsafe.get(node.id).add(key);
      }
      return !blocked;
    };

    function join(node, state) {
      const id = node.id + '/' + state;
      if (memo.has(id)) return memo.get(id);
      const lanes = scopes.get(node.id);
      const outcomes = lanes.map(({ entry, members }) => {
        if (members) return walk(entry, state, members, node.join.next);
        const member = graph.byId.get(entry);
        if (!requireInput(member, state)) return 0;
        return member.type === 'verification' && entry === key ? PRESENT : afterStep(member, key, state);
      });
      const race = node.join.strategy === 'any';
      const writers = lanes.map(lane => lane.keys.has(key));
      // The graph rejects overlapping declared writes for all_succeeded.
      const result = race ? outcomes.reduce((merged, outcome) => merged | outcome, 0)
        : outcomes.includes(0) ? 0 : outcomes[writers.indexOf(true)] ?? state;
      const merged = afterJoin(result, state, race && writers.includes(true));
      memo.set(id, merged);
      return merged;
    }

    function walk(entry, state, members, boundary) {
      const pending = [[entry, state]];
      const seen = new Map();
      let exits = 0;
      function enqueue(target, mask) {
        for (const next of states) if (mask & next) pending.push([target, next]);
      }
      while (pending.length) {
        const [id, input] = pending.pop();
        if (id === boundary) { exits |= input; continue; }
        if (members && !members.has(id) || (seen.get(id) ?? 0) & input) continue;
        seen.set(id, (seen.get(id) ?? 0) | input);
        const node = graph.byId.get(id);
        if (!requireInput(node, input)) continue;
        if (node.type === 'terminal') {
          if (node.status === 'succeeded') exits |= input;
        } else if (node.type === 'parallel') {
          enqueue(node.join.next, join(node, input));
        } else if (node.type === 'condition') {
          for (const [index, branch] of node.branches.entries()) {
            const ast = conditions.get('/nodes/' + indices.get(id) + '/branches/' + index + '/when');
            const value = predicateValue(ast, key, input === PRESENT);
            if (value === null) break;
            if (value !== false) enqueue(branch.next, input);
            if (value === true) break;
          }
        } else {
          const success = afterStep(node, key, input);
          for (const edge of graph.outgoing.get(id)) {
            const rejects = edge.path === '/onError' || edge.role === 'action-failure';
            enqueue(edge.to, rejects ? input : success);
          }
        }
      }
      return exits;
    }

    const entry = nodes[0].id;
    const schema = literal.definition.contract?.input;
    if (!schema?.required?.includes(key)) walk(entry, MISSING);
    if (schema?.additionalProperties !== false || Object.hasOwn(schema.properties ?? {}, key)) walk(entry, PRESENT);
  }
  return nodes.flatMap((node, index) => {
    const missing = unsafe.get(node.id);
    if (!missing) return [];
    const reads = node.type === 'agent' ? 'inputs' : 'reads';
    const subject = node[reads] === undefined ? 'reads the whole state, including keys' : 'requires keys';
    return [interactiveDiagnostic({ literal, snapshot: context.source }, 'FK_I_PARALLEL_INPUT',
      'Node ' + JSON.stringify(node.id) + ' ' + subject + ' that may be unavailable after a successful Parallel any join: ' +
      [...missing].sort().map(key => JSON.stringify(key)).join(', ') +
      '. Declare ' + reads + ' using only guaranteed keys, or ensure that every successful winner provides the required values.',
      index, node, '/' + reads)];
  });
}
