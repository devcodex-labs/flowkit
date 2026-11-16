import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const { deploymentDir } = JSON.parse(await readFile(new URL('./deployment.json', import.meta.url), 'utf8'));
// The trusted demo needs no model/login environment. Only retain Windows OS setup.
const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const result = spawnSync(process.execPath, ['host.mjs'], { cwd: deploymentDir, env, encoding: 'utf8' });
if (result.error) throw result.error;
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
