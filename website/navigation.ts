import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pages from './coverage.json';
const active = pages.filter(page => existsSync(fileURLToPath(new URL(`./content/${page.file}`, import.meta.url))));
const groups = [...new Set(active.map(page => page.group))];
export const sidebar = { '/': groups.map(group => ({ text: group, items: active.filter(page => page.group === group && page.id !== 'P01').map(page => ({ text: page.title, link: page.route })) })).filter(group => group.items.length) };
export const nav = [
  { text: '了解 FlowKit', link: '/guide/introduction', activeMatch: '^/guide/(introduction|installation|quick-start|javascript-typescript)' },
  { text: '使用指南', link: '/guide/workflow-model', activeMatch: '^/guide/(?!introduction|installation|quick-start|javascript-typescript)' },
  { text: '参考', link: '/dsl/index', activeMatch: '^/(dsl|reference)/' },
  { text: '示例', link: '/examples/index', activeMatch: '^/examples/' },
  { text: '排错', link: '/troubleshooting/index', activeMatch: '^/troubleshooting/' },
].filter(item => active.some(page => page.route === item.link));
