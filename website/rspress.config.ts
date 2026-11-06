import { defineConfig } from '@rspress/core';
import { pluginSitemap } from '@rspress/plugin-sitemap';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { base, repository, siteUrl, version, publicUrl } from './site';
import { nav, sidebar } from './navigation';
import pages from './coverage.json';
import { alignSearchHeadingBoundaries } from './search-index.mjs';
const customMaps = Object.fromEntries(pages.filter(page => existsSync(fileURLToPath(new URL(`./content/${page.file}`, import.meta.url)))).map(page => [page.route.replace(/\/index$/, '/'), { loc: publicUrl(page.route)! }]));
const sitemap = pluginSitemap({ siteUrl, customMaps });
const collectSitemapPage = sitemap.extendPageData;
sitemap.extendPageData = (pageData, isProd) => {
  if (publicUrl(pageData.routePath)) return collectSitemapPage?.(pageData, isProd);
};
export default defineConfig({
  root: fileURLToPath(new URL('./content', import.meta.url)), base, lang: 'zh',
  siteOrigin: new URL(siteUrl).origin,
  title: 'FlowKit', description: '用 JavaScript / TypeScript 编排工作流，通过宿主 Runtime 连接你的业务。',
  logo: '/logo.svg', icon: '/logo.svg',
  search: { codeBlocks: true, searchHooks: fileURLToPath(new URL('./search-hooks.mjs', import.meta.url)) },
  head: [route => { const href = publicUrl(route.pureRoutePath); return href ? ['link', { rel: 'canonical', href }] : undefined; }],
  plugins: [sitemap, { name: 'flowkit-search-heading-boundaries', modifySearchIndexData: alignSearchHeadingBoundaries }],
  themeConfig: {
    nav, sidebar,
    socialLinks: [{ icon: 'github', mode: 'link', content: repository }],
    editLink: { docRepoBaseUrl: `${repository}/edit/main/website/content` },
    footer: { message: `FlowKit v${version} · MIT · Copyright © 2026 devcodex-labs` },
  },
});
