import { register } from 'node:module';
import { MessageChannel } from 'node:worker_threads';

let singleton;

/** Lazy process-level registration; idle ports never keep the host process alive. */
export function dumpChannel() {
  if (singleton) return singleton;
  const { port1, port2 } = new MessageChannel();
  const pending = new Map(), active = new Set();
  let sequence = 0, dead;
  const updateRef = () => pending.size || active.size ? port1.ref() : port1.unref();
  const fail = error => {
    dead ??= error;
    for (const request of pending.values()) request.reject(dead);
    pending.clear(); active.clear(); updateRef();
  };
  port1.on('message', message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else {
      if (request.op === 'pin') active.add(request.token);
      else active.delete(request.token);
      request.resolve();
    }
    updateRef();
  });
  port1.on('close', () => fail(new Error('Dump loader channel closed')));
  port1.on('messageerror', error => { fail(error); port1.close(); });
  port1.unref();
  singleton = { send: message => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject, op: message.op, token: message.token }); updateRef();
    try { port1.postMessage({ ...message, id }); }
    catch (error) { fail(error); port1.close(); }
  }) };
  try { register(new URL('./dump-hook.mjs', import.meta.url), { parentURL: import.meta.url, data: { channel: port2 }, transferList: [port2] }); }
  catch (error) { fail(error); port1.close(); port2.close(); }
  return singleton;
}
