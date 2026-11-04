import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments } from '../../src/cli/arguments.mjs';

test('CLI accepts only compile/check and leaves absent options absent', () => {
  for (const command of ['compile', 'check']) assert.deepEqual(parseArguments([command, 'a.workflow.ts']), { command, file: 'a.workflow.ts', options: {} });
  for (const command of [undefined, 'run', 'mermaid', '--help', 'version']) assert.throws(() => parseArguments(command === undefined ? [] : [command, 'a.workflow.js']), TypeError);
});

test('CLI parses the six option families and preserves repeated host order', () => {
  const parsed = parseArguments(['compile', 'a.workflow.js', '--out-dir', 'out', '--skills-root=https://example.test/skills', '--trace', '--no-mermaid', '--no-skill-check', '--remote-skill-host', 'b.test', '--remote-skill-host=a.test']);
  assert.deepEqual(parsed.options, { outDir: 'out', skillsRoot: 'https://example.test/skills', trace: true, mermaid: false, skillCheck: false, remoteSkillHosts: ['b.test', 'a.test'] });
});

test('explicit boolean values and last occurrence survive without truthy merging', () => {
  assert.deepEqual(parseArguments(['check', '--mermaid', 'a.workflow.js', '--no-mermaid']).options, { mermaid: false });
  assert.deepEqual(parseArguments(['compile', 'a.workflow.js', '--no-mermaid', '--mermaid']).options, { mermaid: true });
});

test('unknown flags, missing values and boolean assignments reject', () => {
  for (const argument of ['--unknown', '--no-trace', '--skill-check', '--project-root', '-x', '--trace=true', '--no-mermaid=false']) assert.throws(() => parseArguments(['check', 'a.workflow.js', argument]), TypeError);
  for (const option of ['--out-dir', '--skills-root', '--remote-skill-host']) {
    for (const rest of [[option], [option, '--trace'], [option + '='], [option, '']]) assert.throws(() => parseArguments(['check', 'a.workflow.js', ...rest]), TypeError);
  }
});

test('exactly one supported source positional is required and -- terminates options', () => {
  for (const files of [[], ['a.js'], ['a.compiled.mjs'], ['a.workflow.js', 'b.workflow.js']]) assert.throws(() => parseArguments(['check', ...files]), TypeError);
  assert.equal(parseArguments(['check', '--', '-a.workflow.js']).file, '-a.workflow.js');
  assert.throws(() => parseArguments(['check', '--', 'a.workflow.js', '--trace']), TypeError);
  assert.throws(() => parseArguments(['check', null]), TypeError);
});
