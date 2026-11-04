import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, end, host, settled, deferred } from './support.mjs';

test('terminal results attach the actual isolated state and do not precreate an error', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'inspect',next:'done'})", end()]);
  const initial = { value: 1, error: 'state key' }; let context;
  const runtime = host({ runAction: async (_action, _name, ctx) => {
    context = ctx; assert.equal(ctx.runtime, runtime); assert.equal(Object.hasOwn(ctx, 'error'), false);
    ctx.state.value = 2;
  } });
  const result = await f.run(runtime, initial);
  assert.deepEqual(result, { status: 'succeeded', terminal: 'done', state: { value: 2, error: 'state key' } });
  assert.equal(result.state, context.state); assert.notEqual(result.state, initial);
  assert.deepEqual(initial, { value: 1, error: 'state key' }); assert.equal(Object.hasOwn(result, 'error'), false);
  const failed = await fixture(t, [end('failed', 'failed')]);
  assert.deepEqual(await failed.run(host()), { status: 'failed', terminal: 'failed', state: {} });
});

test('state copying preserves own special data keys, drops inherited or hidden keys, and stays shallow', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'inspect',next:'done'})", end()]);
  const nested = { value: 1 };
  const initial = Object.create({ inherited: 9 });
  Object.defineProperty(initial, '__proto__', { value: 'own', enumerable: true });
  Object.assign(initial, { constructor: 'constructor data', toString: 'string data', nested });
  Object.defineProperty(initial, 'hidden', { value: 1 }); initial[Symbol('ignored')] = 1; Object.freeze(initial);
  const result = await f.run(host({ runAction: async (_a, _n, ctx) => {
    assert.equal(Object.getPrototypeOf(ctx.state), Object.prototype);
    assert.equal(ctx.state.__proto__, 'own'); assert.equal(Object.hasOwn(ctx.state, 'inherited'), false);
    assert.equal(Object.hasOwn(ctx.state, 'hidden'), false); assert.deepEqual(Object.getOwnPropertySymbols(ctx.state), []);
    ctx.state.__proto__ = 'changed'; ctx.state.nested.value = 2;
  } }), initial);
  assert.equal(Object.getPrototypeOf(result.state), Object.prototype);
  assert.equal(result.state.__proto__, 'changed'); assert.equal(initial.__proto__, 'own');
  assert.equal(result.state.constructor, 'constructor data'); assert.equal(result.state.toString, 'string data');
  assert.equal(result.state.nested, nested); assert.equal(initial.nested.value, 2);
});

test('each execution creates a context and runId while preserving an explicit empty id and aborted signal', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'inspect',next:'done'})", end()]);
  const contexts = []; const runtime = host({ runAction: async (_a, _n, ctx) => { contexts.push(ctx); ctx.state.n = (ctx.state.n ?? 0) + 1; } });
  const original = { n: 0 };
  const results = await Promise.all([f.run(runtime, original), f.run(runtime, original)]);
  assert.notEqual(contexts[0], contexts[1]); assert.notEqual(contexts[0].state, contexts[1].state);
  assert.notEqual(contexts[0].runId, contexts[1].runId);
  for (const ctx of contexts) assert.match(ctx.runId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.equal(original.n, 0); assert.equal(results[0].state.n, 1); assert.equal(results[1].state.n, 1);
  const controller = new AbortController(); controller.abort();
  await f.run(runtime, original, { runId: '', signal: controller.signal });
  assert.equal(contexts[2].runId, ''); assert.equal(contexts[2].signal, controller.signal);
});

test('runtime prototype methods retain host this and business methods are not silently supplied', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'record',next:'done'})", end()]);
  class Runtime {
    #value = 42;
    isControlSignal(error) { return error?.control === true; }
    async runAction(_a, _n, ctx) { ctx.state.value = this.#value; }
  }
  assert.equal((await f.run(new Runtime())).state.value, 42);
  const missing = await settled(f.run(host()));
  assert.equal(missing.fulfilled, false); assert.ok(missing.error instanceof TypeError);
  assert.equal(Object.hasOwn(missing.error, 'phase'), false);
});

test('action catches attach error even for every falsy rejection and skip the verification call', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'save',next:'v'})",
    "verification('v',{name:'V',verifier:'verify',onSuccess:'done',onFailure:'failed'})", end(), end('failed', 'failed')]);
  for (const error of [undefined, null, false, 0, '', new Error('save')]) {
    const result = await f.run(host({ runAction: async () => { throw error; }, runVerification: async () => assert.fail('Skipped') }));
    assert.equal(result.status, 'failed'); assert.equal(result.terminal, 'failed');
    assert.equal(Object.hasOwn(result, 'error'), true); assert.equal(result.error, error);
    assert.deepEqual(Object.keys(result), ['status', 'terminal', 'state', 'error']);
  }
});

test('uncaught errors, primitive rejection values and control markers retain identity without wrapping', async t => {
  const direct = await fixture(t, ["action('a',{name:'A',action:'save',next:'done'})", end()]);
  const catchable = await fixture(t, ["action('a',{name:'A',action:'save',next:'v'})",
    "verification('v',{name:'V',verifier:'verify',onSuccess:'done',onFailure:'failed'})", end(), end('failed', 'failed')]);
  for (const error of [undefined, null, 0, 'business', new Error('business'), { control: true, kind: 'custom' }]) {
    const result = await settled(direct.run(host({ runAction: async () => { throw error; } })));
    assert.equal(result.fulfilled, false); assert.equal(result.error, error);
  }
  const control = { control: true, kind: 'cancel' };
  const result = await settled(catchable.run(host({ runAction: async () => { throw control; }, runVerification: async () => assert.fail('Skipped') })));
  assert.equal(result.fulfilled, false); assert.equal(result.error, control);
});

test('only an own ctx.error is returned and a replaced ctx.state remains the returned state', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'replace',next:'done'})", end()]);
  const replacement = { replaced: true };
  const result = await f.run(host({ runAction: async (_a, _n, ctx) => {
    Object.setPrototypeOf(ctx, { error: 'inherited' }); ctx.state = replacement;
  } }));
  assert.equal(result.state, replacement); assert.equal(Object.hasOwn(result, 'error'), false);
});

test('agent execution uses own inputs and candidates, retries once, and commits only a successful result', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'skills/a.md',inputs:['__proto__','inherited','missing'],output:{type:'object',properties:{'__proto__':{type:'number'},result:{type:'number'}}},verify:'check',retries:1,overview:true,next:'done'})", end()]);
  const initial = Object.create({ inherited: 1 }); Object.defineProperty(initial, '__proto__', { value: 1, enumerable: true });
  let loads = 0, attempts = 0, verified = 0;
  const runtime = host({ loadSkill: async () => { loads++; return 'instruction'; },
    runAgent: async step => {
      attempts++; assert.equal(step.instruction, 'instruction'); assert.equal(step.overview.step, 1);
      assert.deepEqual(step.missing, ['inherited', 'missing']); assert.equal(Object.hasOwn(step.input, '__proto__'), true);
      assert.equal(step.input.__proto__, 1); assert.equal(Object.hasOwn(step.input, 'missing'), true);
      assert.deepEqual(step.reasons, attempts === 1 ? [] : ['retry']);
      assert.equal(Object.hasOwn(step.resultSchema.properties, '__proto__'), true);
      return JSON.parse('{"__proto__":2,"result":2}');
    }, validateResult: () => attempts === 1 ? ['retry'] : [],
    runVerification: async (_v, _n, ctx) => {
      verified++; assert.equal(ctx.state.__proto__, 2); assert.equal(ctx.runtime, runtime);
      assert.equal(initial.__proto__, 1); return true;
    } });
  const result = await f.run(runtime, initial, { skillCheck: false });
  assert.equal(loads, 1); assert.equal(attempts, 2); assert.equal(verified, 1);
  assert.equal(result.state.__proto__, 2); assert.equal(result.state.result, 2); assert.equal(initial.result, undefined);
});

test('exhaustion preserves cause existence, while schema and hook crashes do not gain compile metadata', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},retries:0,next:'done'})", end()]);
  const exhausted = await settled(f.run(host({ loadSkill: async () => '', runAgent: async () => { throw undefined; }, validateResult: () => [] }), {}, { skillCheck: false }));
  assert.equal(exhausted.error.code, 'FK_R004'); assert.equal(Object.hasOwn(exhausted.error, 'cause'), true);
  assert.equal(exhausted.error.cause, undefined); assert.equal(Object.hasOwn(exhausted.error, 'phase'), false);
  const failure = new Error('validator'); let calls = 0;
  const crashed = await settled(f.run(host({ loadSkill: async () => '', runAgent: async () => { calls++; return {}; }, validateResult: () => { throw failure; } }), {}, { skillCheck: false }));
  assert.equal(crashed.error, failure); assert.equal(calls, 1); assert.equal(Object.hasOwn(failure, 'diagnostics'), false);
});

test('unprintable model rejections still exhaust retries with their original cause and usable reasons', async t => {
  const f = await fixture(t, ["node('n',{name:'N',skill:'skills/a.md',output:{type:'object'},retries:1,next:'done'})", end()]);
  const getter = Object.defineProperty({}, 'message', { get() { throw new Error('message getter'); } });
  const conversion = { [Symbol.toPrimitive]() { throw new Error('conversion'); } };
  for (const cause of [Object.create(null), { message: Symbol('message') }, getter, conversion]) {
    let attempts = 0;
    const result = await settled(f.run(host({ loadSkill: async () => '', validateResult: () => assert.fail('No result'),
      runAgent: async step => {
        attempts++; assert.equal(step.attempt, attempts);
        if (attempts === 1) assert.deepEqual(step.reasons, []);
        else assert.ok(step.reasons[0].startsWith('runAgent threw: '));
        throw cause;
      } }), {}, { skillCheck: false }));
    assert.equal(attempts, 2); assert.equal(result.fulfilled, false); assert.equal(result.error.code, 'FK_R004');
    assert.equal(result.error.cause, cause); assert.equal(Object.hasOwn(result.error, 'cause'), true);
    assert.equal(typeof result.error.reasons[0], 'string'); assert.equal(Object.hasOwn(result.error, 'phase'), false);
  }
  let messageReads = 0;
  const control = Object.defineProperty({ control: true }, 'message', { get() { messageReads++; throw new Error('Do not format controls'); } });
  let attempts = 0;
  const result = await settled(f.run(host({ loadSkill: async () => '', validateResult: () => [], runAgent: async () => { attempts++; throw control; } }), {}, { skillCheck: false }));
  assert.equal(result.error, control); assert.equal(attempts, 1); assert.equal(messageReads, 0);
});

test('parallel any returns the shared state and late branches can still commit their distinct keys', async t => {
  const f = await fixture(t, ["parallel('p',{name:'P',branches:['a','b'],join:{strategy:'any',next:'done'}})",
    "action('a',{name:'A',action:'a',writes:['a']})", "action('b',{name:'B',action:'b',writes:['b']})", end()]);
  const late = deferred(), ready = deferred(); let started = 0;
  const running = f.run(host({ runAction: async (id, _n, ctx) => {
    if (++started === 2) ready.resolve();
    if (id === 'b') await late.promise;
    ctx.state[id] = true;
  } }));
  await ready.promise;
  const result = await running; assert.equal(result.state.a, true); assert.equal(Object.hasOwn(result.state, 'b'), false);
  late.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.state.b, true);
});

test('parallel rejections keep native all first-rejection and any final-control semantics', async t => {
  for (const strategy of ['all_succeeded', 'any']) {
    const f = await fixture(t, [`parallel('p',{name:'P',branches:['a','b'],join:{strategy:'${strategy}',next:'done'}})`,
      "action('a',{name:'A',action:'a'})", "action('b',{name:'B',action:'b'})", end()]);
    const first = deferred(), last = deferred(), ready = deferred(); let started = 0;
    const business = new Error('business'), control = { control: true, kind: 'abort' };
    const running = settled(f.run(host({ runAction: id => { if (++started === 2) ready.resolve(); return id === 'a' ? first.promise : last.promise; } })));
    await ready.promise; first.reject(business); await Promise.resolve(); last.reject(control);
    const result = await running; assert.equal(result.fulfilled, false);
    assert.equal(result.error, strategy === 'any' ? control : business);
  }
});

test('trace hooks keep their own this while validation and action failures retain runtime outcomes', async t => {
  const f = await fixture(t, ["action('a',{name:'A',action:'save',next:'v'})",
    "verification('v',{name:'V',verifier:'verify',onSuccess:'done',onFailure:'failed'})", end(), end('failed', 'failed')]);
  const events = [];
  const trace = { start(id) { assert.equal(this, trace); events.push([id, 'start']); }, end(id, _name, outcome) { assert.equal(this, trace); events.push([id, outcome]); } };
  const result = await f.run(host({ trace, runAction: async () => { throw 0; }, runVerification: async () => assert.fail('Skipped') }), {}, { trace: true });
  assert.equal(result.error, 0); assert.deepEqual(events, [['a', 'start'], ['a', 'error']]);
  events.length = 0;
  await f.run(host({ trace, runAction: async () => {}, runVerification: async () => false }), {}, { trace: true });
  assert.deepEqual(events, [['a', 'start'], ['a', 'ok'], ['v', 'start'], ['v', 'ok']]);
});
