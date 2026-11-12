import {readFile} from 'node:fs/promises';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {analyzeSource} from '../compiler/analyze.mjs';
import {normalizeOptions,resolveProjectRoot} from '../compiler/source.mjs';
import {lowerInteractive} from '../compiler/interactive/lower.mjs';
import {emitInteractive} from '../compiler/interactive/emit.mjs';

/** Internal M2 compile API; the exported SDK subpath is introduced in M4. */
export async function compileInteractive(file, options) {
  if (typeof file !== 'string' || !/\.workflow\.(js|ts)$/.test(file)) {
    throw new TypeError('Expected .workflow.js or .workflow.ts file');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Compile options object required');
  // Match the Standard static analyzer's project and Skill discovery rules.
  // Do NOT silently accept unrelated Standard runtime/emit options.
  const known = new Set(['output','outDir','featureStage','targetVersion',
    'projectRoot','skillsRoot','skillCheck','remoteSkillHosts']);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !known.has(key)) throw new TypeError('Unknown Interactive compile option');
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(options,key),'value')) throw new TypeError('Compile option accessors forbidden');
  }
  const snapshotOptions = Object.fromEntries(Object.keys(options).map(key=>[key,options[key]]));
  const analyzerOptions=normalizeOptions(Object.fromEntries(
    ['projectRoot','skillsRoot','skillCheck','remoteSkillHosts']
      .filter(key=>Object.hasOwn(snapshotOptions,key))
      .map(key=>[key,snapshotOptions[key]])
  ));
  if (!['memory','file'].includes(snapshotOptions.output)) throw new TypeError('Invalid compile output');
  if (snapshotOptions.featureStage !== 'P0-A') throw new TypeError('Only P0-A is implemented');
  if (snapshotOptions.targetVersion !== undefined && snapshotOptions.targetVersion !== 'interactive-state-machine-v1') {
    throw new TypeError('Unsupported semantics version');
  }
  if (snapshotOptions.outDir !== undefined && typeof snapshotOptions.outDir !== 'string') throw new TypeError('outDir must be a string');
  const cwd = process.cwd();
  const filename = path.resolve(cwd,file);
  const outDir = snapshotOptions.outDir === undefined ? path.dirname(filename) : path.resolve(cwd,snapshotOptions.outDir);
  const projectRoot=resolveProjectRoot(filename,analyzerOptions.projectRoot,cwd);
  const snapshot = await readFile(filename); // original source bytes, never imported
  const analysis = await analyzeSource(snapshot,{
    ...analyzerOptions,filename,projectRoot,
  });
  const lowered = lowerInteractive(analysis,{featureStage:snapshotOptions.featureStage});
  if (!lowered.ir) return {code:'',diagnostics:[...lowered.diagnostics]};
  const emitted = emitInteractive(lowered.ir);
  if (emitted.diagnostics.some(d => d.severity === 'error')) {
    return {code:'',diagnostics:[...lowered.diagnostics,...emitted.diagnostics]};
  }
  const result = {code:emitted.code,diagnostics:[...lowered.diagnostics],programIdentity:emitted.programIdentity};
  if (snapshotOptions.output === 'file') {
    const stem = path.basename(filename).replace(/\.workflow\.(js|ts)$/,'');
    const artifactPath = path.join(outDir,stem + '.interactive.mjs');
    await mkdir(outDir,{recursive:true});
    const temporary = path.join(outDir,'.' + stem + '.' + randomUUID() + '.tmp');
    const handle = await open(temporary,'wx');
    try {
      await handle.writeFile(emitted.code,'utf8'); await handle.sync(); await handle.close();
      await rename(temporary,artifactPath);
    } catch(e) {
      await handle.close().catch(()=>{});
      await unlink(temporary).catch(()=>{});
      throw e;
    }
    result.artifactPath = artifactPath;
  }
  return result;
}
