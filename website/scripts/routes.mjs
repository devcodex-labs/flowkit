export const base = '/flowkit/';
export const siteUrl = 'https://devcodex-labs.github.io/flowkit/';
export function pageFile(route) {
  const clean = route.replace(/^\/+/, '').replace(/\.html$/, '');
  if (!clean || clean === 'index') return 'index.html';
  return clean.endsWith('/') ? `${clean}index.html` : `${clean}.html`;
}
export function publicUrl(route) {
  if (/^\/?404(?:\.html)?$/.test(route)) return undefined;
  const file = pageFile(route);
  return siteUrl + (file === 'index.html' ? '' : file);
}
