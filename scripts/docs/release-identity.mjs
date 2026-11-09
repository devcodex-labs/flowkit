import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess } from '../validation-process.mjs';
import { sha256 } from './package-proof.mjs';
export const repository = 'devcodex-labs/flowkit';
const workflow = '.github/workflows/publish.yml';
export function validateInputs(input) {
  assert.equal(input.repository, repository); assert.match(String(input.version), /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
  for (const key of ['packageReleaseCommit', 'docsCommit']) assert.match(input[key], /^[0-9a-f]{40}$/, key);
  for (const key of ['releaseRunId', 'releaseRunAttempt']) assert.match(String(input[key]), /^[1-9]\d*$/, key);
}
export function validateSourceMetadata(input, metadata) {
  validateInputs(input); const { run, jobs, artifacts } = metadata;
  assert.equal(String(run.id), String(input.releaseRunId)); assert.equal(String(run.run_attempt), String(input.releaseRunAttempt));
  assert.equal(run.repository?.full_name, repository); assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, workflow); assert.equal(run.event, 'push'); assert.equal(run.head_branch, `v${input.version}`); assert.equal(run.head_sha, input.packageReleaseCommit);
  for (const name of ['pack', 'publish']) {
    const matches = jobs.filter(job => job.name === name); assert.equal(matches.length, 1, `Expected one ${name} job`);
    assert.equal(matches[0].conclusion, 'success', `${name} must succeed`); assert.equal(String(matches[0].run_id), String(input.releaseRunId));
    assert.equal(matches[0].head_sha, input.packageReleaseCommit);
  }
  const selected = {};
  for (const prefix of ['npm-release', 'release-identity']) {
    const matches = artifacts.filter(item => item.name === `${prefix}-${input.releaseRunAttempt}`); assert.equal(matches.length, 1, `Missing or ambiguous ${prefix} artifact`);
    const artifact = matches[0]; assert.equal(artifact.expired, false, 'Expired artifact'); assert.ok(Date.parse(artifact.expires_at) > Date.now(), 'Artifact no longer available');
    assert.equal(String(artifact.workflow_run?.id), String(input.releaseRunId)); assert.equal(artifact.workflow_run?.head_sha, input.packageReleaseCommit);
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/); selected[prefix] = artifact;
  } return selected;
}
export function validateRecord(input, metadata, record, manifestBytes, tarballBytes) {
  const selected = validateSourceMetadata(input, metadata), manifest = JSON.parse(manifestBytes);
  assert.equal(record.schemaVersion, 'FlowkitReleaseIdentityV1');
  for (const key of ['repository', 'packageReleaseCommit', 'version']) assert.equal(record[key], input[key]);
  for (const key of ['releaseRunId', 'releaseRunAttempt']) assert.equal(String(record[key]), String(input[key]));
  assert.equal(record.workflow, workflow); assert.equal(record.tag, `v${input.version}`);
  const artifact = selected['npm-release']; assert.equal(String(record.npmArtifactId), String(artifact.id)); assert.equal(record.npmArtifactDigest, artifact.digest);
  assert.equal(record.manifestSha256, sha256(manifestBytes)); assert.equal(record.tarballSha256, sha256(tarballBytes));
  assert.equal(manifest.sha256, record.tarballSha256); assert.equal(manifest.version, input.version); assert.equal(manifest.tag, record.tag); assert.equal(manifest.name, '@devcodex-labs/flowkit');
  return selected;
}
export function validateRepairPaths(files) {
  for (const file of files) assert.ok(/^(website\/|docs\/|examples\/docs\/|scripts\/docs\/)/.test(file) || file === '.github/workflows/docs.yml', `Repair changes package or unauthorized path: ${file}`);
}
async function git(root, args) {
  const result = await runProcess('git', ['-C', root, ...args], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error; assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`); return result.stdout.trim();
}
export async function validateDocsCommit(root, input) {
  validateInputs(input); assert.equal(await git(root, ['rev-parse', 'HEAD']), input.docsCommit);
  assert.equal(await git(root, ['rev-parse', `v${input.version}^{commit}`]), input.packageReleaseCommit, 'Tag no longer identifies original package');
  await git(root, ['merge-base', '--is-ancestor', input.packageReleaseCommit, input.docsCommit]);
  const changed = (await git(root, ['diff', '--name-only', '--no-renames', '-z', input.packageReleaseCommit, input.docsCommit])).split('\0').filter(Boolean);
  validateRepairPaths(changed); return changed;
}
async function api(url) {
  assert.ok(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN required');
  const response = await fetch(`https://api.github.com/repos/${repository}/${url}`, { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `GitHub API ${response.status}: ${url}`); return response.json();
}
export async function main(args) {
  const [operation, ...rest] = args, flags = {};
  for (let i = 0; i < rest.length; i += 2) { assert.ok(rest[i].startsWith('--') && rest[i + 1] && !flags[rest[i]]); flags[rest[i]] = rest[i + 1]; }
  const input = { repository: process.env.GITHUB_REPOSITORY, packageReleaseCommit: process.env.PACKAGE_COMMIT, docsCommit: process.env.DOCS_COMMIT, version: process.env.RELEASE_VERSION, releaseRunId: process.env.RELEASE_RUN_ID, releaseRunAttempt: process.env.RELEASE_RUN_ATTEMPT };
  validateInputs(input);
  if (operation === 'create') {
    const bytes = await readFile(path.join(flags['--release-dir'], 'release.json')), manifest = JSON.parse(bytes);
    assert.equal(input.docsCommit, input.packageReleaseCommit); assert.equal(manifest.version, input.version); assert.equal(manifest.tag, `v${input.version}`);
    const tarball = await readFile(path.join(flags['--release-dir'], manifest.filename)); assert.equal(sha256(tarball), manifest.sha256);
    const digest = process.env.NPM_ARTIFACT_DIGEST ?? '';
    const record = { schemaVersion: 'FlowkitReleaseIdentityV1', ...input, workflow, tag: manifest.tag, npmArtifactId: process.env.NPM_ARTIFACT_ID, npmArtifactDigest: digest.startsWith('sha256:') ? digest : `sha256:${digest}`, manifestSha256: sha256(bytes), tarballSha256: sha256(tarball) };
    assert.match(String(record.npmArtifactId), /^[1-9]\d*$/); assert.match(record.npmArtifactDigest, /^sha256:[a-f0-9]{64}$/);
    await mkdir(path.dirname(flags['--out']), { recursive: true }); await writeFile(flags['--out'], JSON.stringify(record, null, 2) + '\n');
  } else if (operation === 'metadata') {
    const run = await api(`actions/runs/${input.releaseRunId}/attempts/${input.releaseRunAttempt}`), jobs = [], artifacts = [];
    for (let page = 1; ; page++) { const r = await api(`actions/runs/${input.releaseRunId}/attempts/${input.releaseRunAttempt}/jobs?per_page=100&page=${page}`); jobs.push(...r.jobs); if (r.jobs.length < 100) break; }
    for (let page = 1; ; page++) { const r = await api(`actions/runs/${input.releaseRunId}/artifacts?per_page=100&page=${page}`); artifacts.push(...r.artifacts); if (r.artifacts.length < 100) break; }
    const metadata = { run, jobs, artifacts }, selected = validateSourceMetadata(input, metadata);
    await mkdir(path.dirname(flags['--out']), { recursive: true }); await writeFile(flags['--out'], JSON.stringify(metadata, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `npm_id=${selected['npm-release'].id}\nidentity_id=${selected['release-identity'].id}\n`);
  } else if (operation === 'verify') {
    const metadata = JSON.parse(await readFile(flags['--metadata'], 'utf8')), record = JSON.parse(await readFile(flags['--record'], 'utf8'));
    const bytes = await readFile(path.join(flags['--release-dir'], 'release.json')), manifest = JSON.parse(bytes);
    assert.equal(manifest.filename, `devcodex-labs-flowkit-${input.version}.tgz`);
    validateRecord(input, metadata, record, bytes, await readFile(path.join(flags['--release-dir'], manifest.filename)));
    const changed = await validateDocsCommit(flags['--docs-root'], input);
    const result = { passed: true, ...input, changed, manifestSha256: sha256(bytes), tarballSha256: manifest.sha256 };
    if (flags['--out']) { await mkdir(path.dirname(flags['--out']), { recursive: true }); await writeFile(flags['--out'], JSON.stringify(result, null, 2) + '\n'); }
    console.log(JSON.stringify(result));
  } else throw new Error('Expected create, metadata or verify');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
