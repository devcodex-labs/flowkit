import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Parser } from 'tar';
import { isSemVer } from '../src/compiler/validate.mjs';
import { packageFiles } from './package-files.mjs';
import { validatePackage } from './check-package.mjs';
import { runProcess } from './validation-process.mjs';

const registry = 'https://npm.pkg.github.com/';
const repository = 'git+https://github.com/devcodex-labs/flowkit.git';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));

/** Report all readiness gaps without changing metadata or contacting npm. */
export async function assessRelease(root, tag) {
  const pkg = await json(path.join(root, 'package.json'));
  const lock = await json(path.join(root, 'package-lock.json'));
  const issues = [];
  const require = (condition, field, message) => { if (!condition) issues.push({ field, message }); };
  const validVersion = isSemVer(pkg.version) && !pkg.version.includes('+');
  require(pkg.name === '@devcodex-labs/flowkit', 'name', 'Unexpected package name');
  require(validVersion, 'version', 'Use a SemVer release version without build metadata');
  require(typeof tag === 'string' && tag === `v${pkg.version}`, 'tag', 'Tag must equal v plus the package version');
  require(pkg.private === false, 'private', 'A release candidate must explicitly set private:false');
  require(lock.name === pkg.name && lock.version === pkg.version && lock.packages?.['']?.name === pkg.name && lock.packages?.['']?.version === pkg.version,
    'lockfile', 'Root and packages[""] lock identity must match package.json');
  require(typeof pkg.license === 'string' && pkg.license.trim().length > 0 && pkg.license.trim() !== 'UNLICENSED', 'license', 'Choose and review the package license before release');
  let license = '', changelog = '';
  try { license = await readFile(path.join(root, 'LICENSE'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  require(license.trim().length > 0, 'LICENSE', 'A nonempty, approved LICENSE file is required');
  const heading = new RegExp(`^## \\[?${String(pkg.version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?(?:\\s|$)`, 'm');
  require(validVersion && heading.test(changelog), 'CHANGELOG', 'Add release notes headed by the exact package version');
  require(pkg.repository?.type === 'git' && pkg.repository?.url === repository, 'repository', 'Repository metadata must identify devcodex-labs/flowkit');
  require(pkg.publishConfig?.registry === registry && !Object.hasOwn(pkg.publishConfig, 'access'), 'publishConfig', 'Publish only to private GitHub Packages; do not set public access');
  return { schemaVersion: 1, ready: issues.length === 0, name: pkg.name, version: pkg.version, tag,
    npmTag: validVersion && pkg.version.includes('-') ? 'next' : 'latest', issues };
}

/** Reject links in either artifact directory; only this project's fixed release directory is used. */
async function outputDirectory(root, create = false) {
  for (const relative of ['.tmp', '.tmp/release']) {
    const target = path.join(root, relative);
    let entry;
    try { entry = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error(`Invalid release directory: ${relative}`);
    if (!entry && create) await mkdir(target);
  }
  return path.join(root, '.tmp/release');
}

const filenameFor = version => `devcodex-labs-flowkit-${version}.tgz`;
const members = () => ['package.json', 'README.md', 'LICENSE', ...packageFiles.map(([, output]) => output)].sort();
async function ready(root, tag) {
  const assessment = await assessRelease(root, tag);
  if (!assessment.ready) throw Object.assign(new Error('Release candidate is not ready'), { assessment });
  return assessment;
}

/** Parse verified in-memory gzip bytes without extracting paths or trusting a manifest's member claims. */
async function archiveContents(bytes, expected) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Release tarball exceeds the 4 MiB compressed limit');
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const actual = new Map(), seen = new Set(), invalid = [];
  await new Promise((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 65536 });
    parser.on('error', reject); parser.on('end', resolve);
    parser.on('ignoredEntry', entry => invalid.push(`Ignored tar member is not permitted: ${entry.path}`));
    parser.on('entry', entry => {
      const member = entry.path.startsWith('package/') ? entry.path.slice(8) : null;
      if (entry.type !== 'File' || !expected.has(member) || seen.has(member)) {
        invalid.push(`Unexpected, linked or duplicate tar member: ${entry.path}`); entry.resume(); return;
      }
      seen.add(member); const hash = createHash('sha256'); let size = 0;
      entry.on('error', reject); entry.on('data', chunk => { size += chunk.length; hash.update(chunk); });
      entry.on('end', () => actual.set(member, { sha256: hash.digest('hex'), size })); entry.resume();
    });
    parser.end(tar);
  });
  if (invalid.length || actual.size !== expected.size) throw new Error(invalid[0] ?? 'Release archive member set mismatch');
  for (const [member, source] of expected) {
    const content = actual.get(member);
    if (!content || content.sha256 !== source.sha256 || content.size !== source.size) throw new Error(`Release archive content mismatch: ${member}`);
  }
}

/** Verify a downloaded artifact against its manifest and the checked-out source, without rebuilding it. */
export async function verifyRelease(root, tag) {
  const assessment = await ready(root, tag);
  const directory = await outputDirectory(root);
  const manifest = await json(path.join(directory, 'release.json'));
  const filename = filenameFor(assessment.version);
  if (manifest.schemaVersion !== 1 || manifest.tag !== tag || manifest.version !== assessment.version ||
      manifest.name !== assessment.name || manifest.npmTag !== assessment.npmTag || manifest.filename !== filename ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Release manifest identity mismatch');
  const entries = (await readdir(directory)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([filename, 'release.json'].sort())) throw new Error('Unexpected release artifacts');
  for (const name of entries) { const entry = await lstat(path.join(directory, name)); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Linked or non-file release artifact'); }
  if ((await lstat(path.join(directory, filename))).size > 4 * 1024 * 1024) throw new Error('Release tarball exceeds the 4 MiB compressed limit');
  const bytes = await readFile(path.join(directory, filename));
  if (digest(bytes) !== manifest.sha256) throw new Error('Release tarball digest mismatch');
  if (!Array.isArray(manifest.files) || JSON.stringify(manifest.files.map(file => file.path).sort()) !== JSON.stringify(members())) throw new Error('Release file manifest mismatch');
  const sourceFor = new Map(packageFiles.map(([source, output]) => [output, source]));
  const expected = new Map();
  for (const item of manifest.files) {
    const source = sourceFor.get(item.path) ?? item.path;
    const original = await readFile(path.join(root, source));
    if (digest(original) !== item.sha256) throw new Error(`Release source changed: ${source}`);
    expected.set(item.path, { sha256: item.sha256, size: original.length });
  }
  await archiveContents(bytes, expected);
  return manifest;
}

/** Pack once, validate the actual pack list, and bind artifact bytes to their source files. Never publishes. */
export async function packRelease(root, tag, npm = process.env.npm_execpath) {
  const assessment = await ready(root, tag);
  if (typeof npm !== 'string' || !npm) throw new Error('Use npm run release:pack to select npm_execpath');
  const directory = await outputDirectory(root, true);
  if ((await readdir(directory)).length) return { ...await verifyRelease(root, tag), reused: true };
  const result = await runProcess(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory],
    { cwd: root, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || 'npm pack failed');
  const packed = JSON.parse(result.stdout);
  if (packed.length !== 1 || packed[0].filename !== filenameFor(assessment.version)) throw new Error('Unexpected packed artifact');
  const info = packed[0];
  await validatePackage(root, info.files.map(file => file.path));
  const files = [];
  for (const item of info.files) files.push({ path: item.path, sha256: digest(await readFile(path.join(root, item.path))) });
  const manifest = { schemaVersion: 1, name: assessment.name, version: assessment.version, tag, npmTag: assessment.npmTag,
    filename: info.filename, sha256: digest(await readFile(path.join(directory, info.filename))), files };
  await writeFile(path.join(directory, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
  return verifyRelease(root, tag);
}

/** CLI failures are JSON: unready candidate=1, invalid invocation or I/O/artifact failure=2. */
export async function main(args, root = fileURLToPath(new URL('../', import.meta.url))) {
  try {
    const [operation, flag, tag, ...extra] = args;
    if (!['check', 'pack', 'verify'].includes(operation) || flag !== '--tag' || !tag || extra.length) throw new TypeError('Expected check|pack|verify --tag vVERSION');
    if (operation === 'check') { const result = await assessRelease(root, tag); console.log(JSON.stringify(result)); return result.ready ? 0 : 1; }
    const result = operation === 'pack' ? await packRelease(root, tag) : await verifyRelease(root, tag);
    console.log(JSON.stringify({ passed: true, ...result })); return 0;
  } catch (error) {
    console.log(JSON.stringify(error.assessment ?? { passed: false, error: error.message })); return error.assessment ? 1 : 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
