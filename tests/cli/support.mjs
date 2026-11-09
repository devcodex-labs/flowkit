import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const entry = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
export const end = "terminal('done',{name:'Done',status:'succeeded'})";
export const definition = nodes => "import {defineWorkflow,node,action,terminal} from '@devcodex-labs/flowkit/dsl';\nexport default defineWorkflow({id:'cli',version:'1.0.0',name:'CLI',nodes:[" + nodes.join(',') + ']});\n';
export async function workspace(t, nodes = [end]) {
  const base = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(base, 'flowkit-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), base); assert.ok(path.basename(directory).startsWith('flowkit-cli-'));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'source.workflow.js'); await writeFile(file, definition(nodes));
  return { directory, file,
    config: source => writeFile(path.join(directory, 'flowkit.config.mjs'), source),
    invoke: (args, cwd = directory) => invoke(args, cwd) };
}
export function invoke(args, cwd) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null); return result;
}
export function diagnostics(result, expected) {
  assert.equal(result.status, expected, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith('\n'));
  return result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
}
export function configurationError(result) {
  const rows = diagnostics(result, 2); assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'column', 'file', 'line', 'message', 'severity']);
  assert.equal(rows[0].code, null); assert.equal(rows[0].file, 'flowkit.config.mjs');
  assert.equal(rows[0].line, 1); assert.equal(rows[0].column, 1); assert.equal(rows[0].severity, 'error');
  assert.equal(typeof rows[0].message, 'string'); return rows[0];
}
