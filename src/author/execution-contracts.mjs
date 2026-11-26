import { artifactDigest } from '../shared/artifact-identity.mjs';
import { isWorkflowId } from '../shared/contracts.mjs';
import { canonicalBytes } from '../interactive/canonical.mjs';
import { interactiveStageForMode } from '../interactive/protocol.mjs';
import { parseWhen } from '../when/parser.mjs';
import { evaluateWhenAst } from '../when/evaluate.mjs';

const hash = /^sha256:[a-f0-9]{64}$/;
const text = (value, limit) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= limit;
const keyList = values => Array.isArray(values) && values.length <= 64 &&
  new Set(values).size === values.length && values.every(value => text(value, 128));
const capability = node => node.type === 'action' ? node.action : node.type === 'verification' ? node.verifier : undefined;
const mismatch = message => Object.assign(new TypeError(message), { code: 'FKA_EXECUTION_CONTRACT' });
const names = values => [...(values ?? [])].sort();
const scalar = value => value === null || typeof value === 'boolean' ||
  typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 256;

function resultRoutes(routes, id, reads, writes) {
  const { key, cases } = routes ?? {};
  if (!text(key, 128) || ![...reads, ...writes].includes(key) || !Array.isArray(cases) ||
      cases.length < 1 || cases.length > 64) throw mismatch(`Invalid result routes for Host action ${id}`);
  const seen = new Set();
  const checked = cases.map(item => {
    const { value, next, settlement } = item ?? {};
    if (!scalar(value) || seen.has(value) || settlement !== undefined && !['applied', 'no-effect'].includes(settlement)) {
      throw mismatch(`Invalid or duplicate result route for Host action ${id}`);
    }
    seen.add(value);
    return { value, next: routeTarget(next, id), ...(settlement === undefined ? {} : { settlement }) };
  });
  return { key, cases: checked };
}

function routeTarget(next, id) {
  if (next?.kind === 'action' && text(next.id, 128)) return { kind: 'action', id: next.id };
  if (next?.kind === 'terminal' && ['succeeded', 'failed'].includes(next.status)) {
    return { kind: 'terminal', status: next.status };
  }
  throw mismatch(`Invalid route target for Host action ${id}`);
}

function matchesTarget(node, target) {
  return node?.type === target.kind && (target.kind === 'action' ? node.action === target.id : node.status === target.status);
}

function describeTarget(target) {
  return target.kind === 'action' ? `Action ${target.id}` : `${target.status} Terminal`;
}

function onlyReadsKey(ast, key) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.kind === 'path' && (node.parts.length !== 1 || node.parts[0] !== key)) return false;
    if (node.operand) pending.push(node.operand);
    if (node.left) pending.push(node.left, node.right);
  }
  return true;
}

function checkResultRoutes(node, { key, cases }, nodes, settledSuccess) {
  const predicates = new Map();
  for (const { value, next, settlement } of cases) {
    if (settlement !== undefined && settlement !== settledSuccess) {
      throw Object.assign(mismatch(`Node ${node.id}: ${key}=${JSON.stringify(value)} cannot use a normal receipt with ${settlement} settlement.`),
        { nodeId: node.id });
    }
    let successor = nodes.get(node.next);
    const visited = new Set();
    try {
      while (successor?.type === 'condition' && !visited.has(successor.id)) {
        visited.add(successor.id);
        const target = successor.branches.find(branch => {
          if (!predicates.has(branch.when)) predicates.set(branch.when, parseWhen(branch.when));
          const predicate = predicates.get(branch.when);
          if (!onlyReadsKey(predicate, key)) throw new TypeError('Condition reads state outside this case');
          return evaluateWhenAst(predicate, { [key]: value });
        });
        successor = nodes.get(target?.next);
      }
    } catch {
      successor = undefined;
    }
    if (!matchesTarget(successor, next)) {
      throw Object.assign(mismatch(`Node ${node.id}: with ${key} set to ${JSON.stringify(value)}, its compiled normal route must reach ${describeTarget(next)}.`),
        { nodeId: node.id });
    }
  }
}

/** Trust comes from the configured Host. Author proposals can only select these contracts. */
export function executionContracts(input = []) {
  if (!Array.isArray(input) || input.length > 96) throw mismatch('Expected a bounded Host execution contract catalog');
  const seen = new Set();
  const entries = input.map(data => {
    const { id, version, kind, implementationDigest, effect, reads, writes, roles = [], rules,
      resultRoutes: routes, noEffectFailureRoute } = data ?? {};
    const key = JSON.stringify([kind, id]);
    if (seen.has(key) || !text(id, 128) || !text(version, 80) || !hash.test(implementationDigest ?? '') ||
        !['action', 'verification'].includes(kind) ||
        !keyList(roles) || roles.some(role => !isWorkflowId(role)) ||
        !Array.isArray(rules) || rules.length < 1 || rules.length > 48 || !rules.every(rule => text(rule, 1000)) ||
        (kind === 'action' ? !['read-only', 'write'].includes(effect) || !keyList(reads) || !keyList(writes)
          : effect !== undefined || reads !== undefined || writes !== undefined || routes !== undefined || noEffectFailureRoute !== undefined)) {
      throw mismatch('Invalid or duplicate Host execution contract for ' + String(id));
    }
    seen.add(key);
    const contract = { id, version, kind, implementationDigest, roles: names(roles), rules: [...rules],
      ...(kind === 'action' ? { effect, reads: names(reads), writes: names(writes),
        ...(routes === undefined ? {} : { resultRoutes: resultRoutes(routes, id, reads, writes) }),
        ...(noEffectFailureRoute === undefined ? {} : { noEffectFailureRoute: routeTarget(noEffectFailureRoute, id) }) } : {}) };
    return { ...contract, digest: artifactDigest(canonicalBytes(contract, 65536)) };
  });
  canonicalBytes(entries, 131072);
  return entries;
}

export function pinExecutionContracts(definition, catalog, roles = [], mode = 'standard') {
  if (!catalog.length) return [];
  const stage = interactiveStageForMode(mode);
  const ledgerBacked = stage !== undefined && stage !== 'P0-A';
  const byCapability = new Map(catalog.map(item => [JSON.stringify([item.kind, item.id]), item]));
  const roleByNode = new Map(roles.map(({ nodeId, id }) => [nodeId, id]));
  const nodes = new Map(definition.nodes.map(node => [node.id, node]));
  return definition.nodes.filter(node => capability(node) !== undefined).map(node => {
    const id = capability(node);
    const binding = byCapability.get(JSON.stringify([node.type, id]));
    const role = roleByNode.get(node.id);
    if (!binding || binding.roles.length && !binding.roles.includes(role) ||
        node.type === 'action' && (JSON.stringify(binding.writes) !== JSON.stringify(names(node.writes)) ||
          mode !== 'standard' && (binding.effect !== node.effect ||
            JSON.stringify(binding.reads) !== JSON.stringify(names(node.reads))))) {
      throw mismatch(`Node ${node.id} does not match the trusted Host contract for ${id}`);
    }
    if (binding.resultRoutes) {
      if (mode === 'standard' && !node.writes?.includes(binding.resultRoutes.key)) {
        throw mismatch(`Node ${node.id} must declare a write to its checked result key ${binding.resultRoutes.key}`);
      }
      const settledSuccess = ledgerBacked ? binding.effect === 'write' ? 'applied' : 'no-effect' : undefined;
      checkResultRoutes(node, binding.resultRoutes, nodes, settledSuccess);
    }
    if (binding.noEffectFailureRoute) {
      // A reconciled failed receipt cannot populate state for a Condition on the normal path.
      if (!ledgerBacked || !matchesTarget(nodes.get(node.onError), binding.noEffectFailureRoute)) {
        throw Object.assign(mismatch(`Node ${node.id}: a reconciled failed receipt with no external effect requires Interactive Action.onError to reach ${describeTarget(binding.noEffectFailureRoute)} directly.`),
          { nodeId: node.id });
      }
    }
    return { nodeId: node.id, id, version: binding.version, digest: binding.digest };
  });
}

export function validateExecutionPins(definition, pins) {
  const nodes = definition.nodes.filter(node => capability(node) !== undefined);
  if (!Array.isArray(pins) || !pins.length || pins.length !== nodes.length || pins.some((pin, i) =>
    !pin || Object.keys(pin).length !== 4 || pin.nodeId !== nodes[i].id || pin.id !== capability(nodes[i]) ||
    !text(pin.version, 80) || !hash.test(pin.digest ?? ''))) throw mismatch('Candidate execution contract pins differ from the compiled nodes');
}
