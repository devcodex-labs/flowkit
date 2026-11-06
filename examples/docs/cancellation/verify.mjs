import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
assert.deepEqual(await scenario(), { status: 'cancelled', message: '用户取消', cleaned: true });
assert.equal((await scenario('error')).status, 'error'); assert.equal((await scenario('ok')).status, 'succeeded');
console.log('cooperative cancellation and ordinary errors verified');
