import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { scenario } from './host.mjs';
const success = await scenario(1); assert.equal(success.result.status, 'succeeded'); assert.deepEqual(success.events, ['check:0', 'repair:1', 'check:1']);
const exhausted = await scenario(9); assert.equal(exhausted.result.status, 'failed'); assert.deepEqual(exhausted.events, ['check:0', 'repair:1', 'check:1', 'repair:2', 'check:2']);
const single = new URL('./single.workflow.js', import.meta.url);
try { await writeFile(single, (await readFile(new URL('./sample.workflow.js', import.meta.url), 'utf8')).replace('maxIterations: 3', 'maxIterations: 1')); assert.deepEqual((await scenario(9, 'single.workflow.js')).events, ['check:0']); } finally { await unlink(single); }
console.log('loop success/exhaustion/final check verified');
