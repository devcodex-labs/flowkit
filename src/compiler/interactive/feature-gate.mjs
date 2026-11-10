/**
 * M1-only Interactive feature gate. The Standard analyzer remains the single
 * authority for DSL syntax, graph, dataflow, and existing FK_C/FK_R codes.
 * Runtime binding checks (including checkStep) are enforced at start in M4.
 */
export const IMPLEMENTED_INTERACTIVE_STAGE = 'P0-A';
const STAGES = Object.freeze(['P0-A', 'P0-B', 'P1']);
const ENABLED = new Set(['condition', 'terminal', 'agent']);

function interactiveDiagnostic(analysis, code, message, index, node) {
  const location = index === undefined ? { line: 1, column: 1 }
    : analysis.literal.locations.get('/nodes/' + index) ?? { line: 1, column: 1 };
  return Object.freeze({
    code, severity: 'error', message, file: analysis.snapshot.absFilename,
    line: location.line, column: location.column,
    ...(node ? { nodeId: node.id } : {}),
  });
}

/** Return the original analyzer diagnostics unchanged, appending only stage-gate errors. */
export function gateInteractiveFeatures(analysis, options = {}) {
  if (!analysis || !analysis.snapshot || !Array.isArray(analysis.diagnostics)) {
    throw new TypeError('A completed analyzeSource() result is required');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Interactive feature options must be an object');
  }
  const featureStage = options.featureStage ?? IMPLEMENTED_INTERACTIVE_STAGE;
  const extras = [];
  if (!STAGES.includes(featureStage)) {
    extras.push(interactiveDiagnostic(analysis, 'FK_I_INVALID_STAGE',
      'Unknown Interactive feature stage: ' + String(featureStage)));
  } else if (featureStage !== IMPLEMENTED_INTERACTIVE_STAGE) {
    extras.push(interactiveDiagnostic(analysis, 'FK_I_UNSUPPORTED_STAGE',
      'This build implements only P0-A; caller cannot enable ' + featureStage));
  }

  // Never lower partially validated DSL, and never replace Standard diagnostics.
  const standardValid = !!analysis.graph && !!analysis.literal && !!analysis.dataflow
    && !analysis.diagnostics.some(item => item.severity === 'error');
  if (standardValid) {
    analysis.literal.definition.nodes.forEach((node, index) => {
      if (!ENABLED.has(node.type)) {
        extras.push(interactiveDiagnostic(analysis, 'FK_I_UNSUPPORTED_NODE',
          'P0-A does not support node type ' + String(node.type), index, node));
      } else if (node.type === 'agent' && node.verify != null) {
        extras.push(interactiveDiagnostic(analysis, 'FK_I_UNSUPPORTED_BINDING',
          'P0-A Agent verify requires P0-B; it must not be skipped', index, node));
      }
    });
  }
  const diagnostics = Object.freeze([...analysis.diagnostics, ...extras]);
  return Object.freeze({
    ok: standardValid && extras.length === 0,
    featureStage, diagnostics,
  });
}
