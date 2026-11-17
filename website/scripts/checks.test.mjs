import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pageFile, publicUrl } from './routes.mjs';
import { checkLink, inspectHTML, assertSitemap } from './check-rendered.mjs';
import { checkCoverage, assertNoPrivateContent, assertAnchors, assertVersion, exportedNames } from './check-content.mjs';
import { onSearch } from '../search-hooks.mjs';
import { alignSearchHeadingBoundaries } from '../search-index.mjs';
import { flowkitProvider } from '../../src/integrations/capability-graph.mjs';
import { readPinnedDocument, validateCapabilityDocuments, validateDocumentCatalog, validateDocumentReferences } from '../../scripts/docs/check-capability-documents.mjs';

test('document inventory rejects duplicate identity, missing pages and version drift', async () => {
  const catalog = JSON.parse(await readFile(new URL('../docs-catalog.json', import.meta.url), 'utf8'));
  const pages = JSON.parse(await readFile(new URL('../coverage.json', import.meta.url), 'utf8'));
  const files = catalog.documents.map(entry => entry.path);
  assert.equal(validateDocumentCatalog(catalog, pages, files, '1.0.0').size, files.length);
  assert.throws(() => validateDocumentCatalog(catalog, pages, files, '2.0.0'), /target does not match/);
  const duplicate = structuredClone(catalog);
  duplicate.documents[1].id = duplicate.documents[0].id;
  assert.throws(() => validateDocumentCatalog(duplicate, pages, files, '1.0.0'), /Duplicate document ID/);
  const incomplete = structuredClone(catalog);
  incomplete.documents.pop();
  assert.throws(() => validateDocumentCatalog(incomplete, pages, files, '1.0.0'), /inventory does not match/);
});

test('Provider document mappings reject missing, duplicate and unpinned references', async () => {
  const catalog = JSON.parse(await readFile(new URL('../docs-catalog.json', import.meta.url), 'utf8'));
  const byId = new Map(catalog.documents.map(entry => [entry.id, entry]));
  assert(validateCapabilityDocuments(flowkitProvider, byId).size > 0);
  const wrong = structuredClone(flowkitProvider);
  const first = wrong.capabilities[0].documents[0];
  first.id = 'unknown';
  assert.throws(() => validateCapabilityDocuments(wrong, byId), /Unknown or unanchored/);
  first.id = flowkitProvider.capabilities[0].documents[0].id;
  wrong.capabilities[0].documents.push(first);
  assert.throws(() => validateCapabilityDocuments(wrong, byId), /Duplicate document reference/);
  wrong.capabilities[0].documents.pop();
  first.source.url = first.source.url.replace(/[a-f0-9]{40}/, 'main');
  assert.throws(() => validateCapabilityDocuments(wrong, byId), /Unpinned or mismatched/);
});

test('core pages must expose their implementation, type, test and example links', async () => {
  const catalog = JSON.parse(await readFile(new URL('../docs-catalog.json', import.meta.url), 'utf8'));
  const doc = catalog.documents.find(entry => entry.id === 'flowkit-doc-provider');
  const refs = catalog.topics[doc.topic];
  const text = await readFile(new URL(`../../${doc.path}`, import.meta.url), 'utf8');
  validateDocumentReferences(doc, text, refs);
  assert.throws(() => validateDocumentReferences(doc, text.replace(refs.tests[0], 'tests/nonexistent.mjs'), refs),
    /Missing tests link/);
});

test('Host HTTPS validation rejects a floating URL and mismatched body', async (t) => {
  const url = flowkitProvider.capabilities[0].documents[0].source.url;
  await assert.rejects(readPinnedDocument(url.replace(/[a-f0-9]{40}/, 'main'), Buffer.from('expected')), /Only fixed/);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response('unexpected');
  });
  await assert.rejects(readPinnedDocument(url, Buffer.from('expected')), /HTTPS bytes differ/);
  assert.equal(fetch.mock.callCount(), 1);
});
test('routes preserve homepage, normalized index and 404 semantics', () => {
  assert.equal(publicUrl('/'), 'https://devcodex-labs.github.io/flowkit/');
  assert.equal(publicUrl('/index'), publicUrl('/'));
  assert.equal(publicUrl('/dsl/'), publicUrl('/dsl/index'));
  assert.equal(pageFile('/dsl/'), 'dsl/index.html');
  assert.equal(pageFile('/guide/quick-start'), 'guide/quick-start.html');
  assert.equal(publicUrl('/404'), undefined);
});
test('HTML parser decodes code and extracts real anchors', () => {
  const result = inspectHTML('<html lang="zh"><pre>a &lt; b</pre><h2 id="FK_R001">x</h2></html>');
  assert.equal(result.lang, 'zh'); assert.ok(result.text.includes('a < b')); assert.ok(result.ids.has('FK_R001'));
  assert.deepEqual(inspectHTML('<a id="run"></a><h2 id="run">run</h2>').duplicateIds, ['run']);
});
test('sitemap rejects error pages, omissions and duplicate URLs', () => {
  const urls = ['https://example.com/', 'https://example.com/guide.html'];
  const xml = values => `<urlset>${values.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
  assertSitemap(xml([...urls].reverse()), urls);
  assert.throws(() => assertSitemap(xml([...urls, 'https://example.com/404']), urls), /exactly/);
  assert.throws(() => assertSitemap(xml(urls.slice(1)), urls), /exactly/);
  assert.throws(() => assertSitemap(xml([...urls, urls[0]]), urls), /Duplicate/);
});
test('broken paths and anchors fail while valid deep links pass', () => {
  const files = new Set(['index.html', 'troubleshooting/runtime.html']);
  const ids = new Map([['troubleshooting/runtime.html', new Set(['FK_R001'])]]);
  checkLink('/flowkit/troubleshooting/runtime.html#FK_R001', 'index.html', files, ids);
  assert.throws(() => checkLink('/flowkit/troubleshooting/runtime.html#bad', 'index.html', files, ids), /missing anchor/);
  assert.throws(() => checkLink('/flowkit/missing.html', 'index.html', files, ids), /missing target/);
  assert.throws(() => checkLink('/guide/quick-start.html', 'index.html', files, ids), /misses base/);
});
test('missing coverage and private material cannot silently pass', () => {
  assert.throws(() => checkCoverage([]));
  assert.throws(() => assertNoPrivateContent('see .devcodex/task', 'test'));
  assertNoPrivateContent('公开用户文档', 'test');
});
test('missing or duplicate API anchors and incorrect release identity fail', () => {
  assertAnchors('<a id="run"></a>', ['run'], 'SDK');
  assertAnchors('## run：执行工作流 {#run}', ['run'], 'SDK');
  assert.throws(() => assertAnchors('<a id="run"></a>', ['run', 'compile'], 'SDK'), /compile/);
  assert.throws(() => assertAnchors('<a id="run"></a><a id="run"></a>', ['run'], 'SDK'), /duplicate/);
  assertVersion({ name: '@devcodex-labs/flowkit', version: '1.0.0', license: 'SEE LICENSE IN LICENSE', private: false, publishConfig: { registry: 'https://npm.pkg.github.com/' } });
  assert.throws(() => assertVersion({ name: '@devcodex-labs/flowkit', version: 'not-semver', license: 'SEE LICENSE IN LICENSE', private: false, publishConfig: { registry: 'https://npm.pkg.github.com/' } }));
});
test('subpath export inventory retains public aliases and excludes unexported names', () => {
  const source = 'const privateHelper = 1;\nexport { worker as run, compile };\nexport async function start() {}\nexport const provider = {};';
  assert.deepEqual(exportedNames(source), ['run', 'compile', 'start', 'provider']);
});
test('exact heading search hits keep their correct anchor without dropping prose matches', () => {
  const header = { type: 'header', title: 'SDK API', header: 'SDK API > compileSource：编译文本', link: '/reference/sdk#compileSource' };
  const duplicate = { type: 'content', title: 'SDK API', statement: 'compileSource：编译文本', link: '/reference/sdk#compile' };
  const prose = { type: 'content', title: '编译与检查', statement: '使用compileSource从文本编译', link: '/guide/compile-artifacts' };
  const groups = [{ group: 'zh', renderType: 'default', result: [header, duplicate, prose] }];
  assert.equal(onSearch('compileSource', groups), undefined, 'returning groups would append duplicate search sources');
  assert.deepEqual(groups[0].result, [header, prose]);
});
test('cold search assigns an error heading to its own section without relying on query hooks', () => {
  const content = '如何读取错误\n\n说明正文\n\nFK_R001 · 产物与源码不一致\n\n修复步骤';
  const start = content.indexOf('FK_R001');
  const page = { content, toc: [{ id: '如何读取错误', text: '如何读取错误', charIndex: 0 }, { id: 'FK_R001', text: 'FK_R001 · 产物与源码不一致', charIndex: start }] };
  // Interval lookup used by the pinned Rspress searcher, including its upper bound.
  const current = at => page.toc.find((h,i) => i + 1 < page.toc.length ? h.charIndex <= at && page.toc[i+1].charIndex >= at : h.charIndex < at)?.id;
  assert.equal(current(start), '如何读取错误');
  alignSearchHeadingBoundaries([page]);
  assert.equal(current(start), 'FK_R001');
  assert.equal(current(0), '如何读取错误');
  assert.equal(current(content.indexOf('说明正文')), '如何读取错误');
  assert.equal(current(content.indexOf('修复步骤')), 'FK_R001');
  const once = structuredClone(page); alignSearchHeadingBoundaries([page]); assert.deepEqual(page, once);
});
