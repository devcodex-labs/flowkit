import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPrivatePackage } from './check-package-privacy.mjs';
const pkg = { name: '@devcodex-labs/flowkit', package_type: 'npm', owner: { login: 'devcodex-labs' }, visibility: 'private' };
const response = (status, value) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
test('package privacy check accepts verified private scoped npm identity', async () => {
  const urls = [];
  const result = await checkPrivatePackage({ token: 'fixture', fetchImpl: async url => { urls.push(url); return response(200, pkg); } });
  assert.equal(result.verified, true); assert.equal(result.visibility, 'private');
  assert(urls[0].includes('%2Fflowkit'));
});
test('privacy check tries both API package-name encodings and fails closed', async () => {
  let calls = 0;
  const result = await checkPrivatePackage({ token: 'fixture', fetchImpl: async () => ++calls === 1 ? response(404) : response(200, { ...pkg, name: 'flowkit' }) });
  assert.equal(result.visibility, 'private'); assert.equal(calls, 2);
  await assert.rejects(checkPrivatePackage({ token: 'fixture', fetchImpl: async () => response(200, { ...pkg, visibility: 'public' }) }), /private/);
  await assert.rejects(checkPrivatePackage({ token: 'fixture', fetchImpl: async () => response(404) }), /unavailable/);
  await assert.rejects(checkPrivatePackage({ token: '', fetchImpl: async () => response(200, pkg) }), /GITHUB_TOKEN/);
});
