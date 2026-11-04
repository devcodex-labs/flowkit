import path from 'node:path';

/** All output APIs will consume this one lexical source-relative contract. */
export function compilationPaths(filename, options = {}) {
  const sourceFile = path.resolve(filename);
  const outDir = options.outDir === undefined ? path.dirname(sourceFile) : path.resolve(options.outDir);
  const relative = path.relative(outDir, sourceFile);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new TypeError('outDir must be the source directory or an ancestor of it');
  }
  const source = relative.split(path.sep).map(encodeURIComponent).join('/');
  const basename = path.basename(sourceFile).replace(/\.workflow\.(?:ts|js)$/, '');
  return Object.freeze({ source, outDir, codeFile: path.join(outDir, `${basename}.compiled.mjs`),
    mermaidFile: path.join(outDir, `${basename}.mmd`) });
}
