import { defineConfig } from '@rspress/core';
import { pluginSitemap } from '@rspress/plugin-sitemap';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base, siteUrl, version, publicUrl } from './site';
import { nav, sidebar } from './navigation';
import pages from './coverage.json';
import { alignSearchHeadingBoundaries } from './search-index.mjs';
// Code imported by a fence may change while the page and route are unchanged.
const codeDependencies = [...new Set(pages.flatMap(({ file }) => {
  const page = new URL(`./content/${file}`, import.meta.url);
  if (!existsSync(page)) return [];
  const fences = readFileSync(page, 'utf8').matchAll(/```\w+\s+file="([^"]+)"/g);
  return Array.from(fences, ([, source]) => fileURLToPath(new URL(source, page)));
}))];
const customMaps = Object.fromEntries(pages.filter(page => existsSync(fileURLToPath(new URL(`./content/${page.file}`, import.meta.url)))).map(page => [page.route.replace(/\/index$/, '/'), { loc: publicUrl(page.route)! }]));
const sitemap = pluginSitemap({ siteUrl, customMaps });
const collectSitemapPage = sitemap.extendPageData;
sitemap.extendPageData = (pageData, isProd) => {
  if (publicUrl(pageData.routePath)) return collectSitemapPage?.(pageData, isProd);
};
export default defineConfig({
  root: fileURLToPath(new URL('./content', import.meta.url)), base, lang: 'zh',
  builderConfig: { performance: { buildCache: { buildDependencies: codeDependencies } } },
  siteOrigin: new URL(siteUrl).origin,
  title: 'FlowKit', description: '用 JavaScript / TypeScript 编排工作流，通过宿主 Runtime 连接你的业务。',
  logo: '/logo.svg', logoText: 'FlowKit 首页', icon: '/logo.svg',
  search: { codeBlocks: true, searchHooks: fileURLToPath(new URL('./search-hooks.mjs', import.meta.url)) },
  head: [route => { const href = publicUrl(route.pureRoutePath); return href ? ['link', { rel: 'canonical', href }] : undefined; }],
  plugins: [sitemap, { name: 'flowkit-search-heading-boundaries', modifySearchIndexData: alignSearchHeadingBoundaries }],
  themeConfig: {
    nav, sidebar,
    footer: { message: `FlowKit v${version} · 专有授权 · Copyright © 2026 devcodex-labs` },
  },
});
