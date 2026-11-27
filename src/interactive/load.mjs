import {parse} from 'acorn';
import {loadBoundedModule} from '../runtime/compilation-cache.mjs';
import {sha256Bytes,assertSha256} from './identity.mjs';
import {copyProgramData,validateInteractiveIR,stepFrameRule} from '../compiler/interactive/validate-ir.mjs';
import {isInteractiveStage,hasStepFrame} from './protocol.mjs';

/** A verified program is trusted compiler output, NOT an untrusted JavaScript sandbox. */
function ensureNoImports(ast) {
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (['ImportDeclaration','ImportExpression','ExportAllDeclaration'].includes(node.type)) {
      throw new TypeError('Interactive Program imports are forbidden');
    }
    if (node.type === 'ExportNamedDeclaration' && node.source) {
      throw new TypeError('Re-exports are forbidden');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item?.type) pending.push(item);
      } else if (value?.type) {
        pending.push(value);
      }
    }
  }
}

/** Loads exactly the verified byte snapshot, regardless of file-name swaps. */
export async function loadInteractiveProgram(bytes, expectedArtifactHash) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Program bytes must be Uint8Array');
  assertSha256(expectedArtifactHash);
  const immutable = Buffer.from(bytes);
  if (immutable.byteLength > 4 * 1024 * 1024) throw new TypeError('Oversize Interactive Program');
  if (sha256Bytes(immutable) !== expectedArtifactHash) throw new Error('FK_I_PROGRAM_MISMATCH: artifact hash differs');
  const code = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(immutable);
  const ast = parse(code,{ecmaVersion:'latest',sourceType:'module'});
  ensureNoImports(ast);
  const advances = ast.body.filter(n => n.type === 'ExportNamedDeclaration' && n.declaration?.type === 'FunctionDeclaration' && n.declaration.id.name === 'advance');
  if (advances.length !== 1) throw new TypeError('Exactly one exported advance function required');
  const originalBody = code.slice(advances[0].declaration.start,advances[0].declaration.end);
  const module = await loadBoundedModule(code);
  if (typeof module.advance !== 'function' || module.advance.constructor.name === 'AsyncFunction'
    || Function.prototype.toString.call(module.advance) !== originalBody) {
    throw new TypeError('Loaded advance function differs from verified bytes');
  }
  if (Object.keys(module).sort().join(',') !== 'advance,interactiveProgram,programTable') {
    throw new TypeError('Unexpected Interactive Program exports');
  }
  const manifest = copyProgramData(module.interactiveProgram);
  const table = copyProgramData(module.programTable);
  if (manifest.artifactFormat !== 'FlowkitInteractiveProgramV1'
    || manifest.identity.programAbiVersion !== 1
    || manifest.identity.semanticsVersion !== 'interactive-state-machine-v1'
    || !isInteractiveStage(manifest.identity.implementedStage)
    || table.schemaVersion !== 1 || !Array.isArray(table.blocks)
    || !table.blocks.length || !table.nodes || !Array.isArray(table.requiredBindings)) {
    throw new TypeError('Invalid Interactive Program ABI V1');
  }
  // Validate the ProgramTable as a self-contained compiler contract.
  // No source files or runtime lowering are consulted.
  if (!/^sha256:[0-9a-f]{64}$/.test(manifest.identity.sourceHash)) throw new TypeError('Invalid Program source identity');
  const staticIR = {
    schemaVersion:1,featureStage:manifest.identity.implementedStage,sourceHash:manifest.identity.sourceHash.slice(7),
    graphStructureHash:manifest.identity.graphStructureHash,
    entryBlockId:table.entryBlockId,blocks:table.blocks,nodes:table.nodes,
    ...(Object.hasOwn(table,'contract')?{contract:table.contract}:{}),
    frameRules:Object.keys(table.nodes).filter(id=>hasStepFrame(table.nodes[id].kind)).map(id=>stepFrameRule(id,table.nodes[id].kind)),
  };
  const validated = validateInteractiveIR(staticIR);
  if (!validated.ok) throw new TypeError('FK_I_INVALID_TRANSITION: invalid ProgramTable');
  return Object.freeze({
    artifactHash:expectedArtifactHash,
    interactiveProgram:manifest,programTable:table,
    advance:module.advance,
  });
}
