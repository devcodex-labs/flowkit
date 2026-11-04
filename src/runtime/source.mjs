import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSourceSnapshot, resolveProjectRoot } from '../compiler/source.mjs';
import { compileToText } from '../compiler/compile.mjs';
import { executionOptions, validateExecutionArguments } from './context.mjs';
import { executeWorkflow } from './execute.mjs';
import { loadWorkflowText } from './load.mjs';

/** Internal DSL execution with default Skills; public AOT/cache/dump routing is assembled later. */
export async function executeSource(file, runtime, state, suppliedOptions) {
  const cwd = process.cwd();
  const options = executionOptions(suppliedOptions);
  if (typeof file !== 'string' || !/\.workflow\.(?:ts|js)$/.test(file)) throw new TypeError('file must end in .workflow.ts or .workflow.js');
  validateExecutionArguments(runtime, state);
  const filename = path.resolve(cwd, file);
  const projectRoot = resolveProjectRoot(filename, options.projectRoot, cwd);
  const compileOptions = { ...options, projectRoot, outDir: path.dirname(filename), mermaid: false };
  const snapshot = createSourceSnapshot(await readFile(filename), filename);
  const code = await compileSourceText(snapshot, compileOptions);
  const workflow = await loadWorkflowText(code);
  return executeWorkflow(workflow, runtime, state, { ...options, projectRoot });
}

/** Shared diagnostics boundary for cached public run and the uncached internal source path. */
export async function compileSourceText(snapshot, options) {
  const compiled = await compileToText(snapshot, options);
  const first = compiled.diagnostics.find(item => item.severity === 'error');
  if (first) throw Object.assign(new Error(`${first.code} Compilation failed: ${compiled.diagnostics.filter(item => item.severity === 'error').length} error(s); first: ${first.message}`),
    { phase: 'compile', code: first.code, diagnostics: compiled.diagnostics });
  return compiled.code;
}
