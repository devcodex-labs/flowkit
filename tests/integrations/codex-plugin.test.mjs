import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildCodexMarketplace } from '../../scripts/build-codex-plugin.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';

const dsl = (action, version) => `import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'inspect-input', name: 'Inspect input', version: '${version}', nodes: [
  action('inspect', { name: 'Inspect input', action: '${action}', next: 'done' }),
  terminal('done', { name: 'Done', status: 'succeeded' })
] });
`;

test('built Codex package reviews the exact FlowKit candidate and exports an independent workflow', async t => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'flowkit-codex-test-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), parent);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true, force: true });
  });
  const { marketplace, plugin } = await buildCodexMarketplace(root);
  const entry = JSON.parse(await readFile(path.join(marketplace, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(path.resolve(marketplace, entry.plugins[0].source.path), plugin);
  const portable = JSON.parse(await readFile(path.join(plugin, 'plugin.json'), 'utf8'));
  const legacy = JSON.parse(await readFile(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(portable.name, legacy.name);
  assert.equal(portable.version, legacy.version);
  assert.match(await readFile(path.join(plugin, 'skills/flowkit-author/SKILL.md'), 'utf8'), /name: flowkit-author/);
  assert.match(await readFile(path.join(plugin, 'skills/flowkit-author/references/dsl.md'), 'utf8'), /defineWorkflow/);
  assert.equal((await readdir(plugin)).includes('node_modules'), false);

  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const script = path.join(plugin, 'skills/flowkit-author/scripts/workflow.mjs');
  function call(args, expected = 0) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: workspace, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return { stdout: result.stdout && JSON.parse(result.stdout), stderr: result.stderr };
  }
  const draft = path.join(workspace, 'draft.workflow.js');
  const metaFile = path.join(workspace, 'metadata.json');
  const metadata = { name: 'inspect-input', description: 'Inspect an input', version: '1.0.0' };
  await writeFile(metaFile, JSON.stringify(metadata));

  await writeFile(draft, 'throw new Error("A draft must never execute");');
  const invalid = call(['prepare', draft, metaFile, 'invalid.json'], 1);
  assert.ok(invalid.stdout.diagnostics.some(item => item.severity === 'error'));
  assert.ok(!(await readdir(workspace)).includes('invalid.json'));

  await writeFile(draft, dsl('inspect-input', metadata.version));
  const original = call(['prepare', draft, metaFile, 'original.json']).stdout;
  const review = call(['review', 'original.json']).stdout;
  assert.equal(review.candidateHash, original.candidateHash);
  assert.deepEqual(review.compilerEvidence.declaredNodeIds, ['inspect', 'done']);
  assert.deepEqual(review.compilerEvidence.declaredTerminalIds, ['done']);

  const delivered = call(['export', 'original.json', review.candidateHash, 'delivered']).stdout;
  assert.deepEqual((await readdir(delivered.directory)).sort(), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  const candidate = JSON.parse(await readFile(path.join(workspace, 'original.json'), 'utf8'));
  for (const filename of delivered.files) {
    assert.equal(await readFile(path.join(delivered.directory, filename), 'utf8'), candidate.files[filename]);
  }
  assert.equal(delivered.artifactHash, artifactDigest(await readFile(path.join(delivered.directory, 'workflow.js'))));
  assert.match(call(['export', 'original.json', review.candidateHash, 'delivered'], 1).stderr, /EEXIST/);

  const version = '1.0.1';
  await writeFile(draft, dsl('inspect-again', version));
  await writeFile(metaFile, JSON.stringify({ ...metadata, version, includeSource: true }));
  call(['prepare', draft, metaFile, 'original.json'], 1);
  call(['prepare', draft, metaFile, 'updated.json']);
  const updated = call(['review', 'updated.json', 'original.json']).stdout;
  assert.equal(updated.previousHash, review.candidateHash);
  assert.equal(updated.semantics.nodes.find(item => item.nodeId === 'inspect').after.action, 'inspect-again');
  assert.match(call(['export', 'updated.json', review.candidateHash, 'stale'], 1).stderr, /Candidate changed/);
  const revised = call(['export', 'updated.json', updated.candidateHash, 'revised']).stdout;
  assert.equal(await readFile(path.join(revised.directory, 'source/workflow.dsl.js'), 'utf8'), dsl('inspect-again', version));
  const tampered = { ...candidate, files: { ...candidate.files, 'workflow.js': candidate.files['workflow.js'] + '\n' } };
  await writeFile(path.join(workspace, 'tampered.json'), JSON.stringify(tampered));
  assert.match(call(['export', 'tampered.json', review.candidateHash, 'tampered'], 1).stderr, /candidate bytes or manifest differ/);
  assert.ok(!(await readdir(workspace)).some(name => name === 'stale' || name === 'tampered'));

  const host = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const { workflow } = await import('./workflow.js');
    const seen = [];
    const result = await workflow({ state: {}, runId: 'independent-host',
      runtime: { isControlSignal: () => false, runAction: async id => { seen.push(id); } } });
    assert.equal(result.terminal, 'done');
    assert.deepEqual(seen, ['inspect-input']);
  `], { cwd: delivered.directory, encoding: 'utf8', timeout: 15000 });
  assert.ifError(host.error);
  assert.equal(host.status, 0, host.stderr);
});
