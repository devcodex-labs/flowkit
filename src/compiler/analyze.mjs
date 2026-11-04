import { readFile } from 'node:fs/promises';
import { createSourceSnapshot, createCompileContext, normalizeOptions, sortDiagnostics } from './source.mjs';
import { extractWorkflow } from './extract.mjs';
import { validateFields } from './validate.mjs';
import { checkSkills } from './skill-check.mjs';

/** Private front end; an empty diagnostic list does not establish graph validity. */
export async function analyzeSource(source, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const snapshot = createSourceSnapshot(source, options.filename);
  const context = createCompileContext(snapshot, options);
  const { literal, diagnostics } = extractWorkflow(snapshot);
  if (literal) diagnostics.push(...validateFields(literal, context), ...await checkSkills(literal, context));
  return { snapshot, context, literal, diagnostics: sortDiagnostics(diagnostics) };
}

/** Preserve file read errors and original bytes for the future compiler API. */
export async function analyzeFile(filename, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.hasOwn(options, 'filename')) {
    throw new TypeError('File analysis options cannot contain filename');
  }
  return analyzeSource(await readFile(filename), { ...normalizeOptions(options), filename });
}
