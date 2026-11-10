/** The build and package checker share one list of shipped source/declaration pairs. */
export const packageFiles = [
  ['src/index.mjs', 'dist/index.mjs'],
  ['src/cli.mjs', 'dist/cli.mjs'],
  ...['arguments', 'config', 'main'].map(name => [`src/cli/${name}.mjs`, `dist/cli/${name}.mjs`]),
  ['src/dsl.mjs', 'dist/dsl.mjs'],
  ['src/integrations/capability-graph.mjs', 'dist/integrations/capability-graph.mjs'],
  ['types/capability-graph.d.ts', 'dist/capability-graph.d.ts'],
  ...['contracts', 'control', 'skill-ref'].map(name => [`src/shared/${name}.mjs`, `dist/shared/${name}.mjs`]),
  ...['source', 'extract', 'validate', 'skill-check', 'analyze', 'graph-algorithms', 'graph', 'dataflow', 'values', 'paths', 'mermaid', 'emit-plan', 'helpers', 'emit', 'compile', 'api', 'output'].map(name => [`src/compiler/${name}.mjs`, `dist/compiler/${name}.mjs`]),
  ...['feature-gate', 'lower', 'validate-ir'].map(name => [`src/compiler/interactive/${name}.mjs`, `dist/compiler/interactive/${name}.mjs`]),
  ...['parser', 'evaluate'].map(name => [`src/when/${name}.mjs`, `dist/when/${name}.mjs`]),
  ...['context', 'execute', 'load', 'source', 'skills', 'skill-remote', 'run', 'aot', 'dump', 'dump-channel', 'dump-hook'].map(name => [`src/runtime/${name}.mjs`, `dist/runtime/${name}.mjs`]),
  ...['dsl', 'index', 'compiler-api'].map(name => [`types/${name}.d.ts`, `dist/${name}.d.ts`]),
];
