import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSourceSnapshot, resolveProjectRoot } from '../compiler/source.mjs';
import { executionOptions, validateExecutionArguments } from './context.mjs';
import { compileSourceText } from './source.mjs';
import { readAOT } from './aot.mjs';
import { loadWorkflowText } from './load.mjs';
import { loadDumpWorkflow } from './dump.mjs';
import { executeWorkflow } from './execute.mjs';
import { STANDARD_ARTIFACT_HEADER, artifactDigest, standardIdentity } from '../shared/artifact-identity.mjs';

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
  let code;
  if (filename.endsWith('.compiled.mjs')) {
    code = await readAOT(filename);
    workflow = await load(code);
  }
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
    code = entry.code;
  }
  return executeWorkflow(workflow, runtime, state, resolved, standardIdentity(code));
}

/** Execute only exact approved, current-format Standard artifact bytes. */
export async function runArtifact(file, expectedHash, runtime, state, suppliedOptions) {
  return runVerifiedArtifact(file, expectedHash, runtime, state, suppliedOptions);
}

/** Internal verified entry with an optional Host-bound check before Agent dispatch. */
export async function runVerifiedArtifact(file, expectedHash, runtime, state, suppliedOptions, checkPreparedSkills) {
  const invalid = (message, cause) => Object.assign(new Error(`FK_R001 ${message}`, { cause }), { code: 'FK_R001' });
  if (typeof file !== 'string' || path.basename(file) !== 'workflow.js') throw invalid('Expected workflow.js');
  if (typeof expectedHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(expectedHash)) {
    throw invalid('Expected an approved SHA-256 artifact identity');
  }
  const options = executionOptions(suppliedOptions);
  validateExecutionArguments(runtime, state);
  const cwd = process.cwd();
  const filename = path.resolve(cwd, file);
  const resolved = { ...options, projectRoot: resolveProjectRoot(filename, options.projectRoot, cwd) };
  const dump = options.dump === undefined ? undefined : path.resolve(cwd, options.dump);
  const bytes = await readFile(filename);
  if (artifactDigest(bytes) !== expectedHash) throw invalid('Artifact differs from the approved identity');
  let code;
  try { code = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalid('Artifact is not UTF-8'); }
  const header = code.slice(0, code.indexOf('\n'));
  if (header !== STANDARD_ARTIFACT_HEADER) throw invalid('Unsupported artifact mode, ABI or semantics version');
  const artifact = standardIdentity(code);
  let workflow;
  try { workflow = await (dump === undefined ? loadWorkflowText(code) : loadDumpWorkflow(code, filename, dump)); }
  catch (cause) { throw invalid('Artifact cannot be loaded', cause); }
  return executeWorkflow(workflow, runtime, state, resolved, artifact, checkPreparedSkills);
}
