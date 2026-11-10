import {parse} from 'acorn';
import {sha256Bytes,assertSha256} from './identity.mjs';

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
function ownJSON(value, depth = 0, seen = new Set()) {
  if (depth > 64) throw new TypeError('Excessive Program metadata depth');
  if (value === null || ['string','number','boolean'].includes(typeof value)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value,-0))) throw new TypeError('Invalid number');
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Invalid Program metadata');
  const plain = Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if (!plain) throw new TypeError('Untrusted Program metadata prototype');
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  const props = Reflect.ownKeys(value);
  for (const key of props) {
    if (typeof key !== 'string') throw new TypeError('Program metadata must have string keys');
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor || !Object.hasOwn(descriptor,'value')) throw new TypeError('Program metadata has accessor');
    if (Array.isArray(value) && key === 'length') continue;
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) throw new TypeError('Invalid Program metadata array key');
    if (!Array.isArray(value) && (key === 'constructor' || key === 'prototype')) throw new TypeError('Unsafe metadata key');
    const own = ownJSON(descriptor.value, depth+1,seen);
    Object.defineProperty(result,key,{value:own,enumerable:true,writable:false,configurable:false});
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError('Sparse Program metadata array');
  seen.delete(value);
  return Object.freeze(result);
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
  const module = await import('data:text/javascript;base64,' + immutable.toString('base64'));
  if (typeof module.advance !== 'function' || module.advance.constructor.name === 'AsyncFunction'
    || Function.prototype.toString.call(module.advance) !== originalBody) {
    throw new TypeError('Loaded advance function differs from verified bytes');
  }
  if (Object.keys(module).sort().join(',') !== 'advance,interactiveProgram,programTable') {
    throw new TypeError('Unexpected Interactive Program exports');
  }
  const manifest = ownJSON(module.interactiveProgram);
  const table = ownJSON(module.programTable);
  if (manifest.artifactFormat !== 'FlowkitInteractiveProgramV1'
    || manifest.identity.programAbiVersion !== 1
    || manifest.identity.semanticsVersion !== 'interactive-state-machine-v1'
    || manifest.identity.implementedStage !== 'P0-A'
    || table.schemaVersion !== 1 || !Array.isArray(table.blocks)
    || !table.blocks.length || !table.nodes || !Array.isArray(table.requiredBindings)) {
    throw new TypeError('Invalid Interactive Program ABI V1');
  }
  return Object.freeze({
    artifactHash:expectedArtifactHash,
    interactiveProgram:manifest,programTable:table,
    advance:module.advance,
  });
}
