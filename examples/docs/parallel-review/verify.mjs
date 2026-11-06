import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
const all = await scenario('all'); assert.equal(all.result.state.fast, false); assert.equal(all.result.state.slowDone, true);
const any = await scenario('any'); assert.deepEqual(any.atJoin, ['fast:false']); assert.ok(any.events.includes('slow:done')); assert.equal(any.result.status, 'succeeded');
await assert.rejects(scenario('all', true), /慢分支失败/);
console.log('all/any, false and rejection verified');
