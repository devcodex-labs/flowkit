import assert from 'node:assert/strict';
import { scenario } from './host.mjs';
const direct = await scenario([true]); assert.equal(direct.events.length, 1); assert.equal(direct.result.state.draft, '第一版');
const revised = await scenario(); assert.equal(revised.events.length, 3); assert.equal(revised.events[1].feedback, '请补充说明'); assert.equal(revised.result.state.approval.approved, true); assert.ok(revised.result.state.draft.includes('已补充'));
await assert.rejects(scenario(['yes']), { code: 'FK_R002' }); assert.equal((await scenario([true])).result.status, 'succeeded');
console.log('approval variants and recovery verified');
