import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { run, check } from '@devcodex-labs/flowkit';
import { file, runtime } from './host.mjs';
const skill = new URL('./skills/instruction.md', import.meta.url), original = await readFile(skill), source = await readFile(file);
try {
  const initial = { count: 0 };
  assert.equal((await run(file, runtime, initial)).state.count, 1);
  assert.equal((await run(file, runtime, initial)).state.count, 1); assert.equal(initial.count, 0);
  await writeFile(skill, '第二版指令'); assert.equal((await run(file, runtime, initial)).state.instruction, '第二版指令');
  await unlink(skill); await assert.rejects(run(file, runtime, initial), { code: 'FK_R010' });
  assert.ok((await check(file)).some(item => item.code === 'FK_C051'));
  await writeFile(skill, original);
  await assert.rejects(run(file, { ...runtime, async runAgent() { throw new Error('业务失败'); } }, initial), { code: 'FK_R004' });
  assert.equal((await run(file, runtime, initial)).status, 'succeeded');
  await writeFile(file, Buffer.concat([source, Buffer.from('\n// source changed\n')]));
  const events = [];
  await run(file, { ...runtime, trace: { start(id) { events.push(id); }, end() {} } }, initial, { trace: true });
  assert.ok(events.includes('answer'));
} finally { await writeFile(file, source); await writeFile(skill, original); }
console.log('fresh context, current Skill bytes, source/options and failure recovery verified');
