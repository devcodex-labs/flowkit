import path from 'node:path';
import { compile, check } from '../compiler/api.mjs';
import { resolveProjectRoot } from '../compiler/source.mjs';
import { parseArguments } from './arguments.mjs';
import { loadConfiguration } from './config.mjs';

function oneLine(error) {
  try {
    const message = error?.message;
    const text = typeof message === 'string' ? message : String(error);
    return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
  } catch { return 'CLI invocation failed'; }
}
const write = value => process.stdout.write(value + '\n');

/** A thin CLI: invocation/configuration failures are exit 2; compiler diagnostics determine 0 or 1. */
export async function main(argv) {
  const cwd = process.cwd();
  let parsed;
  try { parsed = parseArguments(argv); }
  catch (error) { write(oneLine(error)); return 2; }
  const filename = path.resolve(cwd, parsed.file);
  let config;
  try { config = await loadConfiguration(cwd); }
  catch (error) {
    write(JSON.stringify({ code: null, message: oneLine(error), file: 'flowkit.config.mjs', line: 1, column: 1, severity: 'error' }));
    return 2;
  }
  try {
    const options = { ...config, ...parsed.options };
    options.projectRoot = resolveProjectRoot(filename, options.projectRoot, cwd);
    if (options.outDir !== undefined) options.outDir = path.resolve(cwd, options.outDir);
    const diagnostics = parsed.command === 'compile' ? (await compile(filename, options)).diagnostics : await check(filename, options);
    for (const diagnostic of diagnostics) write(JSON.stringify(diagnostic));
    return diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 1 : 0;
  } catch (error) { write(oneLine(error)); return 2; }
}
