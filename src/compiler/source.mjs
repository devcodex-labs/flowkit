import path from 'node:path';
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ERROR_CATALOG, OPTION_KEYS } from '../shared/contracts.mjs';

/** Capture original bytes before stripping types or normalizing text. */
export function createSourceSnapshot(source, filename) {
  if (typeof filename !== 'string' || !/\.workflow\.(?:ts|js)$/.test(filename)) {
    throw new TypeError('filename must end in .workflow.ts or .workflow.js');
  }
  if (typeof source !== 'string' && !(source instanceof Uint8Array)) {
    throw new TypeError('source must be a string or Uint8Array');
  }
  const rawBytes = Buffer.from(source);
  const sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBytes);
  return Object.freeze({ absFilename: path.resolve(filename), rawBytes, sourceText,
    sourceHash: createHash('sha256').update(rawBytes).digest('hex') });
}

/** A package.json must be a file; its contents are never evaluated or parsed. */
function nearestProjectRoot(filename) {
  let directory = path.dirname(filename);
  for (;;) {
    try { if (statSync(path.join(directory, 'package.json')).isFile()) return directory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

/** Validate the existing option contract even when this compiler stage ignores a key. */
export function normalizeOptions(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const strings = new Set(['filename', 'projectRoot', 'outDir', 'skillsRoot', 'runId', 'dump']);
  const booleans = new Set(['skillCheck', 'trace', 'mermaid']);
  const normalized = {};
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'filename' && !OPTION_KEYS.includes(key)) throw new TypeError(`Unknown option: ${String(key)}`);
    const value = options[key];
    if (value === undefined) continue;
    const valid = strings.has(key) ? typeof value === 'string'
      : booleans.has(key) ? typeof value === 'boolean'
      : key === 'remoteSkillHosts' ? Array.isArray(value) && [...value].every(host => typeof host === 'string')
      : key === 'fetch' ? typeof value === 'function'
      : key === 'signal' ? value instanceof AbortSignal : false;
    if (!valid) throw new TypeError(`Invalid option type: ${String(key)}`);
    normalized[key] = key === 'remoteSkillHosts' ? Object.freeze([...value]) : value;
  }
  return Object.freeze(normalized);
}

export function createCompileContext(snapshot, suppliedOptions = {}) {
  const options = normalizeOptions(suppliedOptions);
  const projectRoot = options.projectRoot === undefined ? nearestProjectRoot(snapshot.absFilename) : path.resolve(options.projectRoot);
  return Object.freeze({ source: snapshot, projectRoot, skillsRoot: options.skillsRoot ?? 'skills',
    skillCheck: options.skillCheck ?? true, remoteSkillHosts: Object.freeze([...(options.remoteSkillHosts ?? [])]),
    trace: options.trace ?? false, options: Object.freeze({ ...options }) });
}

export function pointerChild(parent, key) {
  return `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

export function nodeLocation(node) {
  const start = node?.loc?.start ?? node?.loc ?? { line: 1, column: 0 };
  return { line: start.line, column: start.column + 1 };
}

/** Centralize severity and one-based positions; callers cannot invent new FK codes. */
export function diagnostic(snapshot, code, message, location = { line: 1, column: 1 }, nodeId) {
  const entry = ERROR_CATALOG[code];
  if (!entry) throw new Error(`Unknown internal diagnostic code: ${code}`);
  return { code, message, ...(typeof nodeId === 'string' ? { nodeId } : {}), file: snapshot.absFilename,
    line: location.line, column: location.column, severity: entry.severity };
}

export function sortDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}
