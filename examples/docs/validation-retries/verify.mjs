import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
const fixed = await scenario(); assert.equal(fixed.result.state.answer, '已修正'); assert.equal(fixed.attempts.length, 2); assert.deepEqual(fixed.attempts[1].reasons, ['answer 必须是字符串']);
const failed = await scenario(true); assert.equal(failed.error.code, 'FK_R004'); assert.equal(failed.attempts.length, 3); assert.deepEqual(failed.initial, {});
assert.deepEqual(fixed.stateAtEnd, { answer: '已修正' }); assert.deepEqual(fixed.initial, {});
assert.deepEqual(failed.stateAtEnd, {});
for (const attempt of [...fixed.attempts, ...failed.attempts]) assert.deepEqual(attempt.stateBefore, {}, 'invalid output must not enter running state before retry');
console.log('retries, correction reasons and exhaustion verified');
