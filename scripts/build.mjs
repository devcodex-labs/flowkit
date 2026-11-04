import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// 仅复制本阶段实际存在的模块；不生成编译器、运行时或CLI占位入口。
const files = [
  ['src/index.mjs', 'dist/index.mjs'],
  ['src/cli.mjs', 'dist/cli.mjs'],
  ...['arguments', 'config', 'main'].map(name => [`src/cli/${name}.mjs`, `dist/cli/${name}.mjs`]),
  ['src/dsl.mjs', 'dist/dsl.mjs'],
  ['src/shared/contracts.mjs', 'dist/shared/contracts.mjs'],
  ['src/shared/control.mjs', 'dist/shared/control.mjs'],
  ['src/shared/skill-ref.mjs', 'dist/shared/skill-ref.mjs'],
  ...['source', 'extract', 'validate', 'skill-check', 'analyze', 'graph-algorithms', 'graph', 'dataflow',
    'values', 'paths', 'mermaid', 'emit-plan', 'helpers', 'emit', 'compile', 'api', 'output'].map(name =>
    [`src/compiler/${name}.mjs`, `dist/compiler/${name}.mjs`]),
  ...['parser', 'evaluate'].map(name => [`src/when/${name}.mjs`, `dist/when/${name}.mjs`]),
  ...['context', 'execute', 'load', 'source', 'skills', 'skill-remote', 'run', 'aot', 'dump', 'dump-channel', 'dump-hook'].map(name => [`src/runtime/${name}.mjs`, `dist/runtime/${name}.mjs`]),
  ['types/dsl.d.ts', 'dist/dsl.d.ts'],
  ['types/index.d.ts', 'dist/index.d.ts'],
  ['types/compiler-api.d.ts', 'dist/compiler-api.d.ts'],
];
for (const [source, destination] of files) {
  const target = path.join(root, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
}
