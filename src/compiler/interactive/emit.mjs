import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { evaluateWhenAst } from '../../when/evaluate.mjs';
import { validateInteractiveIR } from './validate-ir.mjs';

const compilerVersion = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
const SHA = value => 'sha256:' + createHash('sha256').update(value).digest('hex');

// The generated program includes the original Standard evaluator *implementation*.
// Only requireBoolean is a tiny standalone wrapper for its existing free binding.
function requireBoolean(value) {
  if (typeof value !== 'boolean') throw Object.assign(new Error('When operand and final result must be boolean'), { code: 'FK_R002' });
  return value;
}

/** Emits executable, synchronous JavaScript. No application code is run while compiling. */
function advance(view, event) {
  if (!view || !event || event.schemaVersion !== 1 || view.blockId !== event.forBlockId) {
    throw new TypeError('Event does not target the current checkpoint block');
  }
  const blockId = view.blockId;
  const phase = view.phase;
  const block = programTable.blocks.find(item => item.id === blockId);
  if (!block || block.phase !== phase || !block.eventKinds.includes(event.kind)) {
    throw new TypeError('Uncertified event or invalid stage');
  }
  const nodeId = block.nodeId;
  const record = programTable.nodes[nodeId];
  const none = { kind: 'none' };
  const proposal = (kind, toBlockId, stackEffect = none, mergeIntent = none) =>
    ({ kind, fromBlockId: blockId, nodeId, toBlockId, stackEffect, mergeIntent });
  const fail = code => ({
    kind: 'raise-error', fromBlockId: blockId, nodeId,
    causeCode: code || 'FK_R002', stackEffect: none, mergeIntent: none,
  });
  if (event.kind === 'deterministic-failure') return fail(event.error?.code);
  const to = (node, name) => node + '::' + name;
  if (phase === 'enter') {
    if (record.kind === 'agent') {
      if (!Number.isSafeInteger(event.activation) || event.activation < 1) {
        throw new TypeError('Missing certified Agent activation');
      }
      const frame = {
        kind: 'agent', nodeId, activation: event.activation,
        attempt: 1, phase: 'prepare', reasons: [], overviewStep: event.activation,
      };
      return proposal('move', to(nodeId, 'prepare'), {kind: 'push', frame});
    }
    return proposal('move', to(nodeId, 'route'));
  }
  if (record.kind === 'condition' && phase === 'route') {
    try {
      for (const branch of record.metadata.branches) {
        if (evaluateWhenAst(branch.ast, view.state)) {
          return proposal('move', to(branch.next, 'enter'));
        }
      }
    } catch (error) {
      if (error?.code === 'FK_R002') return fail('FK_R002');
      throw error; // trusted Coordinator classifies unexpected program failures
    }
    return fail('FK_R002');
  }
  if (record.kind === 'terminal' && phase === 'route') {
    return {
      kind: 'terminal', fromBlockId: blockId, nodeId,
      terminal: {status: record.metadata.status, nodeId},
      stackEffect: none, mergeIntent: none,
    };
  }
  if (record.kind !== 'agent') throw new TypeError('Unsupported P0-A block');
  const frame = view.controlStack[view.controlStack.length - 1];
  if (!frame || frame.kind !== 'agent' || frame.nodeId !== nodeId) {
    throw new TypeError('Missing certified Agent control frame');
  }
  if (phase === 'prepare') return proposal('prepare-pending', to(nodeId, 'dispatch-ready'));
  if (phase === 'dispatch-ready') return proposal('publish-pending', to(nodeId, 'awaiting'));
  if (phase === 'validate') {
    if (event.kind === 'validation-passed') {
      if (view.candidate?.kind !== 'agent') throw new TypeError('Verified Agent candidate not committed');
      return proposal('commit-candidate', to(nodeId, 'commit'));
    }
    if (event.kind === 'validation-rejected' || event.kind === 'agent-call-failed') {
      const attempts = record.metadata.retries + 1;
      if (frame.attempt >= attempts) return fail('FK_R004');
      return proposal('retry-agent', to(nodeId, 'prepare'),
        {kind: 'update', expectedKind: 'agent', expectedNodeId: nodeId,
          field: 'attempt', value: frame.attempt + 1});
    }
    throw new TypeError('Agent validation event is not ready for Program advancement');
  }
  if (phase === 'commit') {
    if (view.candidate?.kind !== 'agent') throw new TypeError('Missing committed Agent candidate');
    return proposal('commit-state', to(nodeId, 'route'), none,
      {kind:'commit-candidate', requestId:view.candidate.requestId});
  }
  if (phase === 'route') {
    return proposal('move', to(record.metadata.next, 'enter'),
      {kind:'pop', expectedKind:'agent', expectedNodeId:nodeId});
  }
  throw new TypeError('Illegal Program advancement at awaiting/unknown phase');
}
function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeData(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function emitInteractive(ir, options = {}) {
  const validation = validateInteractiveIR(ir);
  if (!validation.ok) {
    return Object.freeze({ code:null, programIdentity:null, diagnostics:validation.diagnostics });
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Emit options must be an object');
  }
  const manifest = {
    artifactFormat:'FlowkitInteractiveProgramV1',
    identity:{
      workflowId: ir.workflowId, workflowVersion:ir.workflowVersion,
      sourceHash: 'sha256:' + ir.sourceHash, compilerVersion,
      programAbiVersion:1, semanticsVersion:'interactive-state-machine-v1',
      checkpointSchemaVersion:1, canonicalizationVersion:'jcs-rfc8785-v1',
      implementedStage:'P0-A',
    },
  };
  const agents = Object.values(ir.nodes).some(node => node.kind === 'agent');
  const bindings = agents ? [
    {id:'runtime.validateResult',version:'1',mode:'pure-local',kind:'agent-validation'},
    {id:'runtime.skillResolver',version:'1',mode:'trusted-read',kind:'skill'},
  ] : [];
  const table = {
    schemaVersion:1, entryBlockId:ir.entryBlockId, blocks:ir.blocks,
    nodes:ir.nodes, requiredBindings:bindings,
  };
  const code = [
    '// @generated by FlowKit Interactive — P0-A / Program ABI V1',
    '// This trusted compiler output MUST be loaded from verified immutable bytes.',
    requireBoolean.toString(),
    evaluateWhenAst.toString(),
    freezeData.toString(),
    'export const interactiveProgram = freezeData(' + JSON.stringify(manifest) + ');',
    'export const programTable = freezeData(' + JSON.stringify(table) + ');',
    'export ' + advance.toString(),
    '',
  ].join('\n');
  const programIdentity = Object.freeze({
    ...manifest.identity, artifactHash:SHA(Buffer.from(code, 'utf8')),
  });
  return Object.freeze({code, programIdentity, diagnostics:Object.freeze([])});
}
