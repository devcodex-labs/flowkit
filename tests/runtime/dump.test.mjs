import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from '@devcodex-labs/flowkit';
import { hashPrefixCollision, loadDumpWorkflow } from '../../src/runtime/dump.mjs';
import { fixture, end, host, settled } from './support.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const act = "action('a',{name:'A',action:'save',next:'done'})";
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function probe(operation, config) {
  const prelude = [
    "import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import path from 'node:path';",
    "import {register,syncBuiltinESMExports} from 'node:module'; import module from 'node:module';",
    "import {MessageChannel,MessagePort,Worker} from 'node:worker_threads'; import {pathToFileURL} from 'node:url';",
    "import * as api from '@devcodex-labs/flowkit';",
    'import {dumpChannel} from ' + JSON.stringify(new URL('../../dist/runtime/dump-channel.mjs', import.meta.url).href) + ';',
    'const operation = ' + operation.toString() + '; await operation(' + JSON.stringify(config) + ');',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', prelude], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return { pid: result.pid, exitCode: result.status, stdout: result.stdout };
}

test('dump writes deterministic whole-text hash names, restores manual edits on cache hits and supports AOT', async t => {
  const f = await fixture(t, [act, end()]); const dump = path.join(f.directory, 'debug'); let calls = 0;
  const runtime = host({ runAction: async () => { calls++; } });
  await api.run(f.file, runtime, {}, { projectRoot: f.directory, dump });
  const names = await readdir(dump); assert.equal(names.length, 1);
  const target = path.join(dump, names[0]), code = await readFile(target, 'utf8');
  assert.equal(names[0], `source.${sha(code).slice(0, 12)}.run.mjs`);
  await writeFile(target, 'export const changed = true;\n');
  await api.run(f.file, runtime, {}, { projectRoot: f.directory, dump });
  assert.equal(await readFile(target, 'utf8'), code); assert.deepEqual(await readdir(dump), names);
  await api.compile(f.file);
  await api.run(path.join(f.directory, 'source.compiled.mjs'), runtime, {}, { projectRoot: f.directory, dump }); assert.equal(calls, 3);
  assert.deepEqual(await readdir(dump), names);
});

test('same cold dump URL supports concurrent first callers and fresh contexts', async t => {
  const f = await fixture(t, [act, end()]); const dump = path.join(f.directory, 'debug'); const contexts = [];
  const runtime = host({ runAction: async (_a, _n, ctx) => { contexts.push(ctx); ctx.state.call = ctx.runId; } });
  const results = await Promise.all(Array.from({ length: 12 }, () => api.run(f.file, runtime, {}, { projectRoot: f.directory, dump })));
  assert.equal(new Set(contexts).size, 12); assert.equal(new Set(results.map(item => item.state.call)).size, 12);
  assert.equal((await readdir(dump)).filter(name => name.endsWith('.run.mjs')).length, 1);
  assert.equal((await readdir(dump)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('dump filesystem failures retain identity, do not call business, clean temporary files and recover', async t => {
  const f = await fixture(t, [act, end()]); const dump = path.join(f.directory, 'debug'); let calls = 0;
  const runtime = host({ runAction: async () => { calls++; } });
  const original = fs.rename, failure = { code: 'EACCES' };
  fs.rename = async (...args) => { if (String(args[1]).endsWith('.run.mjs')) throw failure; return original(...args); }; syncBuiltinESMExports();
  try { assert.equal((await settled(api.run(f.file, runtime, {}, { projectRoot: f.directory, dump }))).error, failure); assert.equal(calls, 0); assert.deepEqual(await readdir(dump), []); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  await api.run(f.file, runtime, {}, { projectRoot: f.directory, dump }); assert.equal(calls, 1);
  const blocked = path.join(f.directory, 'blocked'); await writeFile(blocked, 'file');
  await assert.rejects(api.run(f.file, runtime, {}, { projectRoot: f.directory, dump: blocked })); assert.equal(calls, 1);
});

test('prefix-collision decision distinguishes exact hashes, ordinary edits and a true 12-hex collision', () => {
  const digest = 'a'.repeat(64);
  assert.equal(hashPrefixCollision(digest, digest), false);
  assert.equal(hashPrefixCollision('b'.repeat(64), digest), false);
  assert.equal(hashPrefixCollision('a'.repeat(12) + 'b'.repeat(52), digest), true);
});

test('an injected full-hash prefix collision refuses replacement and preserves the existing file', async t => {
  const f = await fixture(t, [act, end()]); const compiled = await api.compile(f.file);
  const dump = path.join(f.directory, 'collision'); await mkdir(dump);
  const previous = Buffer.from('another canonical artifact'), digest = sha(previous);
  const injected = digest.slice(0, 12) + (digest.slice(12) === '0'.repeat(52) ? '1'.repeat(52) : '0'.repeat(52));
  const target = path.join(dump, `source.${injected.slice(0, 12)}.run.mjs`); await writeFile(target, previous);
  const original = crypto.createHash;
  crypto.createHash = (...args) => {
    const actual = original(...args); let value;
    return { update(bytes) { value = Buffer.from(bytes); actual.update(bytes); return this; }, digest(format) { return value.equals(Buffer.from(compiled.code)) && format === 'hex' ? injected : actual.digest(format); } };
  }; syncBuiltinESMExports();
  try { await assert.rejects(loadDumpWorkflow(compiled.code, f.file, dump), error => error.code === 'EEXIST'); assert.deepEqual(await readFile(target), previous); }
  finally { crypto.createHash = original; syncBuiltinESMExports(); }
});

test('default run registers no hook; dump registers once and the process exits naturally after repeated loads', async t => {
  const f = await fixture(t, [act, end()]);
  const result = probe(async ({ file, directory }) => {
    let registrations = 0, calls = 0; const original = module.register;
    module.register = (...args) => { registrations++; return original(...args); }; syncBuiltinESMExports();
    const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
    await api.run(file, runtime, {}, { projectRoot: directory }); assert.equal(registrations, 0);
    for (let i = 0; i < 3; i++) await api.run(file, runtime, {}, { projectRoot: directory, dump: path.join(directory, 'debug') });
    assert.equal(registrations, 1); assert.equal(calls, 4); console.log('idle-exit');
  }, { file: f.file, directory: f.directory });
  assert.match(result.stdout, /idle-exit/);
});

test('a disk replacement during the older host load chain is rejected before business and retry restores the file', async t => {
  const f = await fixture(t, [act, end()]);
  probe(async ({ file, directory }) => {
    const loader = 'let first=true;export const load=' + (async function (url, context, nextLoad) {
      if (url.startsWith('file:') && new URL(url).searchParams.has('flowkit-verified') && first) {
        first = false; const fs = await import('node:fs/promises');
        const target = new URL(url); target.search = ''; await fs.writeFile(target, 'export const changed=true;\n');
      }
      return nextLoad(url, context);
    }).toString() + ';';
    register('data:text/javascript;base64,' + Buffer.from(loader).toString('base64'));
    let calls = 0; const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
    const options = { projectRoot: directory, dump: path.join(directory, 'debug') };
    await assert.rejects(api.run(file, runtime, {}, options), /differs from pinned text/); assert.equal(calls, 0);
    await api.run(file, runtime, {}, options); assert.equal(calls, 1);
    const names = await fs.readdir(options.dump); assert.equal(names.length, 1);
    assert.ok((await fs.readFile(path.join(options.dump, names[0]), 'utf8')).startsWith('// @generated'));
  }, { file: f.file, directory: f.directory });
});

test('older and later host function transforms are rejected, while unrelated files and equal query names pass through', async t => {
  const f = await fixture(t, [act, end()]);
  probe(async ({ file, directory }) => {
    const body = 'export const load=' + (async function (url, context, nextLoad) {
      const value = await nextLoad(url, context);
      if (url.startsWith('file:') && new URL(url).pathname.includes('/' + target + '/') && new URL(url).searchParams.has('flowkit-verified')) return { ...value, source: Buffer.from(value.source).toString().replaceAll('succeeded', 'failed') };
      return value;
    }).toString() + ';';
    const specifier = 'data:text/javascript;base64,' + Buffer.from('const target="before";' + body).toString('base64');
    register(specifier); let calls = 0;
    const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
    await assert.rejects(api.run(file, runtime, {}, { projectRoot: directory, dump: path.join(directory, 'before') }), /differs from pinned text/);
    register('data:text/javascript;base64,' + Buffer.from('const target="after";' + body).toString('base64'));
    await assert.rejects(api.run(file, runtime, {}, { projectRoot: directory, dump: path.join(directory, 'after') }), /differs from the compiled text/);
    assert.equal(calls, 0);
    const ordinary = path.join(directory, 'ordinary.mjs'); await fs.writeFile(ordinary, 'export const value=42;\n');
    const url = pathToFileURL(ordinary); url.searchParams.set('flowkit-verified', 'unregistered');
    assert.equal((await import(url.href)).value, 42);
  }, { file: f.file, directory: f.directory });
});

test('a transient dump load failure retries with a fresh attempt URL on both supported Node versions', async t => {
  const f = await fixture(t, [act, end()]);
  probe(async ({ file, directory }) => {
    const loader = 'let first=true;export const load=' + (async function (url, context, nextLoad) {
      if (url.startsWith('file:') && new URL(url).searchParams.has('flowkit-verified') && first) { first = false; throw new Error('transient-host-load'); }
      return nextLoad(url, context);
    }).toString() + ';';
    register('data:text/javascript;base64,' + Buffer.from(loader).toString('base64'));
    let calls = 0; const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
    const options = { projectRoot: directory, dump: path.join(directory, 'debug') };
    await assert.rejects(api.run(file, runtime, {}, options), /transient-host-load/);
    await api.run(file, runtime, {}, options); await api.run(file, runtime, {}, options);
    assert.equal(calls, 2); assert.equal((await fs.readdir(options.dump)).length, 1);
  }, { file: f.file, directory: f.directory });
});

test('pin tokens survive an in-flight import, registered unpinned URLs refuse loading, and non-target files are untouched', async t => {
  const f = await fixture(t, [act, end()]); await api.compile(f.file);
  probe(async ({ directory, hook }) => {
    const { port1: host, port2: hostHook } = new MessageChannel();
    const { port1: protocol, port2: protocolHook } = new MessageChannel();
    const loader = 'let port,release;export function initialize({channel}){port=channel;port.on("message",()=>release?.());port.unref();}export const load=' + (async function (url, context, nextLoad) {
      if (url.startsWith('file:') && new URL(url).pathname.endsWith('/pinned.run.mjs')) {
        port.ref(); const gate = new Promise(resolve => { release = resolve; }); port.postMessage('started');
        try { await gate; return await nextLoad(url, context); } finally { port.unref(); }
      }
      return nextLoad(url, context);
    }).toString() + ';';
    register('data:text/javascript;base64,' + Buffer.from(loader).toString('base64'), { data: { channel: hostHook }, transferList: [hostHook] });
    register(hook, { data: { channel: protocolHook }, transferList: [protocolHook] });
    const code = await fs.readFile(path.join(directory, 'source.compiled.mjs'), 'utf8');
    const file = path.join(directory, 'pinned.run.mjs'); await fs.writeFile(file, code);
    const url = pathToFileURL(file); url.searchParams.set('flowkit-verified', 'formal-token-test');
    // An independent thread releases the host gate: Node24 may block its main loader caller.
    const actor = function () {
      const { parentPort, workerData } = require('node:worker_threads');
      const { protocol, host, url, code } = workerData;
      let sequence = 0, releasedWhileLoading = false;
      const pending = new Map();
      const send = message => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); protocol.postMessage({ ...message, id }); });
      protocol.on('message', message => { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request.reject(new Error(message.error)); else request.resolve(); });
      const fail = error => { protocol.close(); host.close(); parentPort.postMessage({ error: error.message }); parentPort.close(); };
      host.on('message', async () => {
        try { await send({ op: 'unpin', url, token: 'one' }); releasedWhileLoading = true; host.postMessage('release'); }
        catch (error) { fail(error); }
      });
      parentPort.on('message', async () => {
        try {
          await send({ op: 'unpin', url, token: 'two' });
          const unleased = new URL(url); unleased.searchParams.set('attempt', 'unleased');
          await send({ op: 'pin', url: unleased.href, source: code, token: 'gone' });
          await send({ op: 'unpin', url: unleased.href, token: 'gone' });
          protocol.close(); host.close(); parentPort.postMessage({ done: true, releasedWhileLoading }); parentPort.close();
        } catch (error) { fail(error); }
      });
      (async () => { await send({ op: 'pin', url, source: code, token: 'one' }); await send({ op: 'pin', url, source: code, token: 'two' }); parentPort.postMessage({ ready: true }); })().catch(fail);
    };
    const worker = new Worker('(' + actor.toString() + ')()', { eval: true, execArgv: [], workerData: { protocol, host, url: url.href, code }, transferList: [protocol, host] });
    let readyResolve, readyReject, doneResolve, doneReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    worker.on('message', message => { if (message.ready) readyResolve(); else if (message.done) doneResolve(message); else { const error = new Error(message.error); readyReject(error); doneReject(error); } });
    worker.on('error', error => { readyReject(error); doneReject(error); });
    const exited = new Promise(resolve => worker.on('exit', resolve));
    await ready;
    const loaded = await import(url.href); let calls = 0;
    await loaded.workflow({ runtime: { runAction: async () => { calls++; } }, state: {} }); assert.equal(calls, 1);
    worker.postMessage('finish'); assert.equal((await done).releasedWhileLoading, true); assert.equal(await exited, 0);
    url.searchParams.set('attempt', 'unleased'); await assert.rejects(import(url.href), /no active pin/);
    const ordinary = path.join(directory, 'ordinary.mjs'); await fs.writeFile(ordinary, 'export const value=7;');
    const other = pathToFileURL(ordinary); other.searchParams.set('flowkit-verified', 'formal-token-test');
    assert.equal((await import(other.href)).value, 7);
  }, { directory: f.directory, hook: new URL('../../dist/runtime/dump-hook.mjs', import.meta.url).href });
});

test('channel close and messageerror reject pending loads without retaining process handles', async t => {
  for (const event of ['close', 'messageerror']) {
    const f = await fixture(t, [act, end()]);
    probe(async ({ file, directory, event }) => {
      const original = MessagePort.prototype.postMessage; const failure = new Error('decode-failed');
      MessagePort.prototype.postMessage = function (message, ...args) {
        if (message?.op === 'pin') { if (event === 'close') this.close(); else this.emit('messageerror', failure); return; }
        return original.call(this, message, ...args);
      };
      try {
        let calls = 0; const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
        await assert.rejects(api.run(file, runtime, {}, { projectRoot: directory, dump: path.join(directory, 'debug') }), error => event === 'close' ? /channel closed/.test(error.message) : error === failure);
        assert.equal(calls, 0);
      } finally { MessagePort.prototype.postMessage = original; }
    }, { file: f.file, directory: f.directory, event });
  }
});

test('a synchronous unpin send failure rejects every pending operation and permits natural process exit', async t => {
  const f = await fixture(t, [act, end()]);
  probe(async ({ file, directory }) => {
    const original = MessagePort.prototype.postMessage, failure = new Error('unpin-send-failed');
    MessagePort.prototype.postMessage = function (message, ...args) {
      if (message?.op === 'unpin') throw failure;
      return original.call(this, message, ...args);
    };
    try {
      let calls = 0; const runtime = { isControlSignal: api.isControlSignal, runAction: async () => { calls++; } };
      const options = { projectRoot: directory, dump: path.join(directory, 'debug') };
      await assert.rejects(api.run(file, runtime, {}, options), error => error === failure);
      await assert.rejects(api.run(file, runtime, {}, options), error => error === failure);
      assert.equal(calls, 0); console.log('unpin-send-failed-exit');
    } finally { MessagePort.prototype.postMessage = original; }
  }, { file: f.file, directory: f.directory });
});

test('worker-side message deserialization errors close the protocol instead of losing a pending request', async () => {
  const { initialize } = await import('../../src/runtime/dump-hook.mjs');
  class Port extends EventEmitter { ref() {} unref() {} close() { this.closed = true; this.emit('close'); } }
  const channel = new Port(); initialize({ channel });
  channel.emit('messageerror', new Error('deserialize'));
  assert.equal(channel.closed, true);
});
