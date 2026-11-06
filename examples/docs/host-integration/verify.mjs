import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
const { result, events } = await scenario();
assert.equal(result.status, 'succeeded'); assert.equal(result.state.approval.comment, '可以交付');
assert.deepEqual(events.map(item => item.event), ['agent', 'validate', 'checkStep', 'verify', 'human']);
assert.equal(events[2].committed, false); assert.equal(events[3].candidate, result.state.draft);
assert.deepEqual(events[0].missing, []); console.log('host contract verified');
