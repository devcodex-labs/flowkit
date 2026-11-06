import test from 'node:test';
import assert from 'node:assert/strict';
import { pageFile, publicUrl } from './routes.mjs';
import { checkLink, inspectHTML, assertSitemap } from './check-rendered.mjs';
import { checkCoverage, assertNoPrivateContent, assertAnchors, assertVersion } from './check-content.mjs';
import { onSearch } from '../search-hooks.mjs';
import { alignSearchHeadingBoundaries } from '../search-index.mjs';
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
  assertVersion({ version: '1.0.0', license: 'MIT', private: false });
  assert.throws(() => assertVersion({ version: '0.1.0', license: 'MIT', private: false }));
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
