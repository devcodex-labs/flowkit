import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileSource, check, run, evalWhen, isControlSignal } from '@devcodex-labs/flowkit';
import { validateExample } from '../../examples/host.mjs';

const directory = new URL('../fixtures/errors/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('../fixtures/contract-codes.json', import.meta.url)));
const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
const header = "import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';\n";
function materialize(spec) {
  if (!spec.chainLength) return spec.source;
  const nodes = Array.from({ length: spec.chainLength - 1 }, (_, i) => `action('n-${i}',{name:'N ${i}',action:'save',next:'${i === spec.chainLength - 2 ? 'done' : `n-${i + 1}`}'})`);
  nodes.push("terminal('done',{name:'Done',status:'succeeded'})");
  return `${header}export default defineWorkflow({id:'capacity',version:'1.0.0',name:'Capacity',nodes:[${nodes.join(',')}]});`;
}
const host = () => ({ isControlSignal, evalWhen, runAction: async () => {}, runHuman: async () => true,
  runVerification: async () => true, runAgent: async () => ({}), validateResult: () => [] });

test('independent diagnostic fixture denominator is exactly the confirmed 61 codes', () => {
  assert.deepEqual(files.map(file => file.replace('.json', '')), catalog.codes.map(item => item.code).sort());
  assert.equal(files.length, 61);
});

for (const file of files) {
  const fixture = JSON.parse(await readFile(new URL(file, directory)));
  test(`acceptance ${fixture.code}: minimal counterexample and adjacent legal case`, async t => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'flowkit-errors-'));
    const project = path.join(temporary, 'project'); await mkdir(project);
    const sourceFile = path.join(project, 'case.workflow.js');
    t.after(async () => { assert.equal(path.dirname(temporary), path.resolve(tmpdir())); assert.ok(path.basename(temporary).startsWith('flowkit-errors-')); await rm(temporary, { recursive: true, force: true }); });
    const skill = path.join(project, 'skills'); await mkdir(skill);
    await writeFile(path.join(skill, 'writer.md'), '返回满足 resultSchema 的对象。');
    for (const legal of [false, true]) {
      const spec = legal ? fixture.valid : fixture.invalid;
      const source = materialize(spec); await writeFile(sourceFile, source);
      const options = { ...spec.options, projectRoot: project };
      if (fixture.kind === 'compile') {
        const result = await compileSource(source, { ...options, filename: sourceFile });
        if (legal) {
          assert.deepEqual(result.diagnostics, [], `${fixture.code} adjacent legal case`);
          assert.ok(result.code.length > 0);
        } else {
          const diagnostic = result.diagnostics.find(item => item.code === fixture.code);
          assert.ok(diagnostic, JSON.stringify(result.diagnostics));
          assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
          if (diagnostic.severity === 'warning') {
            assert.ok(result.code.length > 0); assert.equal(result.diagnostics.some(item => item.severity === 'error'), false);
            const runtime = host(); options.fetch = async () => new Response('Skill');
            const output = await run(sourceFile, runtime, { flag: false }, options);
            assert.equal(output.status, 'succeeded');
          } else assert.equal(result.code, '');
        }
        continue;
      }
      if (spec.mode === 'stale-artifact') {
        const compiled = await compileSource(source, { ...options, filename: sourceFile }); assert.deepEqual(compiled.diagnostics, []);
        if (!legal) await writeFile(path.join(project, 'case.compiled.mjs'), compiled.code + '\n// stale\n');
        assert.deepEqual((await check(sourceFile, options)).map(item => item.code), legal ? [] : ['FK_R001']);
        continue;
      }
      const runtime = host();
      options.fetch = async () => new Response(await readFile(new URL('../../examples/skills/style.md', import.meta.url)));
      if (spec.mode === 'human-return' && !legal) runtime.runHuman = async () => 1;
      if (spec.mode === 'agent-schema') {
        runtime.validateResult = validateExample;
        runtime.runAgent = async () => legal ? {} : true;
      }
      if (spec.mode === 'missing-skill') {
        if (!legal) await rm(path.join(skill, 'writer.md'));
        else await writeFile(path.join(skill, 'writer.md'), '合法 Skill');
      }
      if (spec.mode === 'escaping-skill') {
        if (!legal) {
          const outside = path.join(temporary, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'writer.md'), 'outside');
          await rm(skill, { recursive: true }); await symlink(outside, skill, process.platform === 'win32' ? 'junction' : 'dir');
        } else {
          await rm(skill); await mkdir(skill); await writeFile(path.join(skill, 'writer.md'), 'inside');
        }
      }
      if (spec.mode === 'cross-origin' && !legal) options.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.example.test/style.md' } });
      if (spec.mode === 'digest-mismatch' && !legal) options.fetch = async () => new Response('Different bytes');
      if (spec.mode === 'invalid-utf8') await writeFile(path.join(skill, 'writer.md'), legal ? '合法中文' : Buffer.from([0xff]));
      if (legal || spec.mode === 'reserved') {
        const result = await run(sourceFile, runtime, {}, options); assert.equal(result.status, 'succeeded');
        if (spec.mode === 'reserved') {
          const compiled = await compileSource(source, { filename: sourceFile, ...options });
          assert.ok(!compiled.code.includes('FK_R003')); assert.ok(!Object.hasOwn(result, 'error'));
        }
      } else {
        await assert.rejects(run(sourceFile, runtime, {}, options), error => {
          assert.equal(error.code, fixture.code);
          if (fixture.code === 'FK_R014') assert.ok(Object.hasOwn(error, 'cause'));
          if (fixture.code === 'FK_R004') { assert.ok(error.reasons.length > 0); assert.equal(Object.hasOwn(error, 'cause'), false); }
          return true;
        });
      }
    }
  });
}
