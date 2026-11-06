import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { run, compile, isControlSignal } from '@devcodex/flowkit';
await import('./deploy.mjs');
const runtime = { isControlSignal, async runAgent(step) { return { draft: step.instruction.trim() }; }, validateResult(schema, value) { return typeof value?.draft === 'string' ? [] : ['draft']; } };
const file = 'deployment/sample.compiled.mjs', source = 'deployment/sample.workflow.js';
const bytes = await readFile(source);
assert.equal((await run(file, runtime)).status, 'succeeded');
try {
  await writeFile(source, Buffer.concat([bytes, Buffer.from('\n// changed\n')]));
  await assert.rejects(run(file, runtime), { code: 'FK_R001' });
  await compile(source); assert.equal((await run(file, runtime)).status, 'succeeded');
  await unlink(source); await assert.rejects(run(file, runtime), { code: 'FK_R001' });
} finally { await writeFile(source, bytes); await compile(source); }
assert.equal((await run(file, runtime)).status, 'succeeded');
console.log('independent deployment layout and AOT recovery verified');
