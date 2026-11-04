import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSourceSnapshot, resolveProjectRoot } from '../compiler/source.mjs';
import { compileToText } from '../compiler/compile.mjs';
import { executionOptions, validateExecutionArguments } from './context.mjs';
import { executeWorkflow } from './execute.mjs';
import { loadWorkflowText } from './load.mjs';

/** Internal DSL-only execution path; public routing, default Skills, AOT, cache and dump are assembled later. */
export async function executeSource(file, runtime, state, suppliedOptions) {
  const cwd = process.cwd();
  const options = executionOptions(suppliedOptions);
  if (typeof file !== 'string' || !/\.workflow\.(?:ts|js)$/.test(file)) throw new TypeError('file must end in .workflow.ts or .workflow.js');
  validateExecutionArguments(runtime, state);
  const filename = path.resolve(cwd, file);
  const projectRoot = resolveProjectRoot(filename, options.projectRoot, cwd);
  const compileOptions = { ...options, projectRoot, outDir: path.dirname(filename), mermaid: false };
  const snapshot = createSourceSnapshot(await readFile(filename), filename);
  const compiled = await compileToText(snapshot, compileOptions);
  const first = compiled.diagnostics.find(item => item.severity === 'error');
  if (first) throw Object.assign(new Error(`${first.code} Compilation failed: ${compiled.diagnostics.filter(item => item.severity === 'error').length} error(s); first: ${first.message}`),
    { phase: 'compile', code: first.code, diagnostics: compiled.diagnostics });
  const workflow = await loadWorkflowText(compiled.code);
  return executeWorkflow(workflow, runtime, state, options);
}
