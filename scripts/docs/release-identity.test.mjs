import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateRecord, validateSourceMetadata, validateRepairPaths, validateDocsCommit } from './release-identity.mjs';
import { sha256, verifyRegistryBytes } from './package-proof.mjs';
function fixture() {
  const input = { repository: 'devcodex-labs/flowkit', packageReleaseCommit: 'a'.repeat(40), docsCommit: 'a'.repeat(40), version: '1.0.0', releaseRunId: '100', releaseRunAttempt: '2' };
  const tarball = Buffer.from('reviewed bytes'), manifest = Buffer.from(JSON.stringify({ name: '@devcodex-labs/flowkit', version: '1.0.0', tag: 'v1.0.0', sha256: sha256(tarball) }));
  const artifact = (name, id) => ({ id, name: `${name}-2`, expired: false, expires_at: new Date(Date.now() + 86400000).toISOString(), digest: `sha256:${'b'.repeat(64)}`, workflow_run: { id: 100, head_sha: input.packageReleaseCommit } });
  const metadata = { run: { id: 100, run_attempt: 2, repository: { full_name: input.repository }, head_repository: { full_name: input.repository }, path: '.github/workflows/publish.yml', event: 'push', head_branch: 'v1.0.0', head_sha: input.packageReleaseCommit, conclusion: null }, jobs: ['pack', 'publish'].map(name => ({ name, conclusion: 'success', run_id: 100, head_sha: input.packageReleaseCommit })), artifacts: [artifact('npm-release', 1), artifact('release-identity', 2)] };
  const record = { schemaVersion: 'FlowkitReleaseIdentityV1', ...input, workflow: metadata.run.path, tag: 'v1.0.0', npmArtifactId: '1', npmArtifactDigest: metadata.artifacts[0].digest, manifestSha256: sha256(manifest), tarballSha256: sha256(tarball) };
  return { input, metadata, record, manifest, tarball };
}
test('automatic in-progress release and manual docs-failed retry use completed package jobs', () => {
  const f = fixture(); validateRecord(f.input, f.metadata, f.record, f.manifest, f.tarball);
  f.metadata.run.conclusion = 'failure'; validateRecord(f.input, f.metadata, f.record, f.manifest, f.tarball);
});
test('wrong run, attempt, commit, repository, job and expired artifacts are rejected', () => {
  for (const mutate of [f => f.metadata.run.id++, f => f.metadata.run.run_attempt++, f => f.metadata.run.head_sha = 'c'.repeat(40), f => f.metadata.run.repository.full_name = 'other/repo', f => f.metadata.run.path = '.github/workflows/docs.yml', f => f.metadata.jobs[1].conclusion = 'failure', f => f.metadata.artifacts[0].expired = true, f => f.metadata.artifacts[0].expires_at = '2000-01-01', f => f.metadata.artifacts.pop()]) {
    const f = fixture(); mutate(f); assert.throws(() => validateSourceMetadata(f.input, f.metadata));
  }
});
test('manifest, artifact identity and package bytes cannot be replaced', () => {
  for (const mutate of [f => f.manifest = Buffer.from('{}'), f => f.tarball = Buffer.from('replacement'), f => f.record.npmArtifactId = '99', f => f.record.npmArtifactDigest = `sha256:${'f'.repeat(64)}`]) {
    const f = fixture(); mutate(f); assert.throws(() => validateRecord(f.input, f.metadata, f.record, f.manifest, f.tarball));
  }
});
test('registry bytes bind candidate sha and npm integrity', () => {
  const f = fixture(), manifest = JSON.parse(f.manifest), metadata = { name: manifest.name, version: manifest.version, dist: { integrity: `sha512-${createHash('sha512').update(f.tarball).digest('base64')}` } };
  verifyRegistryBytes(f.tarball, metadata, manifest);
  assert.throws(() => verifyRegistryBytes(Buffer.from('changed'), metadata, manifest));
  assert.throws(() => verifyRegistryBytes(f.tarball, { ...metadata, dist: { integrity: 'invalid' } }, manifest));
});
test('documentation repair whitelist rejects package files and build sources', () => {
  validateRepairPaths(['website/content/index.mdx', 'examples/docs/aot/host.mjs', 'scripts/docs/release-identity.mjs', '.github/workflows/docs.yml']);
  for (const file of ['README.md', 'package.json', 'package-lock.json', 'LICENSE', 'src/index.mjs', 'types/index.d.ts', 'scripts/build.mjs', '.github/workflows/publish.yml']) assert.throws(() => validateRepairPaths([file]));
});
test('real temporary Git history accepts docs descendant and rejects package repair', async () => {
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base, 'flowkit-docs-git-'));
  const git = (...args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    git('init', '--quiet'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    await writeFile(path.join(root, 'package.json'), '{}'); git('add', '.'); git('commit', '--quiet', '-m', 'package'); const original = git('rev-parse', 'HEAD'); git('tag', 'v1.0.0');
    const f = fixture(); f.input.packageReleaseCommit = original; f.input.docsCommit = original; assert.deepEqual(await validateDocsCommit(root, f.input), []);
    await mkdir(path.join(root, 'website')); await writeFile(path.join(root, 'website/index.mdx'), '# 文档'); git('add', '.'); git('commit', '--quiet', '-m', 'docs repair'); f.input.docsCommit = git('rev-parse', 'HEAD');
    assert.deepEqual(await validateDocsCommit(root, f.input), ['website/index.mdx']);
    await writeFile(path.join(root, 'package.json'), '{"changed":true}'); git('add', '.'); git('commit', '--quiet', '-m', 'invalid package repair'); f.input.docsCommit = git('rev-parse', 'HEAD');
    await assert.rejects(validateDocsCommit(root, f.input), /unauthorized path/);
  } finally { assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('flowkit-docs-git-')); await rm(root, { recursive: true, force: true }); }
});
