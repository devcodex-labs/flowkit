import {readFile} from 'node:fs/promises';
import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {analyzeSource} from '../compiler/analyze.mjs';
import {lowerInteractive} from '../compiler/interactive/lower.mjs';
import {emitInteractive} from '../compiler/interactive/emit.mjs';

/** Internal M2 compile API; the exported SDK subpath is introduced in M4. */
export async function compileInteractive(file, options) {
  if (typeof file !== 'string' || !/\.workflow\.(js|ts)$/.test(file)) {
    throw new TypeError('Expected .workflow.js or .workflow.ts file');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Compile options object required');
  if (!['memory','file'].includes(options.output)) throw new TypeError('Invalid compile output');
  if (options.featureStage !== 'P0-A') throw new TypeError('Only P0-A is implemented');
  if (options.targetVersion !== undefined && options.targetVersion !== 'interactive-state-machine-v1') {
    throw new TypeError('Unsupported semantics version');
  }
  const cwd = process.cwd();
  const filename = path.resolve(cwd,file);
  const outDir = options.outDir === undefined ? path.dirname(filename) : path.resolve(cwd,options.outDir);
  const snapshot = await readFile(filename); // original source bytes, never imported
  const analysis = await analyzeSource(snapshot,{
    filename, projectRoot:path.dirname(filename),
  });
  const lowered = lowerInteractive(analysis,{featureStage:options.featureStage});
  if (!lowered.ir) return {code:'',diagnostics:[...lowered.diagnostics]};
  const emitted = emitInteractive(lowered.ir);
  if (emitted.diagnostics.some(d => d.severity === 'error')) {
    return {code:'',diagnostics:[...lowered.diagnostics,...emitted.diagnostics]};
  }
  const result = {code:emitted.code,diagnostics:[...lowered.diagnostics],programIdentity:emitted.programIdentity};
  if (options.output === 'file') {
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
