import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeSource, analyzeFile } from '../../src/compiler/analyze.mjs';
import { validIntegrity } from '../../src/compiler/skill-check.mjs';

function source(fields) {
  const entries = Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(',');
  return `import {defineWorkflow,node,terminal} from '@devcodex/flowkit/dsl';\nexport default defineWorkflow({id:'demo',version:'1.0.0',name:'Demo',nodes:[node('n',{name:'N',output:{type:'object'},next:'done',${entries}}),terminal('done',{name:'Done',status:'succeeded'})]});`;
}
const analyze = (fields, options = {}) => analyzeSource(source(fields), {
  filename: 'demo.workflow.js', skillCheck: false, ...options,
  fetch() { assert.fail('Static checks must never fetch'); },
});
const codes = async (fields, options) => (await analyze(fields, options)).diagnostics.map(d => d.code);
const digest = (algorithm = 'sha256', length = 32) => `${algorithm}-${Buffer.alloc(length, 1).toString('base64')}`;

test('checks local existence, explicit precedence, roots and raw file hashes without reading Skill content', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowkit-front-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'skills'));
  await writeFile(path.join(root, 'skills/writer.md'), Buffer.from([0xff]));
  await writeFile(path.join(root, 'package.json'), '{invalid json is not parsed');
  await mkdir(path.join(root, 'nested'));
  const filename = path.join(root, 'nested/demo.workflow.js');
  const text = source({ agent: 'writer' });
  await writeFile(filename, text);
  const fileResult = await analyzeFile(filename);
  assert.equal(fileResult.context.projectRoot, root);
  assert.deepEqual(fileResult.diagnostics, []);
  assert.equal(fileResult.snapshot.sourceText, text);
  assert.deepEqual(await codes({ skill: 'skills/missing.md' }, { projectRoot: root, skillCheck: true }), ['FK_C051']);
  assert.deepEqual(await codes({ skill: 'skills/missing.md' }, { projectRoot: root }), []);
  assert.deepEqual(await codes({ agent: '../ignored', skill: 'skills/writer.md' }, { projectRoot: root, skillCheck: true }), []);
  assert.deepEqual(await codes({ agent: 'writer' }, { projectRoot: root, skillsRoot: path.join(root, 'skills'), skillCheck: true }), []);
  assert.deepEqual(await codes({ skill: 'skills' }, { projectRoot: root, skillCheck: true }), ['FK_C052']);
  await assert.rejects(analyzeFile(path.join(root, 'missing.workflow.js')), { code: 'ENOENT' });
  await assert.rejects(analyzeFile(filename, { filename }), TypeError);
  await assert.rejects(analyzeFile(filename, Object.defineProperty({}, 'unknown', { value: true })), TypeError);
  const ownOptions = Object.defineProperty({}, 'skillCheck', { value: false });
  assert.deepEqual((await analyzeFile(filename, ownOptions)).diagnostics, []);
  const inheritedOptions = Object.assign(Object.create({ filename, trace: 'bad' }), { skillCheck: false });
  await assert.rejects(analyzeSource(text, inheritedOptions), TypeError);
  // A directory named package.json is not a package boundary.
  await mkdir(path.join(root, 'nested/package.json'));
  assert.equal((await analyzeFile(filename)).context.projectRoot, root);
});

test('rejects raw local path violations before normalization on every platform', async () => {
  for (const skill of ['', '/x.md', '../x.md', 'skills/../x.md', './x.md', 'skills//x.md', 'skills\\x.md',
    'C:/x.md', 'C:\\x.md', '//host/x.md', 'skills/中.md', 'skills/a%2e.md', 'skills/x.txt', 'skills/x.md?',
    'skills\n/x.md', 'skills/x.md#', 'skills/./x.md']) {
    assert.ok((await codes({ skill })).includes('FK_C052'), skill);
  }
  for (const skill of ['skills/a_b-c.1.md', 'x.md']) assert.deepEqual(await codes({ skill }), []);
  assert.deepEqual(await codes({ agent: '../writer' }), ['FK_C052']);
  assert.ok((await codes({ agent: 'writer', skill: '' })).includes('FK_C052'));
});

test('requires exact remote hosts and ports without network requests', async () => {
  assert.deepEqual(await codes({ skill: 'https://example.test/a.md' }), ['FK_C057', 'FK_C059']);
  for (const skill of ['https://example.test/a.md', 'https://example.test:443/a.md', 'HTTPS://example.test/a.md', 'Https://example.test/a.md']) {
    assert.deepEqual(await codes({ skill, integrity: digest() }, { remoteSkillHosts: ['example.test'] }), []);
  }
  assert.deepEqual(await codes({ skill: 'https://example.test/a.md', integrity: digest() }, { remoteSkillHosts: ['example.test:443'] }), []);
  assert.deepEqual(await codes({ agent: 'writer' }, { skillsRoot: 'HTTPS://example.test/skills', remoteSkillHosts: ['example.test'] }), ['FK_C059']);
  assert.deepEqual(await codes({ skill: 'https://example.test:444/a.md', integrity: digest() }, { remoteSkillHosts: ['example.test'] }), ['FK_C057']);
  assert.deepEqual(await codes({ skill: 'https://example.test:444/a.md', integrity: digest() }, { remoteSkillHosts: ['example.test:444'] }), []);
  for (const host of ['sub.example.test', 'example.test.evil']) {
    assert.deepEqual(await codes({ skill: `https://${host}/a.md`, integrity: digest() }, { remoteSkillHosts: ['example.test'] }), ['FK_C057']);
  }
  assert.deepEqual(await codes({ agent: 'writer' }, { skillsRoot: 'https://example.test/skills', remoteSkillHosts: ['example.test'] }), ['FK_C059']);
  assert.deepEqual(await codes({ agent: 'writer', integrity: digest() }, { skillsRoot: 'https://example.test/skills', remoteSkillHosts: ['example.test'] }), ['FK_C058']);
});

test('rejects raw URL traversal, credentials, queries, fragments and non-HTTPS references', async () => {
  for (const skill of ['http://example.test/a.md', 'https://user:pass@example.test/a.md', 'https://example.test/a.md?',
    'https://example.test/a.md#', 'https://example.test/x/../a.md', 'https://example.test/./a.md',
    'https://example.test/%2e%2e/a.md', 'https://example.test/a%2Fz.md', 'https://example.test/x\\a.md',
    'https://example.test//a.md', 'https://example.test/a.md\n', 'https://example.test/a.txt']) {
    assert.ok((await codes({ skill }, { remoteSkillHosts: ['example.test'] })).includes('FK_C052'), skill);
  }
  assert.ok((await codes({ agent: 'writer' }, { skillsRoot: 'https://example.test/x/../skills', remoteSkillHosts: ['example.test'] })).includes('FK_C052'));
});

test('validates SRI algorithms, digest lengths, exact padding and use location', async () => {
  for (const [algorithm, length] of [['sha256',32], ['sha384',48], ['sha512',64]]) {
    for (const integrity of [digest(algorithm,length), digest(algorithm,length).replace(/=+$/, '')]) {
      assert.equal(validIntegrity(integrity), true, integrity);
      assert.deepEqual(await codes({ skill: 'https://example.test/a.md', integrity }, { remoteSkillHosts: ['example.test'] }), []);
    }
  }
  const sha256 = digest();
  for (const integrity of [null, 7, '', 'sha1-YQ==', digest('sha256',31), digest('sha512',32), sha256+'=',
    sha256+'\n', sha256+' '+sha256, 'sha256-'+Buffer.alloc(32).toString('base64').replace(/A=$/, 'B='),
    'sha256-A=AA', sha256.replace('sha256-', 'sha256-_')]) {
    assert.equal(validIntegrity(integrity), false, String(integrity));
    assert.ok((await codes({ skill: 'https://example.test/a.md', integrity }, { remoteSkillHosts: ['example.test'] })).includes('FK_C058'));
  }
  assert.deepEqual(await codes({ skill: 'skills/writer.md', integrity: sha256 }), ['FK_C058']);
  assert.deepEqual(await codes({ agent: 'writer', integrity: sha256 }), ['FK_C058']);
});
