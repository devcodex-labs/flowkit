import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
const compilerVersion = JSON.parse(await readFile(path.join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
const compilerArgs = ['--noEmit', '--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM', '--module', 'NodeNext', '--moduleResolution', 'NodeNext'];
const scratch = path.join(root, '.tmp/types');
await mkdir(scratch, { recursive: true });
const nodes = Array.from({ length: 499 }, (_, i) => `action('step-${i}', { name: '动作${i}', action: 'save', next: '${i === 498 ? 'done' : `step-${i + 1}`}' })`);
const large = `import {defineWorkflow,action,terminal} from '@devcodex-labs/flowkit/dsl';\ndefineWorkflow({id:'large',version:'1.0.0',name:'规模',nodes:[\n${nodes.join(',\n')},\nterminal('done',{name:'完成',status:'succeeded'})]});\n`;
await writeFile(path.join(scratch, '500-valid.ts'), large);
await writeFile(path.join(scratch, '500-invalid.ts'), large.replace("next: 'done'", "next: 'missing-node'"));
const runs = [];
function run(name, args, expectedFailure = false) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [compiler, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const passed = expectedFailure ? result.status === 2 && output.includes('TS2554') && !output.includes('TS2589')
    : result.status === 0;
  runs.push({ name, passed, exitCode: result.status, elapsedMs: Math.round(performance.now() - started), expectedFailure, output });
  if (!passed) process.stderr.write(output || String(result.error || result.signal));
}
run('8类上下文/前向引用/正反例/公共与内部契约', ['-p', 'tests/types/tsconfig.json']);
run('500节点合法前向链', [...compilerArgs, '.tmp/types/500-valid.ts']);
run('500节点末端错拼引用拒绝', [...compilerArgs, '.tmp/types/500-invalid.ts'], true);
const record = { runId: 'flowkit-declarations', node: process.version, typescript: compilerVersion, runs,
  scope: 'DSL/reference and six implemented public SDK declarations including run', exitCode: runs.every(r => r.passed) ? 0 : 1 };
await writeFile(path.join(scratch, 'results.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify({ runId: record.runId, node: record.node, typescript: compilerVersion,
  runs: runs.map(({ output, ...summary }) => summary), exitCode: record.exitCode }, null, 2) + '\n');
process.exitCode = record.exitCode;
