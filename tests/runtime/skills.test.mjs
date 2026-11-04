import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSkillLoader } from '../../src/runtime/skills.mjs';
import { fixture, end, host, deferred, settled } from './support.mjs';

const ref = 'https://example.test/a.md';
const pin = (text, algorithm = 'sha256') => `${algorithm}-${createHash(algorithm).update(text).digest('base64')}`;
const agent = fields => `node('n',{name:'N',output:{type:'object'},next:'done',${fields}})`;
const remoteLoader = (fetch, options = {}) => createSkillLoader({ remoteSkillHosts: ['example.test'], fetch, ...options });
const fail = async (promise, code) => {
  const result = await settled(promise);
  assert.equal(result.fulfilled, false); assert.equal(result.error.code, code);
  assert.match(result.error.message, new RegExp(`^${code} `));
  return result.error;
};

test('real DSL execution supplies local Skills, keeps host identity, and rereads on the next execution', async t => {
  const f = await fixture(t, [agent("agent:'writer'"), end()]);
  await mkdir(path.join(f.directory, 'skills'));
  await writeFile(path.join(f.directory, 'skills/writer.md'), '中文 instruction');
  const instructions = [];
  class Runtime {
    #ok = 7;
    isControlSignal(error) { return error?.control === true; }
    validateResult() { assert.equal(this.#ok, 7); return []; }
    async runAgent(step) { assert.equal(this.#ok, 7); instructions.push(step.instruction); return { value: this.#ok }; }
  }
  const runtime = Object.freeze(new Runtime());
  assert.equal((await f.run(runtime, {}, { projectRoot: f.directory })).state.value, 7);
  await writeFile(path.join(f.directory, 'skills/writer.md'), 'updated');
  await f.run(runtime, {}, { projectRoot: f.directory });
  assert.deepEqual(instructions, ['中文 instruction', 'updated']);
  assert.equal(runtime.loadSkill, undefined);
});

test('mapped local host roots allow Unicode and spaces in relative and absolute paths', async t => {
  const f = await fixture(t, [agent("agent:'nested/writer'"), end()]);
  const directory = path.join(f.directory, '技能 folder');
  await mkdir(path.join(directory, 'nested'), { recursive: true });
  await writeFile(path.join(directory, 'nested/writer.md'), 'mapped 中文');
  const instructions = [];
  const runtime = host({ runAgent: async step => { instructions.push(step.instruction); return {}; }, validateResult: () => [] });
  for (const skillsRoot of ['技能 folder', directory]) await f.run(runtime, {}, { projectRoot: f.directory, skillsRoot });
  assert.deepEqual(instructions, ['mapped 中文', 'mapped 中文']);
  await fail(createSkillLoader({ projectRoot: f.directory }).loadSkill('技能 folder/nested/writer.md'), 'FK_R011');
});

test('explicit and mapped overrides are independent, retain this, and take precedence over missing defaults', async t => {
  const f = await fixture(t, [agent("skill:'missing.md',agent:'ignored'"), end()]);
  const g = await fixture(t, [agent("agent:'writer'"), end()]);
  const seen = [];
  const runtime = host({ marker: 'host',
    loadSkill: async function (value) { assert.equal(this.marker, 'host'); seen.push(value); return 'custom'; },
    runAgent: async step => { seen.push(step.instruction); return {}; }, validateResult: () => [] });
  await f.run(runtime, {}, { projectRoot: f.directory, skillCheck: false });
  await fail(g.run(runtime, {}, { projectRoot: g.directory, skillCheck: false }), 'FK_R010');
  runtime.loadSkillByAgent = async function (value) { assert.equal(this, runtime); seen.push(value); return 'mapped'; };
  await g.run(runtime, {}, { projectRoot: g.directory, skillCheck: false });
  assert.deepEqual(seen, ['missing.md', 'custom', 'writer', 'mapped']);
});

test('local pending promises deduplicate one normalized reference and aliases remain separate', async t => {
  const f = await fixture(t, [end()]); await mkdir(path.join(f.directory, 'skills'));
  await writeFile(path.join(f.directory, 'skills/a.md'), 'first');
  const loader = createSkillLoader({ projectRoot: f.directory });
  const first = loader.loadSkill('skills/a.md');
  assert.equal(first, loader.loadSkill('skills/a.md'));
  assert.equal(first, loader.loadSkillByAgent('a'));
  assert.equal(await first, 'first');
  await writeFile(path.join(f.directory, 'skills/a.md'), 'second');
  assert.equal(await loader.loadSkill('skills/a.md'), 'first');
  assert.equal(await createSkillLoader({ projectRoot: f.directory }).loadSkillByAgent('a'), 'second');
  await symlink(path.join(f.directory, 'skills'), path.join(f.directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await loader.loadSkill('alias/a.md'), 'second');
});

test('missing and invalid UTF-8 local failures are evicted; other filesystem errors keep identity', async t => {
  const f = await fixture(t, [end()]); const loader = createSkillLoader({ projectRoot: f.directory });
  await fail(loader.loadSkill('a.md'), 'FK_R010');
  await writeFile(path.join(f.directory, 'a.md'), Buffer.from([0xff]));
  const error = await fail(loader.loadSkill('a.md'), 'FK_R014'); assert.ok(error.cause instanceof TypeError);
  await writeFile(path.join(f.directory, 'a.md'), 'fixed'); assert.equal(await loader.loadSkill('a.md'), 'fixed');
  const original = fs.readFile, rejection = { code: 'EACCES' };
  fs.readFile = async () => { throw rejection; }; syncBuiltinESMExports();
  try { assert.equal((await settled(createSkillLoader({ projectRoot: f.directory }).loadSkill('a.md'))).error, rejection); }
  finally { fs.readFile = original; syncBuiltinESMExports(); }
});

test('realpath checks both root and target, rejecting sibling-prefix and symlink escapes', async t => {
  const f = await fixture(t, [end()]);
  const project = path.join(f.directory, 'project'), sibling = path.join(f.directory, 'project-other');
  await mkdir(project); await mkdir(sibling); await writeFile(path.join(sibling, 'a.md'), 'outside');
  await symlink(sibling, path.join(project, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fail(createSkillLoader({ projectRoot: project }).loadSkill('escape/a.md'), 'FK_R011');
  await fail(createSkillLoader({ projectRoot: project, skillsRoot: sibling }).loadSkillByAgent('a'), 'FK_R011');
  await writeFile(path.join(project, 'a.md'), 'inside');
  await symlink(project, path.join(f.directory, 'root-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await createSkillLoader({ projectRoot: path.join(f.directory, 'root-alias') }).loadSkill('a.md'), 'inside');
});

test('raw local paths and integrity misuse fail before I/O, including Windows traversal forms', async () => {
  const loader = createSkillLoader();
  for (const reference of ['../a.md', '/a.md', 'C:/a.md', 'C:\\a.md', 'x/../a.md', 'x\\a.md', 'a%2e.md', '中文.md', 'a.md?', 'a.md#', 'a.txt', '', null]) await fail(loader.loadSkill(reference), 'FK_R011');
  for (const integrity of [undefined, null, '', pin('x')]) await fail(loader.loadSkill('a.md', { integrity }), 'FK_R011');
  for (const value of ['../x', '.', '..', '', Symbol('x'), 1, null]) await fail(loader.loadSkillByAgent(value), 'FK_R011');
});

test('remote policies reject malformed refs, forbidden hosts and integrity before fetch', async () => {
  let calls = 0; const loader = remoteLoader(() => { calls++; throw Error('Unexpected'); });
  for (const reference of ['https://example.test/x/../a.md', 'https://example.test/%2e%2e/a.md', 'https://example.test/a.md?', 'https://example.test/a.md#', 'https://u:p@example.test/a.md', 'https://example.test/x\\a.md']) await fail(loader.loadSkill(reference), 'FK_R011');
  for (const reference of ['http://example.test/a.md', 'https://sub.example.test/a.md', 'https://example.test.evil/a.md', 'https://example.test:444/a.md']) await fail(loader.loadSkill(reference), 'FK_R012');
  for (const integrity of [undefined, '', null, 1, 'sha1-YQ==', pin('x') + '=', pin('x') + ' ' + pin('x')]) await fail(loader.loadSkill(ref, { integrity }), 'FK_R011');
  assert.equal(calls, 0);
});

test('remote bytes support all three exact digests, unpadded equivalents and strict UTF-8', async () => {
  const bytes = Buffer.from('中文\n'); let calls = 0;
  const loader = remoteLoader(async (_url, init) => { calls++; assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal instanceof AbortSignal); return new Response(bytes); });
  for (const algorithm of ['sha256', 'sha384', 'sha512']) for (const integrity of [pin(bytes, algorithm), pin(bytes, algorithm).replace(/=+$/, '')]) assert.equal(await loader.loadSkill(ref, { integrity }), '中文\n');
  await fail(loader.loadSkill(ref, { integrity: pin('wrong') }), 'FK_R013');
  const bad = Buffer.from([0xff]);
  const badLoader = remoteLoader(async () => new Response(bad));
  await fail(badLoader.loadSkill(ref, { integrity: pin('wrong') }), 'FK_R013');
  assert.ok((await fail(badLoader.loadSkill(ref, { integrity: pin(bad) }), 'FK_R014')).cause instanceof TypeError);
  assert.ok(calls >= 4);
  assert.equal(await remoteLoader(async () => new Response(null, { status: 204 })).loadSkill(ref), '');
});

test('normalized URL plus integrity deduplicates pending reads, failures retry and executions do not share cache', async () => {
  const gate = deferred(); let calls = 0;
  const fetch = async () => { calls++; await gate.promise; return new Response('ok'); };
  const loader = remoteLoader(fetch);
  const a = loader.loadSkill('HTTPS://EXAMPLE.TEST:443/a.md');
  assert.equal(a, loader.loadSkill(ref));
  const pinned = loader.loadSkill(ref, { integrity: pin('ok') }); assert.notEqual(a, pinned);
  gate.resolve(); await Promise.all([a, pinned]); assert.equal(calls, 2);
  assert.equal(await remoteLoader(fetch).loadSkill(ref), 'ok'); assert.equal(calls, 3);
  let attempt = 0;
  const retry = remoteLoader(async () => ++attempt === 1 ? new Response('', { status: 500 }) : new Response('fixed'));
  await fail(retry.loadSkill(ref), 'FK_R014'); assert.equal(await retry.loadSkill(ref), 'fixed'); assert.equal(attempt, 2);
});

test('remote skillsRoot maps nested agents without integrity and uses exact normalized hosts and ports', async () => {
  let seen;
  const loader = createSkillLoader({ skillsRoot: 'HTTPS://example.test:444/skills', remoteSkillHosts: ['EXAMPLE.TEST:444'], fetch: async url => { seen = url; return new Response('mapped'); } });
  assert.equal(await loader.loadSkillByAgent('nested/writer'), 'mapped');
  assert.equal(seen, 'https://example.test:444/skills/nested/writer.md');
  assert.equal(await remoteLoader(async () => new Response('ok'), { remoteSkillHosts: ['example.test:443'] }).loadSkill(ref), 'ok');
});

test('redirects consume at most three same-origin edges, cancel bodies, and reject unsafe targets', async () => {
  let calls = 0, cancelled = 0;
  const loader = remoteLoader(async () => {
    calls++;
    return calls <= 3 ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: `/next${calls}.md` } }) : new Response('done');
  });
  assert.equal(await loader.loadSkill(ref), 'done'); assert.equal(calls, 4); assert.equal(cancelled, 3);
  for (const [location, code] of [['https://evil.test/a.md', 'FK_R012'], ['http://example.test/a.md', 'FK_R012'], ['../a.md', 'FK_R011'], ['/x/../a.md', 'FK_R011'], ['/a.md?', 'FK_R011'], ['https://u@example.test/a.md', 'FK_R011']]) {
    await fail(remoteLoader(async () => new Response('body', { status: 302, headers: { location } })).loadSkill(ref), code);
  }
  const excess = await fail(remoteLoader(async () => new Response('', { status: 302, headers: { location: '/next.md' } })).loadSkill(ref), 'FK_R014');
  assert.equal(excess.cause.redirects, 4);
  assert.equal((await fail(remoteLoader(async () => new Response('', { status: 302 })).loadSkill(ref), 'FK_R014')).cause.location, null);
});

test('content length and actual bytes enforce 262144 independently and release/cancel streams', async () => {
  let cancelled = 0, body;
  const make = (chunks, headers = {}) => {
    body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); }, cancel() { cancelled++; } });
    return new Response(body, { headers });
  };
  const header = await fail(remoteLoader(async () => make([], { 'content-length': '262145' })).loadSkill(ref), 'FK_R014');
  assert.equal(header.cause.maxBytes, 262144); assert.equal(header.cause.contentLength, 262145); assert.equal(cancelled, 1); assert.equal(body.locked, false);
  const streamed = await fail(remoteLoader(async () => make([Buffer.alloc(262144), Buffer.alloc(1)], { 'content-length': '1' })).loadSkill(ref), 'FK_R014');
  assert.equal(streamed.cause.received, 262145); assert.equal(cancelled, 2); assert.equal(body.locked, false);
  assert.equal((await remoteLoader(async () => new Response(Buffer.alloc(262144, 65))).loadSkill(ref)).length, 262144);
});

test('HTTP, network, stream and decoder failures retain the documented cause without code spoofing', async () => {
  const http = await fail(remoteLoader(async () => new Response('', { status: 404 })).loadSkill(ref), 'FK_R014');
  assert.deepEqual(http.cause, { status: 404, url: ref });
  for (const cause of [undefined, { code: 'FK_R013' }, new TypeError('network')]) {
    const error = await fail(remoteLoader(async () => { throw cause; }).loadSkill(ref), 'FK_R014');
    assert.equal(Object.hasOwn(error, 'cause'), true); assert.equal(error.cause, cause);
  }
  const cause = Error('stream');
  assert.equal((await fail(remoteLoader(async () => new Response(new ReadableStream({ start(c) { c.error(cause); } }))).loadSkill(ref), 'FK_R014')).cause, cause);
  const control = { control: true, kind: 'host-defined' };
  assert.equal((await settled(remoteLoader(async () => { throw control; }).loadSkill(ref))).error, control);
});

test('external cancellation aborts in-flight fetch, removes listeners, evicts failure, and handles late bodies', async () => {
  const controller = new AbortController(); let adds = 0, removes = 0, internal, cancelled = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { adds++; return add(...args); };
  controller.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const gate = deferred(), started = deferred();
  const loader = remoteLoader((_url, init) => { internal = init.signal; started.resolve(); return gate.promise; }, { signal: controller.signal });
  const reading = settled(loader.loadSkill(ref)); await started.promise; controller.abort('user');
  const result = await reading; assert.equal(result.error.control, true); assert.equal(result.error.kind, 'cancel'); assert.equal(internal.aborted, true);
  assert.equal(adds, 1); assert.equal(removes, 1);
  gate.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
  let calls = 0; const pre = new AbortController(); pre.abort();
  assert.equal((await settled(remoteLoader(async () => { calls++; }, { signal: pre.signal }).loadSkill(ref))).error.kind, 'cancel'); assert.equal(calls, 0);
});

test('one 10-second budget includes redirects and stalled body even when a custom fetch ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); const started = deferred(); let calls = 0, cancelled = 0, body;
  const loader = remoteLoader(async () => {
    calls++;
    if (calls === 1) { t.mock.timers.tick(6000); return new Response('', { status: 302, headers: { location: '/next.md' } }); }
    body = new ReadableStream({ start() { started.resolve(); }, cancel() { cancelled++; } });
    return new Response(body);
  }, { signal: controller.signal });
  const reading = loader.loadSkill(ref); await started.promise;
  // Let the response reach getReader/read before advancing the shared deadline.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(4000);
  const error = await fail(reading, 'FK_R014'); assert.equal(error.cause.name, 'TimeoutError');
  assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal(controller.signal.aborted, false);
  t.mock.timers.reset();
  const fetchStarted = deferred(); t.mock.timers.enable({ apis: ['setTimeout'] });
  const stalled = remoteLoader(() => { fetchStarted.resolve(); return new Promise(() => {}); }).loadSkill(ref);
  await fetchStarted.promise; t.mock.timers.tick(10000);
  assert.equal((await fail(stalled, 'FK_R014')).cause.name, 'TimeoutError');
});

test('real execution uses remote default loader once across agent retries and never retries Skill failures', async t => {
  const f = await fixture(t, [agent(`skill:'${ref}',integrity:'${pin('instructions')}',retries:2`), end()]);
  let reads = 0, attempts = 0;
  const runtime = host({ runAgent: async step => { attempts++; assert.equal(step.instruction, 'instructions'); if (attempts < 3) throw Error('retry'); return {}; }, validateResult: () => [] });
  const options = { projectRoot: f.directory, remoteSkillHosts: ['example.test'], fetch: async () => { reads++; return new Response('instructions'); } };
  await f.run(runtime, {}, options); assert.equal(reads, 1); assert.equal(attempts, 3);
  attempts = 0;
  await fail(f.run(runtime, {}, { ...options, fetch: async () => new Response('', { status: 503 }) }), 'FK_R014'); assert.equal(attempts, 0);
});

test('one real parallel execution shares the pending remote read without sharing its next-run cache', async t => {
  const f = await fixture(t, [
    "parallel('p',{name:'P',branches:['a','b'],join:{strategy:'all_succeeded',next:'done'}})",
    `node('a',{name:'A',skill:'${ref}',output:{type:'object'}})`, `node('b',{name:'B',skill:'${ref}',output:{type:'object'}})`, end()]);
  let reads = 0, calls = 0;
  const runtime = host({ runAgent: async () => { calls++; return {}; }, validateResult: () => [] });
  const options = { projectRoot: f.directory, remoteSkillHosts: ['example.test'], fetch: async () => { reads++; await new Promise(resolve => setImmediate(resolve)); return new Response('shared'); } };
  await f.run(runtime, {}, options); assert.equal(reads, 1); assert.equal(calls, 2);
  await f.run(runtime, {}, options); assert.equal(reads, 2); assert.equal(calls, 4);
});
