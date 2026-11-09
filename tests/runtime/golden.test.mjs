import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compile, run, check, evalWhen, isControlSignal } from '@devcodex-labs/flowkit';
import { demo } from '../../examples/demo.mjs';
import { createRuntime, validateExample } from '../../examples/host.mjs';
import { exampleAgent } from '../../examples/agent.mjs';

const root = new URL('../../examples/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('golden raw-byte manifest, fixed JavaScript and Mermaid reproduce through public compile/check/AOT', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'flowkit-golden-'));
  t.after(async () => { assert.ok(path.basename(temporary).startsWith('flowkit-golden-')); await rm(temporary, { recursive: true, force: true }); });
  for (const item of manifest.files) {
    const bytes = await readFile(new URL(item.path, root));
    assert.equal(bytes.length, item.bytes); assert.equal(digest(bytes), item.sha256, item.path);
    const target = path.join(temporary, item.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
  for (const item of manifest.workflows) {
    const file = path.join(temporary, item.source);
    const options = { projectRoot: temporary, remoteSkillHosts: ['skills.example.test'] };
    const result = await compile(file, options); assert.deepEqual(result.diagnostics, []);
    assert.equal(result.code, await readFile(new URL(item.code, root), 'utf8'));
    assert.equal(result.mermaid, await readFile(new URL(item.mermaid, root), 'utf8'));
    assert.deepEqual(await check(file, options), []);
    assert.ok(!/\b(?:switch\s*\(\s*pc|while\s*\(\s*pc|nodes\[pc)/.test(result.code));
    if (item.source.startsWith('shared-join')) {
      assert.equal((result.code.match(/runAction\("save"/g) ?? []).length, 1);
      for (const urgent of [false, true]) {
        const events = []; const runtime = { evalWhen, isControlSignal, runAction: async action => events.push(action) };
        const output = await run(path.join(temporary, item.code), runtime, { urgent }, options);
        assert.equal(output.status, 'succeeded'); assert.deepEqual(events, [urgent ? 'fast' : 'normal', 'save']);
      }
    }
  }
  for (const item of manifest.remoteSkills) {
    const bytes = await readFile(new URL(item.local, root));
    assert.equal(item.integrity, `sha256-${createHash('sha256').update(bytes).digest('base64')}`);
    assert.ok((await readFile(new URL('remote.workflow.js', root), 'utf8')).includes(item.integrity));
  }
});

test('editorial golden covers direct approval, failed review, repair, human rejection and shared publish', async () => {
  const direct = await demo(); assert.equal(direct.result.status, 'succeeded');
  assert.equal(direct.events.filter(event => event === 'publish').length, 1); assert.ok(!direct.events.includes('verify'));
  const repaired = await demo({ reviewOk: false, qualityPassAfter: 2, rejectOnce: true });
  assert.equal(repaired.result.status, 'succeeded');
  assert.deepEqual(repaired.events.slice(4), ['verify', 'repair', 'verify', 'human', 'revise', 'human', 'publish']);
  assert.deepEqual(repaired.result.state.approval, { approved: true, comment: null });
  const exhausted = await demo({ reviewOk: false, qualityPassAfter: 4 });
  assert.equal(exhausted.result.status, 'failed'); assert.equal(exhausted.result.terminal, 'failed');
  assert.deepEqual(exhausted.events.slice(4), ['verify', 'repair', 'verify', 'repair', 'verify']);
});

test('same instruction-following adapter accepts current Skills and exhausts with the archived bare-true instruction', async t => {
  const valid = await demo({ remote: true }); assert.equal(valid.result.status, 'succeeded');
  assert.equal(valid.result.state.styleOk, true); assert.equal(valid.result.state.factOk, true);
  const legacy = await readFile(new URL('../fixtures/legacy-review.md', import.meta.url));
  const temporary = await mkdtemp(path.join(tmpdir(), 'flowkit-legacy-skill-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const legacyIntegrity = `sha256-${createHash('sha256').update(legacy).digest('base64')}`;
  let source = await readFile(new URL('remote.workflow.js', root), 'utf8');
  for (const item of manifest.remoteSkills) source = source.replace(item.integrity, legacyIntegrity);
  const filename = path.join(temporary, 'legacy.workflow.js'); await writeFile(filename, source);
  const seen = [];
  const runtime = createRuntime({ agent: async step => { seen.push(step.instruction); return exampleAgent(step); }, validate: validateExample,
    approve: async () => true, verify: async () => true, act: async () => {} });
  await assert.rejects(run(filename, runtime, { draft: 'Draft', evidence: 'Evidence' }, {
    projectRoot: temporary, remoteSkillHosts: ['skills.example.test'], fetch: async () => new Response(legacy),
  }), error => error.code === 'FK_R004' && error.reasons.includes('Expected object'));
  assert.ok(seen.length >= 3); assert.ok(seen.every(instruction => instruction === legacy.toString('utf8')));
  assert.equal(await exampleAgent({ instruction: legacy.toString('utf8') }), true);
  await assert.rejects(exampleAgent({ instruction: 'Return a JSON object with factOk.', resultSchema: {properties:{styleOk:{type:'boolean'}}} }), /does not describe styleOk/);
});

test('host template delegates full schema validation and example validator refuses unsupported schema', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  assert.deepEqual(validateExample(schema, { ok: true }), []);
  assert.ok(validateExample(schema, true).length); assert.ok(validateExample(schema, {}).length);
  assert.ok(validateExample(schema, { ok: 'true', extra: 1 }).length);
  assert.throws(() => validateExample({ type: 'object', allOf: [] }, {}), TypeError);
  const marker = {}; const runtime = createRuntime({ agent() {}, validate: (s, r) => { assert.equal(s, schema); assert.equal(r, marker); return ['dialect error']; }, approve() {}, verify() {}, act() {} });
  assert.deepEqual(runtime.validateResult(schema, marker), ['dialect error']);
});
