import assert from 'node:assert/strict';
import { compile } from '@devcodex/flowkit';
import { scenario } from './host.mjs';
assert.equal((await scenario()).requests, 1); // 同一次执行两个节点共享默认 loader 的成功缓存。
assert.equal((await scenario()).requests, 1); // 新运行重新建立 loader。
await assert.rejects(scenario('tampered'), { code: 'FK_R013' });
const denied = await compile('sample.workflow.js', { remoteSkillHosts: [] });
assert.ok(denied.diagnostics.some(item => item.code === 'FK_C057'));
assert.equal((await scenario()).result.status, 'succeeded');
console.log('fixed fetch, integrity, allowlist and per-run cache verified');
