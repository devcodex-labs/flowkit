/**
 * Rspress 2.0.23 includes the next heading's starting character in the previous
 * section's search interval. Its cold-index path also bypasses search hooks.
 * Move recognized heading boundaries onto the preceding separator so both
 * search paths associate the heading with its own section. Only search data
 * is changed; heading labels, TOC labels and anchor ids remain unchanged.
 * @param {import('@rspress/core').PageIndexInfo[]} pages
 */
export function alignSearchHeadingBoundaries(pages) {
  for (const page of pages) for (const heading of page.toc) {
    const at = heading.charIndex;
    if (at >= 0 && (at === 0 || page.content[at - 1] === '\n') && page.content.startsWith(heading.text, at)) heading.charIndex = at - 1;
  }
}
