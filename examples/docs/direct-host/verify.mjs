import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { prepare } from './prepare.mjs';
const locator = new URL('./deployment.json', import.meta.url);
const readLocator = () => readFile(locator).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const previousLocator = await readLocator();
const { deploymentDir } = await prepare(undefined, { publishLocator: false });
try {
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, ['host.mjs'], { cwd: deploymentDir, env, encoding: 'utf8' });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.flowkitPackageResolvable, false); assert.equal(output.sdkRunUsed, false);
  assert.equal(output.result.status, 'succeeded'); assert.equal(output.result.terminal, 'done');
  assert.equal(output.result.state.approval.comment, '可以交付');
  assert.deepEqual(output.events, ['skill', 'agent', 'validate', 'checkStep', 'verify', 'human']);
  assert.ok(output.trace.some(item => item.event === 'end' && item.outcome === 'ok'));
  assert.deepEqual(await readLocator(), previousLocator, 'Verification must preserve the manual delivery locator');
  console.log('isolated direct Host: succeeded/done; no FlowKit execution dependency');
} finally {
  // Remove only this example's fresh OS-temp delivery; no source or user files.
  assert.ok(path.basename(deploymentDir).startsWith('flowkit-direct-'));
  await rm(deploymentDir, { recursive: true, force: true });
}
