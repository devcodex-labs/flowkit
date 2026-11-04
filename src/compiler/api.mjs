import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileToText } from './compile.mjs';
import { createSourceSnapshot, normalizeOptions, diagnostic, resolveProjectRoot } from './source.mjs';
import { compilationPaths } from './paths.mjs';
import { writeArtifacts } from './output.mjs';

function sourceFilename(file, cwd) {
  if (typeof file !== 'string' || !/\.workflow\.(?:ts|js)$/.test(file)) throw new TypeError('file must end in .workflow.ts or .workflow.js');
  return path.resolve(cwd, file);
}

function publicOptions(options, withFilename = false) {
  const normalized = normalizeOptions(options);
  if (!withFilename && options != null && Object.hasOwn(options, 'filename')) throw new TypeError('Unknown option: filename');
  return normalized;
}

/** Bind all cwd-dependent values before the first asynchronous operation. */
function input(file, suppliedOptions, withFilename = false, text) {
  const cwd = process.cwd();
  const normalized = publicOptions(suppliedOptions, withFilename);
  const filename = sourceFilename(withFilename ? normalized.filename : file, cwd);
  if (withFilename && typeof text !== 'string') throw new TypeError('text must be a string');
  const outDir = normalized.outDir === undefined ? path.dirname(filename) : path.resolve(cwd, normalized.outDir);
  compilationPaths(filename, { outDir });
  const options = Object.freeze({ ...normalized,
    projectRoot: resolveProjectRoot(filename, normalized.projectRoot, cwd),
    outDir });
  return { filename, options };
}

async function compileSnapshot(snapshot, options) {
  const result = await compileToText(snapshot, options);
  if (!result.diagnostics.some(item => item.severity === 'error')) {
    const entries = [[result.paths.codeFile, result.code]];
    if (options.mermaid !== false) entries.push([result.paths.mermaidFile, result.mermaid]);
    await writeArtifacts(entries);
  }
  return { code: result.code, mermaid: result.mermaid, diagnostics: result.diagnostics };
}

/** Read raw source once; source and compiled artifacts are never imported. */
export async function compile(file, suppliedOptions) {
  const { filename, options } = input(file, suppliedOptions);
  return compileSnapshot(createSourceSnapshot(await readFile(filename), filename), options);
}

/** A virtual filename supplies paths and diagnostics without requiring an on-disk source. */
export async function compileSource(text, suppliedOptions) {
  const { filename, options } = input(undefined, suppliedOptions, true, text);
  return compileSnapshot(createSourceSnapshot(text, filename), options);
}

/** Recompile on every call and compare only an existing compiled JS artifact, without writing. */
export async function check(file, suppliedOptions) {
  const { filename, options } = input(file, suppliedOptions);
  const snapshot = createSourceSnapshot(await readFile(filename), filename);
  const result = await compileToText(snapshot, options);
  if (result.diagnostics.some(item => item.severity === 'error')) return result.diagnostics;
  let existing;
  try { existing = await readFile(result.paths.codeFile); }
  catch (error) { if (error.code === 'ENOENT') return result.diagnostics; throw error; }
  if (!existing.equals(Buffer.from(result.code, 'utf8'))) {
    result.diagnostics.push({ ...diagnostic(snapshot, 'FK_R001', 'Existing compiled artifact differs from the current source or options'),
      file: result.paths.codeFile });
  }
  return result.diagnostics;
}
