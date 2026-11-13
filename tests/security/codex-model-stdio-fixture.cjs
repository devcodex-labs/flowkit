const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');
const {writeFileSync} = require('node:fs');
const path = require('node:path');

try {
  const launcher = process.env.FLOWKIT_FIXTURE_STDIO_EXE;
  const sid = process.env.FLOWKIT_FIXTURE_MODEL_SID;
  assert.equal(execFileSync(launcher, ['--host-identity'], {encoding: 'utf8', timeout: 3000}).trim(), sid);
  const child = spawnSync(launcher, [process.execPath], {
    input: 'fixture stdin\n',
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, 'fixture stderr');
  const [record, echo] = child.stdout.trim().split(/\r?\n/);
  const identity = JSON.parse(record);
  assert.equal(identity.method, 'flowkit/profile/identity');
  assert.equal(identity.params.modelSid, sid);
  assert.equal(identity.params.modelElevated, false);
  assert.ok(Number.isSafeInteger(identity.params.pid) && identity.params.pid > 1);
  assert.equal(identity.params.stdioAllowlist, true);
  assert.equal(echo, 'fixture stdin');
  writeFileSync(path.join(process.env.TEMP, 'stdio-result.json'), JSON.stringify({
    event: 'codex-model-stdio-fixture',
    ...identity.params,
    roundTrip: true,
  }));
} catch (error) {
  writeFileSync(path.join(process.env.TEMP, 'stdio-error.txt'), error.stack);
  process.exitCode = 1;
}
