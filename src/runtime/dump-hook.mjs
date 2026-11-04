const pinned = new Map();
const registered = new Set();
let port, loading = 0;
const updateRef = () => loading ? port.ref() : port.unref();

export function initialize({ channel }) {
  port = channel;
  port.on('message', message => {
    let error;
    try {
      if (message.op === 'pin') {
        const previous = pinned.get(message.url);
        if (previous && previous.source !== message.source) throw new Error('Pinned text mismatch');
        const entry = previous ?? { source: message.source, tokens: new Set() };
        entry.tokens.add(message.token);
        pinned.set(message.url, entry); registered.add(message.url);
      } else if (message.op === 'unpin') {
        const entry = pinned.get(message.url);
        entry?.tokens.delete(message.token);
        if (entry && entry.tokens.size === 0) pinned.delete(message.url);
      } else throw new Error('Unknown dump loader request');
    } catch (cause) { error = cause.message; }
    port.postMessage({ id: message.id, error });
  });
  port.on('close', () => { pinned.clear(); });
  port.on('messageerror', () => { port.close(); });
  updateRef();
}

/** Only previously registered exact URLs are intercepted; all other modules retain their chain. */
export async function load(url, context, nextLoad) {
  if (!registered.has(url)) return nextLoad(url, context);
  loading++; updateRef();
  try {
    const entry = pinned.get(url);
    if (!entry) throw new Error('Verified dump URL has no active pin');
    const underlying = await nextLoad(url, context);
    const bytes = underlying.source == null ? null : Buffer.from(underlying.source);
    if (underlying.format !== 'module' || !bytes?.equals(Buffer.from(entry.source))) throw new Error('Loader source differs from pinned text');
    return { format: 'module', source: entry.source, shortCircuit: true };
  } finally { loading--; updateRef(); }
}
