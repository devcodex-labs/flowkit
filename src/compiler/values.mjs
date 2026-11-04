import { pointerChild } from './source.mjs';

export const quote = value => JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
export const commentText = value => String(value).replaceAll('\r', '\\r').replaceAll('\n', '\\n')
  .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/** Print literal data as JS while retaining source key order and own __proto__ keys. */
export function printValue(value, pointer = '', propertyOrder = new Map()) {
  if (value === null || typeof value !== 'object') return Object.is(value, -0) ? '-0' : quote(value);
  if (Array.isArray(value)) return `[${value.map((item, index) => printValue(item, pointerChild(pointer, index), propertyOrder)).join(', ')}]`;
  const keys = propertyOrder.get(pointer) ?? Object.keys(value);
  return `{${keys.map(key => `${key === '__proto__' ? `[${quote(key)}]` : quote(key)}: ${printValue(value[key], pointerChild(pointer, key), propertyOrder)}`).join(', ')}}`;
}

/** Numeric declaration slots prevent reserved words and camelCase collisions. */
export function localName(index, id) {
  return `n${index}_${id.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase())}`;
}
