import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// 仅复制本阶段实际存在的模块；不生成编译器、运行时或CLI占位入口。
const files = [
  ['src/dsl.mjs', 'dist/dsl.mjs'],
  ['src/shared/contracts.mjs', 'dist/shared/contracts.mjs'],
  ['types/dsl.d.ts', 'dist/dsl.d.ts'],
  ['types/index.d.ts', 'dist/index.d.ts'],
];
for (const [source, destination] of files) {
  const target = path.join(root, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(root, source), target);
}
