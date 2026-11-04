import { randomUUID } from 'node:crypto';
import { normalizeOptions } from '../compiler/source.mjs';
import { createSkillLoader } from './skills.mjs';

export function executionOptions(supplied) {
  const options = normalizeOptions(supplied);
  if (supplied != null && Object.hasOwn(supplied, 'filename')) throw new TypeError('Unknown option: filename');
  return options;
}

/** Business methods are required only when called; the control predicate is always required. */
export function validateExecutionArguments(runtime, state) {
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) throw new TypeError('runtime must be an object');
  if (typeof runtime.isControlSignal !== 'function') throw new TypeError('runtime.isControlSignal must be a function');
  if (state !== undefined && (state === null || typeof state !== 'object' || Array.isArray(state))) throw new TypeError('state must be an object');
}

/** Copy own enumerable string keys as data, retaining shallow aliases without invoking prototype setters. */
export function cloneOwnData(source) {
  const target = {};
  for (const key of Object.keys(source)) Object.defineProperty(target, key,
    { value: source[key], enumerable: true, writable: true, configurable: true });
  return target;
}

export function createRunContext(runtime, state, options) {
  const ctx = { runtime, state: cloneOwnData(state === undefined ? {} : state), signal: options.signal,
    runId: options.runId === undefined ? randomUUID() : options.runId };
  Object.defineProperty(ctx, 'skillLoader', { value: createSkillLoader(options) });
  return ctx;
}
