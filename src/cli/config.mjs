import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { normalizeOptions } from '../compiler/source.mjs';

/** Load only the invocation directory's selected JavaScript configuration, before applying overrides. */
export async function loadConfiguration(cwd) {
  const filename = path.join(cwd, 'flowkit.config.mjs');
  let info;
  try { info = await lstat(filename); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  if (!info.isFile() && !info.isSymbolicLink()) throw new TypeError('flowkit.config.mjs must be a file');
  const value = (await import(pathToFileURL(filename).href)).default;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Configuration must export a default options object');
  if (Object.hasOwn(value, 'filename')) throw new TypeError('Unknown option: filename');
  return normalizeOptions(value);
}
