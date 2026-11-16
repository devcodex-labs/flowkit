import { compile } from '@devcodex-labs/flowkit';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const { version } = createRequire(import.meta.url)('@devcodex-labs/flowkit/package.json');
export async function prepare(destination, { publishLocator = true } = {}) {
  const compiled = await compile(path.join(here, 'sample.workflow.js'), { trace: true });
  if (compiled.diagnostics.some(item => item.severity === 'error')) throw new Error(JSON.stringify(compiled.diagnostics));
  // A new OS-temp directory cannot borrow this compiler project's node_modules.
  const deploymentDir = destination ? path.resolve(destination) : await mkdtemp(path.join(tmpdir(), 'flowkit-direct-'));
  if (destination) await mkdir(deploymentDir); // Refuse to overwrite an existing delivery.
  await mkdir(path.join(deploymentDir, 'skills'));
  const hashes = {};
  for (const file of ['host.mjs', 'sample.compiled.mjs', 'skills/writer.md']) {
    await copyFile(path.join(here, file), path.join(deploymentDir, file));
    hashes[file] = createHash('sha256').update(await readFile(path.join(deploymentDir, file))).digest('hex');
  }
  await writeFile(path.join(deploymentDir, 'delivery.json'), JSON.stringify({ compilerVersion: version, hashes }, null, 2));
  // Verification creates its own delivery without changing the user's locator.
  if (publishLocator) await writeFile(path.join(here, 'deployment.json'), JSON.stringify({ deploymentDir }));
  return { deploymentDir, compilerVersion: version, files: [...Object.keys(hashes), 'delivery.json'] };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepare(process.argv[2]), null, 2));
