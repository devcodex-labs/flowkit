import assert from 'node:assert/strict';
import { scenario } from './trusted.mjs';
import { scenario as versioned } from './versioned.mjs';
assert.deepEqual(await scenario('approved'), { status: 'succeeded', terminal: 'done', modelCalls: 1, signatureVerified: true, answer: '已生成：FlowKit' });
assert.deepEqual(await scenario('closed'), { status: 'failed', terminal: 'closed', modelCalls: 0, signatureVerified: false });
assert.deepEqual(await scenario('retry'), { status: 'succeeded', terminal: 'done', modelCalls: 2, signatureVerified: true, answer: '已生成：FlowKit' });
assert.deepEqual(await versioned(), { status: 'succeeded', terminal: 'done', pending: 0, samePendingOnResume: true, answer: '已生成：FlowKit' });
console.log('Interactive public interfaces: gate, signed acceptance, retry, same Pending and result projection verified with fixtures');
