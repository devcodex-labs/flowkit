import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSourceSnapshot, resolveProjectRoot } from '../compiler/source.mjs';
import { executionOptions, validateExecutionArguments } from './context.mjs';
import { compileSourceText } from './source.mjs';
import { readAOT } from './aot.mjs';
import { loadWorkflowText } from './load.mjs';
import { loadDumpWorkflow } from './dump.mjs';
import { executeWorkflow } from './execute.mjs';

const compiled = new Map();

/** Public run always rereads the supplied source/artifact; only successful DSL loading is cached. */
export async function run(file, runtime, state, suppliedOptions) {
  const cwd = process.cwd();
  const options = executionOptions(suppliedOptions);
  if (typeof file !== 'string' || !/(?:\.workflow\.(?:ts|js)|\.compiled\.mjs)$/.test(file)) throw new TypeError('file must end in .workflow.ts, .workflow.js or .compiled.mjs');
  validateExecutionArguments(runtime, state);
  const filename = path.resolve(cwd, file);
  const projectRoot = resolveProjectRoot(filename, options.projectRoot, cwd);
  const dump = options.dump === undefined ? undefined : path.resolve(cwd, options.dump);
  const resolved = { ...options, projectRoot, ...(dump === undefined ? {} : { dump }) };
  const load = code => dump === undefined ? loadWorkflowText(code) : loadDumpWorkflow(code, filename, dump);
  let workflow;
  if (filename.endsWith('.compiled.mjs')) workflow = await load(await readAOT(filename));
  else {
    const snapshot = createSourceSnapshot(await readFile(filename), filename);
    const key = JSON.stringify([snapshot.sourceHash, filename, projectRoot, options.skillsRoot ?? 'skills', options.skillCheck ?? true,
      options.remoteSkillHosts ?? [], options.trace ?? false, dump ?? null]);
    let entry = compiled.get(key);
    if (!entry) {
      const code = await compileSourceText(snapshot, { ...resolved, outDir: path.dirname(filename), mermaid: false });
      workflow = await load(code);
      entry = { code, workflow }; compiled.set(key, entry);
    } else workflow = dump === undefined ? entry.workflow : await load(entry.code);
  }
  return executeWorkflow(workflow, runtime, state, resolved);
}
