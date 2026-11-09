import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedReadme } from '../../scripts/docs/sync-readme.mjs';
const website = fileURLToPath(new URL('../', import.meta.url));
const root = path.dirname(website);
export function checkCoverage(pages) {
  assert.ok(pages.length > 0, 'No documented pages');
  assert.deepEqual(pages.map(page => page.id), Array.from({ length: pages.length }, (_, index) => `P${String(index + 1).padStart(2, '0')}`));
  for (const field of ['route', 'file']) assert.equal(new Set(pages.map(page => page[field])).size, pages.length, `Duplicate ${field}`);
  for (const page of pages) assert.ok(page.title && page.scope && page.validation, `Missing page responsibility: ${page.id}`);
}
export function assertNoPrivateContent(text, name) { assert.ok(!/\.devcodex|\.task-lifecycle|TL-\d{8}-\d+|[\uFFFD]/.test(text), `Private or corrupt content: ${name}`); }
export function assertAnchors(body, names, label) {
  const actual = [...body.matchAll(/<a id="([^"]+)"><\/a>|\{#([^}]+)\}/g)].map(match => match[1] ?? match[2]);
  for (const name of names) assert.equal(actual.filter(value => value === name).length, 1, `Missing/duplicate ${label} ${name}`);
}
export function assertVersion(pkg) { assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/); assert.equal(pkg.name, '@devcodex-labs/flowkit'); assert.equal(pkg.license, 'SEE LICENSE IN LICENSE'); assert.equal(pkg.private, false); assert.equal(pkg.publishConfig?.registry, 'https://npm.pkg.github.com/'); }
export function phaseLimit(args) {
  if (!args.length) return Number.POSITIVE_INFINITY;
  assert.equal(args.length, 2); assert.equal(args[0], '--phase');
  assert.ok(['B1', 'B2'].includes(args[1]) && !process.env.CI, 'Partial checks are local only');
  return args[1] === 'B1' ? 4 : 31;
}
export async function checkContent(args = []) {
  const limit = phaseLimit(args);
  const pages = JSON.parse(await readFile(path.join(website, 'coverage.json'), 'utf8')); checkCoverage(pages);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assertVersion(pkg);
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.equal(readme, await expectedReadme(readme), 'Run npm run docs:sync'); assertNoPrivateContent(readme, 'README');
  const bodies = new Map();
  for (const page of pages.slice(0, limit)) {
    const filename = path.join(website, 'content', page.file);
    const text = await readFile(filename, 'utf8'); bodies.set(page.id, text); assertNoPrivateContent(text, page.file);
    assert.ok(page.status !== 'planned', `${page.id} remains planned`);
    assert.ok(page.id === 'P01' || text.includes(`# ${page.title}`), `Missing title: ${page.file}`);
    for (const match of text.matchAll(/```\w+\s+file="([^"]+)"/g)) await access(path.resolve(path.dirname(filename), match[1]));
  }
  if (limit === Number.POSITIVE_INFINITY) {
    const changelog = (await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'))
      .replace(/^# 更新记录\r?\n/, '# v1.0.0 发布记录\n')
      .replace('(LICENSE)', '(https://github.com/devcodex-labs/flowkit/blob/main/LICENSE)');
    assert.ok(bodies.get('P44').replace(/\r\n/g, '\n').includes(changelog.replace(/\r\n/g, '\n').trim()), 'P44 release body must match CHANGELOG.md');
    const { PUBLIC_FUNCTIONS, DSL_FIELDS, OPTION_KEYS, ERROR_CATALOG } = await import('../../src/shared/contracts.mjs');
    assertAnchors(bodies.get('P27'), PUBLIC_FUNCTIONS, 'SDK');
    assertAnchors(bodies.get('P29'), OPTION_KEYS, 'option');
    for (const file of ['index.d.ts', 'dsl.d.ts']) {
      const declaration = await readFile(path.join(root, 'types', file), 'utf8');
      for (const match of declaration.matchAll(/export (?:interface|type) (\w+)/g)) assert.ok(bodies.get('P31').includes(match[1]), `Missing public type ${match[1]}`);
    }
    for (const method of ['runAgent', 'validateResult', 'checkStep', 'runHuman', 'runVerification', 'runAction', 'loadSkill', 'loadSkillByAgent', 'evalWhen', 'isControlSignal', 'trace.start', 'trace.end']) assert.ok(bodies.get('P28').includes(method), `Missing Runtime ${method}`);
    for (const [index, [name, fields]] of Object.entries(DSL_FIELDS).entries()) for (const field of fields) assert.ok(bodies.get(`P${18 + index}`).includes(`\`${field}\``), `Missing ${name}.${field}`);
    for (const [code, item] of Object.entries(ERROR_CATALOG)) {
      const body = bodies.get(code.startsWith('FK_C') ? 'P40' : 'P41');
      assertAnchors(body, [code], 'diagnostic');
      const section = body.split(`{#${code}}`)[1]?.split(/\{#FK_[CR]\d+\}/)[0];
      assert.ok(section, `Diagnostic must use a searchable heading: ${code}`);
      assert.ok(section.includes(item.severity), `Severity missing ${code}`);
      if (item.reserved) assert.ok(section.includes('预留') && section.includes('不抛'), 'Reserved code misrepresented');
      else for (const label of ['触发', '修复', '复验']) assert.ok(section.includes(label), `${code} lacks ${label}`);
      if (code.startsWith('FK_C')) {
        const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/errors', `${code}.json`), 'utf8'));
        for (const variant of ['invalid', 'valid']) if (fixture[variant].source) assert.ok(section.includes(fixture[variant].source.trim()), `${code} ${variant} example drifted from executable fixture`);
      }
    }
  }
  return { pages: pages.slice(0, limit).length, full: limit === Number.POSITIVE_INFINITY, passed: true };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkContent(process.argv.slice(2))));
