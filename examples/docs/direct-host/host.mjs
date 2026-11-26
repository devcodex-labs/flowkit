// Reference Host for trusted FlowKit 1.0.0 Standard output, not a general ABI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function scenario() {
  let flowkitPackageResolvable = true;
  try { import.meta.resolve('@devcodex-labs/flowkit'); }
  catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; flowkitPackageResolvable = false; }
  assert.equal(flowkitPackageResolvable, false, 'Use the isolated prepare.mjs delivery, outside the compiler project');
  const delivery = JSON.parse(await readFile(new URL('./delivery.json', import.meta.url), 'utf8'));
  assert.equal(delivery.compilerVersion, '1.0.0', 'Review this reference Host before using another compiler version');
  const files = ['host.mjs', 'sample.workflow.js.compiled.mjs', 'skills/writer.md'];
  assert.deepEqual(Object.keys(delivery.hashes).sort(), [...files].sort());
  for (const file of files) {
    const actual = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
    assert.equal(actual, delivery.hashes[file], `Delivery bytes changed: ${file}`);
  }
  // The trusted delivery channel, not this adjacent checksum file, establishes trust.
  const { workflow } = await import(new URL('./sample.workflow.js.compiled.mjs', import.meta.url));
  const events = [], trace = [];
  const initial = { topic: 'FlowKit 入门' };
  const ctx = { state: { ...initial }, runId: 'direct-host-demo', runtime: {
    isControlSignal: error => error?.control === true,
    async loadSkill(file) {
      assert.equal(file, 'skills/writer.md');
      events.push('skill');
      return readFile(new URL('./skills/writer.md', import.meta.url), 'utf8');
    },
    async runAgent(step) {
      events.push('agent');
      return { draft: `${step.input.topic}：先运行最小例，再接入自己的业务。` };
    },
    validateResult(_schema, value) {
      events.push('validate');
      // Only this example's schema. Replace with your authorized schema validator.
      return value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.draft === 'string' && Object.keys(value).length === 1 ? [] : ['需要且仅允许draft字符串'];
    },
    async checkStep(_step, _value, context) {
      events.push('checkStep');
      assert.equal(Object.hasOwn(context.state, 'draft'), false);
      return null;
    },
    async runVerification(_id, _name, context) { events.push('verify'); return context.state.draft.length > 0; },
    async runHuman() { events.push('human'); return { approved: true, comment: '可以交付' }; },
    async runAction(_id, _name, context) { events.push('action'); context.state.draft += '（已修订）'; },
    trace: { start(id) { trace.push({ event: 'start', id }); }, end(id, _name, outcome) { trace.push({ event: 'end', id, outcome }); } },
  } };
  // There is no SDK context creation, default loader or result assembly here.
  const terminal = await workflow(ctx);
  const result = { ...terminal, state: ctx.state, ...(Object.hasOwn(ctx, 'error') ? { error: ctx.error } : {}) };
  assert.deepEqual(initial, { topic: 'FlowKit 入门' });
  return { result, events, trace, flowkitPackageResolvable, sdkRunUsed: false, model: 'deterministic fixture' };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await scenario(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
