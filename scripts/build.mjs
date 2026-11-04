import { mkdir, copyFile, rm, lstat, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packageFiles } from './package-files.mjs';

/** Rebuild only this project's derived dist directory; never follow a dist link. */
export async function build(projectRoot = fileURLToPath(new URL('../', import.meta.url))) {
  const root = path.resolve(projectRoot), output = path.resolve(root, 'dist');
  if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Invalid build output');
  try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Refusing a linked dist directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Validate all inputs before replacing the derived tree.
  for (const [source] of packageFiles) if (!(await lstat(path.join(root, source))).isFile()) throw new Error(`Invalid build input: ${source}`);
  await rm(output, { recursive: true, force: true });
  for (const [source, destination] of packageFiles) {
    const target = path.join(root, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, source), target);
  }
  await chmod(path.join(output, 'cli.mjs'), 0o755);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
