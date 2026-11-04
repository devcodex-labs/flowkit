import { createHash } from 'node:crypto';
import { remoteSkillURL, localSkillPath, remoteReference } from '../shared/skill-ref.mjs';

const skillFailures = new WeakSet();
export function skillError(code, message, ...cause) {
  const error = Object.assign(new Error(`${code} ${message}`, cause.length ? { cause: cause[0] } : undefined), { code });
  skillFailures.add(error);
  return error;
}

const maxBytes = 262144;
const cancelSignal = () => Object.assign(new Error('Skill reading cancelled'), { control: true, kind: 'cancel' });
const discard = body => {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Preserve the primary failure. */ }
};

function redirectTarget(location, current) {
  let target;
  try { target = new URL(location, current); }
  catch (cause) { throw skillError('FK_R014', 'Invalid redirect location', cause); }
  if (target.protocol !== 'https:' || target.origin !== current.origin) throw skillError('FK_R012', 'Redirect must remain on the same HTTPS origin');
  const absolute = remoteReference(location) ? location : location.startsWith('//') ? `https:${location}` : null;
  if (absolute ? !remoteSkillURL(absolute) : !localSkillPath(location.replace(/^\//, ''))) throw skillError('FK_R011', 'Invalid redirect Skill reference');
  return target;
}

/** One deadline covers fetch, all redirects and the complete byte stream. */
export async function readRemoteSkill(initialURL, integrity, options) {
  const external = options.signal;
  if (external?.aborted) throw cancelSignal();
  const controller = new AbortController();
  let interrupt;
  const interrupted = new Promise((_resolve, reject) => { interrupt = reject; });
  let stopped = false, reader, body, consumed = false;
  const onAbort = () => { const error = cancelSignal(); interrupt(error); controller.abort(error); };
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new DOMException('Skill read exceeded 10000ms', 'TimeoutError');
    interrupt(error); controller.abort(error);
  }, 10000);
  const wait = promise => Promise.race([promise, interrupted]);
  let url = initialURL;
  try {
    for (let redirects = 0; ; redirects++) {
      const pending = Promise.resolve().then(() => (options.fetch ?? globalThis.fetch)(url.href,
        { signal: controller.signal, credentials: 'omit', redirect: 'manual' }));
      // A custom fetch may ignore AbortSignal and deliver a body after the deadline.
      pending.then(response => { if (stopped) discard(response.body); }, () => {}).catch(() => {});
      const response = await wait(pending);
      body = response.body; consumed = false;
      const status = response.status;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.get('location');
        if (!location || redirects >= 3) throw skillError('FK_R014', 'Redirect limit or missing Location',
          { status, url: url.href, location, redirects: redirects + 1 });
        const next = redirectTarget(location, url);
        if (body) await wait(body.cancel());
        consumed = true; body = undefined; url = next;
        continue;
      }
      if (status < 200 || status >= 300) throw skillError('FK_R014', 'HTTP failure', { status, url: url.href });
      const length = response.headers.get('content-length');
      if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) throw skillError('FK_R014', 'Skill exceeds byte limit',
        { status, url: url.href, maxBytes, contentLength: Number(length) });
      const chunks = []; let received = 0;
      if (body) {
        reader = body.getReader();
        for (;;) {
          const part = await wait(reader.read());
          if (part.done) break;
          if (!(part.value instanceof Uint8Array)) throw new TypeError('Skill body must contain bytes');
          received += part.value.byteLength;
          if (received > maxBytes) throw skillError('FK_R014', 'Skill exceeds byte limit',
            { status, url: url.href, maxBytes, received });
          chunks.push(Buffer.from(part.value));
        }
      }
      consumed = true;
      const bytes = Buffer.concat(chunks, received);
      if (integrity !== undefined) {
        const [algorithm, digest] = integrity.split('-');
        if (!createHash(algorithm).update(bytes).digest().equals(Buffer.from(digest, 'base64'))) throw skillError('FK_R013', 'Skill integrity mismatch');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  } catch (cause) {
    if (external?.aborted) throw cancelSignal();
    if (cause?.control === true || skillFailures.has(cause)) throw cause;
    throw skillError('FK_R014', 'Skill reading failed', cause);
  } finally {
    stopped = true;
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
    if (!consumed) {
      controller.abort();
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Preserve primary failure. */ } }
      else discard(body);
    }
    if (reader) { try { reader.releaseLock(); } catch { /* A host stream may already have detached its lock. */ } }
  }
}
