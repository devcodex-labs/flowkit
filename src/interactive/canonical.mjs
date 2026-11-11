import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';

/** RFC 8785-style JSON: UTF-16 key ordering and ECMAScript number/string encoding.
 * Reject rather than coerce non-JSON inputs; never call user toJSON/getters.
 */
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
// The reference Store admits nonterminal Checkpoints only below this budget:
// a failed Agent receipt must still leave enough bytes for a durable error exit.
export const CHECKPOINT_ERROR_RESERVE_BYTES = 256 * 1024;
export const MAX_ACTIVE_CHECKPOINT_BYTES = MAX_CHECKPOINT_BYTES - CHECKPOINT_ERROR_RESERVE_BYTES;
// Business files are Host-owned. Large inline model JSON must use a Host-managed
// reference or be deterministically rejected without stranding a Pending.
export const MAX_INLINE_AGENT_RESULT_BYTES = 128 * 1024;

function validUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('Lone UTF-16 high surrogate is not canonical JSON');
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('Lone UTF-16 low surrogate is not canonical JSON');
    }
  }
}

/** Return freshly allocated canonical bytes; no caller-owned object is retained. */
export function canonicalBytes(input, maximumBytes = MAX_CHECKPOINT_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('Invalid canonical JSON size limit');
  }
  const seen = new Set();
  function serialize(value, depth) {
    if (depth > 64) throw new TypeError('Maximum canonical JSON depth exceeded');
    if (value === null || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'string') {
      validUnicode(value);
      return JSON.stringify(value);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError('Non-canonical JSON number');
      }
      return JSON.stringify(value);
    }
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) {
      throw new TypeError('Expected plain JSON value, not executable or proxy input');
    }
    if (seen.has(value)) throw new TypeError('Cyclic JSON value');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError('Expected plain JSON object');
    }
    seen.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string')) throw new TypeError('Symbol JSON key');
      if (array) {
        if (!Number.isSafeInteger(value.length)) throw new TypeError('Invalid array length');
        const indices = keys.filter(key => key !== 'length');
        if (indices.length !== value.length
          || indices.some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
          throw new TypeError('Sparse or extended JSON array');
        }
        const parts = [];
        for (let i = 0; i < value.length; i += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
            throw new TypeError('Accessor or hidden JSON array value');
          }
          parts.push(serialize(descriptor.value, depth + 1));
        }
        return '[' + parts.join(',') + ']';
      }
      const ordered = [...keys].sort();
      const parts = [];
      for (const key of ordered) {
        validUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
          throw new TypeError('Accessor or hidden JSON object property');
        }
        parts.push(JSON.stringify(key) + ':' + serialize(descriptor.value, depth + 1));
      }
      return '{' + parts.join(',') + '}';
    } finally {
      seen.delete(value);
    }
  }
  const encoded = Buffer.from(serialize(input, 0), 'utf8');
  if (encoded.byteLength > maximumBytes) throw new RangeError('Canonical JSON exceeds maximum bytes');
  return encoded;
}

export function sha256Bytes(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export function assertSHA256(value) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Expected lowercase sha256: identity');
  }
}

export function safeJSONSnapshot(input, limit = MAX_CHECKPOINT_BYTES) {
  return JSON.parse(canonicalBytes(input, limit).toString('utf8'));
}

export function decodeCanonical(text, expectedHash, limit = MAX_CHECKPOINT_BYTES) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > limit) {
    throw new Error('FK_I_STORE_CORRUPT: unexpected JSON bytes');
  }
  const buffer = Buffer.from(text, 'utf8');
  if (expectedHash !== sha256Bytes(buffer)) {
    throw new Error('FK_I_STORE_CORRUPT: data hash mismatch');
  }
  const parsed = JSON.parse(text);
  if (!canonicalBytes(parsed, limit).equals(buffer)) {
    throw new Error('FK_I_STORE_CORRUPT: noncanonical JSON bytes');
  }
  return parsed;
}
