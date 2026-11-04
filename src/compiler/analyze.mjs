import { readFile } from 'node:fs/promises';
import { createSourceSnapshot, createCompileContext, diagnostic, normalizeOptions, sortDiagnostics } from './source.mjs';
import { extractWorkflow } from './extract.mjs';
import { validateFields } from './validate.mjs';
import { checkSkills } from './skill-check.mjs';
import { analyzeGraph } from './graph.mjs';
import { analyzeDataflow } from './dataflow.mjs';
import { parseWhen, WhenSyntaxError } from '../when/parser.mjs';

/** Private analysis pipeline; it does not generate code or establish SDK runtime validity. */
export async function analyzeSource(source, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const snapshot = createSourceSnapshot(source, options.filename);
  const context = createCompileContext(snapshot, options);
  const { literal, diagnostics } = extractWorkflow(snapshot);
  let graph = null;
  let dataflow = null;
  const conditions = new Map();
  if (literal) {
    const fields = validateFields(literal, context);
    diagnostics.push(...fields);
    if (Array.isArray(literal.definition.nodes)) literal.definition.nodes.forEach((node, index) => {
      if (literal.constructors.get(`/nodes/${index}`).kind !== 'condition' || !Array.isArray(node.branches)) return;
      node.branches.forEach((branch, branchIndex) => {
        if (typeof branch?.when !== 'string') return;
        const pointer = `/nodes/${index}/branches/${branchIndex}/when`;
        try { conditions.set(pointer, parseWhen(branch.when)); }
        catch (error) {
          if (!(error instanceof WhenSyntaxError)) throw error;
          const location = literal.locations.get(pointer);
          if (!fields.some(d => d.code === error.code && d.line === location.line && d.column === location.column)) {
            diagnostics.push(diagnostic(snapshot, error.code, error.message, location, node.id));
          }
        }
      });
    });
    if (fields.every(d => d.severity !== 'error')) {
      const result = analyzeGraph(literal, context);
      graph = result.graph;
      diagnostics.push(...result.diagnostics);
      if (graph) { dataflow = analyzeDataflow(graph, literal, context); diagnostics.push(...dataflow.diagnostics); }
    }
    diagnostics.push(...await checkSkills(literal, context));
  }
  return { snapshot, context, literal, graph, dataflow, conditions, diagnostics: sortDiagnostics(diagnostics) };
}

/** Preserve file read errors and original bytes for the future compiler API. */
export async function analyzeFile(filename, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.hasOwn(options, 'filename')) {
    throw new TypeError('File analysis options cannot contain filename');
  }
  return analyzeSource(await readFile(filename), { ...normalizeOptions(options), filename });
}
