/**
 * Rspress 2.0.23 can also index an exact heading as a content hit assigned to the
 * previous section. Keep the heading hit, which has the correct explicit anchor.
 * @type {import('@rspress/core/theme').OnSearch}
 */
export function onSearch(query, groups) {
  const headings = new Set(groups.flatMap(group => group.result)
    .filter(item => item.type === 'header')
    .map(item => `${item.title}\0${item.header.split(' > ').at(-1)?.trim()}`));
  // Rspress appends returned groups; filter the supplied default groups in place.
  for (const group of groups) group.result = group.result.filter(item =>
    item.type !== 'content' || !headings.has(`${item.title}\0${item.statement.trim()}`));
}
