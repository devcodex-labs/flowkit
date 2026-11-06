import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { base, siteUrl, pageFile, publicUrl } from './routes.mjs';
import { phaseLimit, assertNoPrivateContent } from './check-content.mjs';
export function inspectHTML(html) {
  const result = { ids: new Set(), duplicateIds: [], links: [], assets: [], text: '', lang: undefined, canonical: undefined };
  function visit(node) {
    const attrs = Object.fromEntries((node.attrs ?? []).map(item => [item.name, item.value]));
    if (attrs.id) { if (result.ids.has(attrs.id)) result.duplicateIds.push(attrs.id); result.ids.add(attrs.id); }
    if (node.tagName === 'html') result.lang = attrs.lang;
    if (node.tagName === 'a' && attrs.href) result.links.push(attrs.href);
    if (node.tagName === 'link' && attrs.rel === 'canonical') result.canonical = attrs.href;
    if (['script', 'img'].includes(node.tagName) && attrs.src) result.assets.push(attrs.src);
    if (node.tagName === 'link' && ['stylesheet', 'icon', 'preload', 'modulepreload'].includes(attrs.rel) && attrs.href) result.assets.push(attrs.href);
    if (node.nodeName === '#text') result.text += node.value;
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(parse(html)); return result;
}
export function checkLink(href, from, inventory, idsByFile) {
  if (/^(mailto:|tel:|data:|javascript:)/.test(href)) return;
  const url = new URL(href, siteUrl + from);
  if (url.origin !== new URL(siteUrl).origin) return;
  assert.ok(url.pathname.startsWith(base), `${from}: link misses base: ${href}`);
  let file = decodeURIComponent(url.pathname.slice(base.length));
  if (!file || file.endsWith('/')) file += 'index.html';
  if (!path.posix.extname(file)) file += '.html';
  assert.ok(inventory.has(file), `${from}: missing target ${file}`);
  if (url.hash && file.endsWith('.html')) assert.ok(idsByFile.get(file)?.has(decodeURIComponent(url.hash.slice(1))), `${from}: missing anchor ${href}`);
}
export function assertSitemap(xml, expectedUrls) {
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap URLs');
  assert.deepEqual([...urls].sort(), [...expectedUrls].sort(), 'Sitemap must contain exactly the public pages');
}
export async function checkRendered(args = []) {
  const limit = phaseLimit(args), website = fileURLToPath(new URL('../', import.meta.url));
  const dist = path.join(website, 'doc_build');
  async function files(dir, prefix = '') { const output = []; for (const item of await readdir(dir, { withFileTypes: true })) { const name = path.posix.join(prefix, item.name); if (item.isDirectory()) output.push(...await files(path.join(dir, item.name), name)); else output.push(name); } return output; }
  const inventory = new Set(await files(dist)); const idsByFile = new Map(), inspected = new Map();
  for (const file of inventory) if (file.endsWith('.html')) { const html = await readFile(path.join(dist, file), 'utf8'); assertNoPrivateContent(html, file); const info = inspectHTML(html); inspected.set(file, info); idsByFile.set(file, info.ids); }
  const pages = JSON.parse(await readFile(path.join(website, 'coverage.json'), 'utf8')).slice(0, limit);
  const sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8');
  assertSitemap(sitemap, pages.map(page => publicUrl(page.route)));
  for (const page of pages) {
    const file = pageFile(page.route), info = inspected.get(file); assert.ok(info, `Missing HTML: ${page.file}`);
    assert.deepEqual(info.duplicateIds, [], `Duplicate rendered anchors: ${page.file}`);
    assert.equal(info.lang, 'zh'); assert.equal(info.canonical, publicUrl(page.route)); assert.ok(sitemap.includes(`<loc>${publicUrl(page.route)}</loc>`), `Missing sitemap ${page.route}`);
    const source = await readFile(path.join(website, 'content', page.file), 'utf8');
    for (const match of source.matchAll(/```\w+\s+file="([^"]+)"/g)) {
      const code = await readFile(path.resolve(website, 'content', path.dirname(page.file), match[1]), 'utf8');
      assert.ok(info.text.replace(/\s+/g, '').includes(code.replace(/\s+/g, '')), `External code missing from HTML: ${page.file} -> ${match[1]}`);
    }
  }
  for (const [file, info] of inspected) for (const href of [...info.links, ...info.assets]) checkLink(href, file, inventory, idsByFile);
  assert.ok(inspected.get('404.html')?.text.includes('页面未找到'), 'Missing Chinese 404');
  return { pages: pages.length, html: inspected.size, full: limit === 46, passed: true };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await checkRendered(process.argv.slice(2))));
