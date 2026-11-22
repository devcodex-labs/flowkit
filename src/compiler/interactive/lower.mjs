import { gateInteractiveFeatures } from './feature-gate.mjs';
import { hasTaskSpec } from '../../shared/task-spec.mjs';
import { INTERACTIVE_PHASES, interactiveBlockId, phaseContract, expectedBlockTargets, stepFrameRule, validateInteractiveIR } from './validate-ir.mjs';
import { hasStepFrame } from '../../interactive/protocol.mjs';

function copyData(value) {
  // Analyzer-owned DSL literals/when ASTs are JSON-safe. Preserve own __proto__
  // keys as data and do not resolve any missing runtime input to null.
  return JSON.parse(JSON.stringify(value));
}
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Lower only fully validated ORIGINAL FlowKit analysis, not Stage2's parser.
 * Pure compile-time output: no filesystem writes, calls to models, or runtime IO.
 * The M2 emitter will turn this explicit IR into Program ABI V1 JavaScript.
 */
export function lowerInteractive(analysis, options = {}) {
  const gate = gateInteractiveFeatures(analysis, options);
  if (!gate.ok) return Object.freeze({ ir: null, diagnostics: gate.diagnostics });
  const definitions = analysis.literal.definition.nodes;
  const nodes = Object.create(null);
  for (const [index, node] of definitions.entries()) {
    if (!analysis.graph.byId.has(node.id)) {
      throw new Error('Validated graph is missing node ' + node.id);
    }
    let metadata;
    const parallelOwner=analysis.graph.parallelOwners.get(node.id);
    const parallelNext=parallelOwner && analysis.graph.byId.get(parallelOwner).join.next;
    if (node.type === 'condition') {
      metadata = {
        name: node.name,
        branches: node.branches.map((branch, branchIndex) => {
          const pointer = '/nodes/' + index + '/branches/' + branchIndex + '/when';
          const ast = analysis.conditions.get(pointer);
          if (!ast) throw new Error('Missing validated when AST: ' + pointer);
          return { when: branch.when, ast: copyData(ast), next: branch.next };
        }),
      };
    } else if (node.type === 'agent') {
      metadata = {
        name: node.name, next: node.next??parallelNext,
        ...(node.agent === undefined ? {} : { agent: node.agent }),
        ...(node.skill === undefined ? {} : { skill: node.skill }),
        ...(node.integrity === undefined ? {} : { integrity: node.integrity }),
        ...(node.verify === undefined ? {} : { verify: node.verify }),
        inputs: node.inputs ?? [], output: node.output,
        retries: node.retries ?? 2, overview: node.overview === true,
        ...(hasTaskSpec(node) ? {task: Object.fromEntries(['description','descriptionRefs','requiredSkills']
          .filter(key => node[key] !== undefined).map(key => [key, node[key]]))} : {}),
      };
    } else if (node.type==='action') {
      const failure=analysis.graph.executionEdges.find(edge=>edge.from===node.id && edge.role==='action-failure');
      metadata={name:node.name,action:node.action,writes:node.writes??[],next:node.next??parallelNext,
        ...(failure?{onFailure:failure.to}:{})};
    } else if (node.type==='verification') {
      const region=analysis.graph.regions.get(analysis.graph.owners.get(node.id));
      const loop=region?.kind==='loop' && region.body===node.id ? analysis.graph.byId.get(region.id) : null;
      metadata={name:node.name,verifier:node.verifier,next:loop?.onSuccess??node.onSuccess??parallelNext,
        onFailure:node.onFailure??parallelNext,
        ...(loop?{loop:{id:loop.id,maxIterations:loop.maxIterations,onMaxExceeded:loop.onMaxExceeded}}:{})};
    } else if (node.type==='parallel') {
      metadata={name:node.name,next:node.join.next,strategy:node.join.strategy,branches:node.branches};
    } else if (node.type==='loop') {
      metadata={name:node.name,body:node.body,next:node.onSuccess,onMaxExceeded:node.onMaxExceeded,maxIterations:node.maxIterations};
    } else if (node.type==='human') {
      metadata={name:node.name,next:node.onApprove,onFailure:node.onReject,
        ...(node.maxRevisions===undefined?{}:{maxRevisions:node.maxRevisions})};
    } else {
      metadata = { name: node.name, status: node.status };
    }
    if (parallelOwner) metadata.parallelOwner=parallelOwner;
    nodes[node.id] = { kind: node.type, metadata: copyData(metadata) };
  }
  const first = definitions[0].id;
  const ir = {
    schemaVersion: 1, featureStage: gate.featureStage,
    workflowId: analysis.literal.definition.id,
    workflowVersion: analysis.literal.definition.version,
    sourceHash: analysis.snapshot.sourceHash,
    entryBlockId: interactiveBlockId(first, 'enter'),
    nodes, blocks: [],
    frameRules: definitions.filter(node => hasStepFrame(node.type)).map(node => stepFrameRule(node.id,node.type)),
    // Preserve Standard dataflow as diagnostic evidence; it is not a second
    // source of routing and it is not used to prefill missing Agent inputs.
    dataflow: Object.fromEntries(definitions.map(node => [node.id, {
      reachingKeys: [...(analysis.dataflow.inputs.get(node.id) ?? [])].sort(),
      reachingKeysAfter: [...(analysis.dataflow.outputs.get(node.id) ?? [])].sort(),
    }])),
    graphEdges: analysis.graph.executionEdges.map(edge => ({
      from: edge.from, to: edge.to, role: edge.role,
    })),
  };
  for (const node of definitions) {
    for (const phase of INTERACTIVE_PHASES[node.type]) {
      const contract = phaseContract(node.type, phase);
      const block = {
        id: interactiveBlockId(node.id, phase),
        nodeId: node.id, phase,
        legalTargets: expectedBlockTargets(ir, node.id, phase),
        eventKinds: contract.eventKinds,
        proposalKinds: contract.proposalKinds,
        ...(phase === 'awaiting' ? { acceptTarget: interactiveBlockId(node.id, 'validate') } : {}),
      };
      ir.blocks.push(block);
    }
  }
  const checked = validateInteractiveIR(ir);
  if (!checked.ok) {
    return Object.freeze({ ir: null, diagnostics: Object.freeze([...gate.diagnostics, ...checked.diagnostics]) });
  }
  return Object.freeze({ ir: deepFreeze(ir), diagnostics: gate.diagnostics });
}
