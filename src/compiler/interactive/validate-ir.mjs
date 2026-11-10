/**
 * P0-A resumable IR phase matrix. The lowerer and its validator share this
 * table; the Coordinator must NOT reconstruct graph routing from source DSL.
 */
export const P0A_PHASES = Object.freeze({
  condition: Object.freeze(['enter', 'route']),
  terminal: Object.freeze(['enter', 'route']),
  agent: Object.freeze(['enter', 'prepare', 'dispatch-ready', 'awaiting', 'validate', 'commit', 'route']),
});

const RULES = Object.freeze({
  condition: Object.freeze({
    enter: [['internal-step', 'deterministic-failure'], ['move', 'raise-error']],
    route: [['internal-step', 'deterministic-failure'], ['move', 'raise-error']],
  }),
  terminal: Object.freeze({
    enter: [['internal-step', 'deterministic-failure'], ['move', 'raise-error']],
    route: [['internal-step', 'deterministic-failure'], ['terminal', 'raise-error']],
  }),
  agent: Object.freeze({
    enter: [['internal-step', 'deterministic-failure'], ['move', 'raise-error']],
    prepare: [['internal-step', 'pending-prepared', 'deterministic-failure'], ['prepare-pending', 'raise-error']],
    'dispatch-ready': [['pending-prepared', 'deterministic-failure'], ['publish-pending', 'raise-error']],
    awaiting: [[], []], // Coordinator accepts a receipt transaction; advance() is never called.
    validate: [
      ['agent-result', 'agent-call-failed', 'validation-passed', 'validation-rejected', 'deterministic-failure'],
      ['retry-agent', 'commit-candidate', 'raise-error'],
    ],
    commit: [['internal-step', 'deterministic-failure'], ['commit-state', 'raise-error']],
    route: [['internal-step', 'deterministic-failure'], ['move', 'raise-error']],
  }),
});

export const interactiveBlockId = (nodeId, phase) => nodeId + '::' + phase;

export function phaseContract(kind, phase) {
  const record = RULES[kind]?.[phase];
  if (!record) return null;
  return { eventKinds: [...record[0]], proposalKinds: [...record[1]] };
}

/** This derives edges from already-lowered node metadata, not from the DSL parser. */
export function expectedBlockTargets(ir, nodeId, phase) {
  const record = ir.nodes?.[nodeId];
  if (!record) return null;
  const metadata = record.metadata;
  const target = (id, p) => interactiveBlockId(id, p);
  if (phase === 'enter') return [target(nodeId, record.kind === 'agent' ? 'prepare' : 'route')];
  if (record.kind === 'agent') {
    if (phase === 'prepare') return [target(nodeId, 'dispatch-ready')];
    if (phase === 'dispatch-ready') return [target(nodeId, 'awaiting')];
    if (phase === 'awaiting') return [target(nodeId, 'validate')];
    if (phase === 'validate') return [target(nodeId, 'prepare'), target(nodeId, 'commit')];
    if (phase === 'commit') return [target(nodeId, 'route')];
    if (phase === 'route') return [target(metadata.next, 'enter')];
  }
  if (record.kind === 'condition' && phase === 'route') {
    return [...new Set(metadata.branches.map(branch => target(branch.next, 'enter')))];
  }
  if (record.kind === 'terminal' && phase === 'route') return [];
  return null;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

/**
 * Internal M1 check, not a security boundary for untrusted compiled programs.
 * M2 additionally validates the Program ABI and identity at load and execution.
 */
export function validateInteractiveIR(ir) {
  const errors = [];
  const bad = message => errors.push(Object.freeze({
    code: 'FK_I_INVALID_IR', severity: 'error', message,
  }));
  if (!ir || typeof ir !== 'object' || ir.schemaVersion !== 1 || ir.featureStage !== 'P0-A'
      || !Array.isArray(ir.blocks) || !ir.nodes || typeof ir.nodes !== 'object') {
    return { ok: false, diagnostics: Object.freeze([{ code: 'FK_I_INVALID_IR', severity: 'error', message: 'Invalid IR envelope' }]) };
  }
  const ids = Object.keys(ir.nodes);
  if (!ids.length || ids.length > 500 || ir.blocks.length > 3500) bad('Invalid P0-A IR size');
  if (ir.entryBlockId !== interactiveBlockId(ids[0], 'enter')) bad('Invalid entry block');
  if (!/^[a-f0-9]{64}$/.test(ir.sourceHash ?? '')) bad('Invalid source hash');
  const table = new Map();
  for (const block of ir.blocks) {
    if (!block || typeof block.id !== 'string') { bad('Malformed block'); continue; }
    if (table.has(block.id)) bad('Duplicate block: ' + block.id);
    table.set(block.id, block);
  }
  let expectedCount = 0;
  for (const id of ids) {
    const record = ir.nodes[id];
    if (!record || !Object.hasOwn(P0A_PHASES, record.kind)) {
      bad('Unsupported node kind: ' + id); continue;
    }
    const phases = P0A_PHASES[record.kind];
    expectedCount += phases.length;
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== 'object') { bad('Missing metadata: ' + id); continue; }
    if (record.kind === 'condition') {
      if (!Array.isArray(metadata.branches) || !metadata.branches.length
        || metadata.branches.some(branch => !branch || typeof branch.when !== 'string'
          || !branch.ast || typeof branch.ast.kind !== 'string' || typeof branch.next !== 'string')) {
        bad('Malformed condition branches: ' + id);
      }
    }
    if (record.kind === 'agent' && (!Array.isArray(metadata.inputs) || !metadata.output
      || !Number.isInteger(metadata.retries) || metadata.retries < 0 || metadata.retries > 10)) {
      bad('Malformed Agent metadata: ' + id);
    }
    if (record.kind === 'terminal' && !['succeeded', 'failed'].includes(metadata.status)) {
      bad('Invalid terminal status: ' + id);
    }
    for (const phase of phases) {
      const blockId = interactiveBlockId(id, phase);
      const block = table.get(blockId);
      const contract = phaseContract(record.kind, phase);
      const targets = expectedBlockTargets(ir, id, phase);
      if (!block) { bad('Missing block: ' + blockId); continue; }
      if (block.nodeId !== id || block.phase !== phase || block.id !== blockId
        || !sameArray(block.eventKinds, contract.eventKinds)
        || !sameArray(block.proposalKinds, contract.proposalKinds)
        || !targets || !sameArray(block.legalTargets, targets)) {
        bad('Illegal phase contract or edge: ' + blockId);
      }
      const acceptTarget = phase === 'awaiting' ? interactiveBlockId(id, 'validate') : undefined;
      if (block.acceptTarget !== acceptTarget) bad('Invalid receipt accept target: ' + blockId);
    }
  }
  if (ir.blocks.length !== expectedCount) bad('Unexpected block count');
  for (const block of ir.blocks) {
    if (!block || !Array.isArray(block.legalTargets)) continue;
    for (const target of block.legalTargets) {
      if (!table.has(target)) bad('Unknown block target: ' + target);
    }
  }
  // A reachable Program is required: no hidden phases may bypass the entry.
  const reached = new Set();
  const pending = [ir.entryBlockId];
  while (pending.length) {
    const next = pending.pop();
    if (reached.has(next)) continue;
    reached.add(next);
    for (const target of table.get(next)?.legalTargets ?? []) if (table.has(target)) pending.push(target);
  }
  for (const id of table.keys()) if (!reached.has(id)) bad('Unreachable phase: ' + id);
  return Object.freeze({ ok: errors.length === 0, diagnostics: Object.freeze(errors) });
}
