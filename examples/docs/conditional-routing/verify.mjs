import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
assert.equal((await scenario(true)).state.route, 'fast');
assert.equal((await scenario(false)).state.route, 'normal');
assert.equal((await scenario(true, 'ts')).state.route, 'fast');
await assert.rejects(scenario('yes'), { code: 'FK_R002' });
assert.equal((await scenario(true)).status, 'succeeded');
console.log('routing variants and recovery verified');
