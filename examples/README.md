# Golden workflows

## Contents

[Run](#run) · [Cases](#cases) · [Reproduce](#reproduce) · [Host boundary](#host-boundary)

## Run

From a repository checkout, use Node >=22.13.0:

```sh
npm ci
npm run build
node examples/demo.mjs
node examples/demo.mjs --remote
```

Both commands print a successful terminal and deterministic adapter events. The
demo does not call a model, open an approval UI, or publish anything. Its small
instruction-following adapter reads the Skill text and result schema; it supports
only these examples' vocabulary. Parallel
agent completion order is intentionally unspecified. The remote transport serves
the checked-in Skill bytes for the reserved `skills.example.test` host in memory;
it does not need DNS or a running server.

## Cases

| Source | Behavior | Fixed artifacts |
|---|---|---|
| [editorial.workflow.js](editorial.workflow.js) | All eight node kinds; parallel object reviews; repair budget; human rejection; one publish join | [JavaScript](editorial.compiled.mjs), [Mermaid](editorial.mmd) |
| [shared-join.workflow.ts](shared-join.workflow.ts) | TypeScript const definition; two branches share one save | [JavaScript](shared-join.compiled.mjs), [Mermaid](shared-join.mmd) |
| [remote.workflow.js](remote.workflow.js) | Two HTTPS Skills pinned to raw bytes; each returns its own object schema | [JavaScript](remote.compiled.mjs), [Mermaid](remote.mmd) |

`manifest.json` records source, Skill, host and artifact byte lengths/SHA-256, and
the two remote SRI values. Changing Skill text requires updating the DSL SRI,
recompiling, and regenerating the manifest together. Fixed artifacts use
`trace:false`, `mermaid:true`, `projectRoot:examples`, and an exact remote host list.
They can be inspected without running them.

## Reproduce

After an approved compiler version or example change, run `npm run build` then
`npm run update:goldens` and review the generated JS, Mermaid and manifest diff.
The compiler version belongs to the fixed headers, so a version change requires
this explicit refresh. The command preserves DSL and Skill text; changed remote
Skill bytes require reviewing and updating their DSL integrity first.

Use the existing SDK in a Node ESM script at the repository root:

```js
import { compile } from '@devcodex/flowkit';
for (const file of ['examples/editorial.workflow.js', 'examples/shared-join.workflow.ts', 'examples/remote.workflow.js']) {
  const result = await compile(file, {
    projectRoot: 'examples', remoteSkillHosts: ['skills.example.test'],
  });
  if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
}
```

Run `node --test tests/runtime/golden.test.mjs` after building. The test verifies
the manifest, recompiles into an isolated directory, compares every artifact,
executes shared-join AOT on both paths, and exercises direct approval, repair,
human rejection, exhausted verification budget and the old bare-true regression.
Compilation writes `<name>.compiled.mjs` and `<name>.mmd` beside the source by
default. `compileSource` also writes; use `check` for a read-only comparison.

## Host boundary

Copy [host.mjs](host.mjs) into your application and inject real services. The
`validateExample` function only supports the examples' flat string/boolean object
schemas and rejects other schema keywords. It is not a general JSON Schema
validator. Production hosts must bind a complete validator for their schema
dialect, actual model execution, business actions and an approval service. See
[host integration](../docs/host-integration.md) and [troubleshooting](../docs/troubleshooting.md).

These files are repository examples; the private npm tarball currently ships
`dist`, `README.md` and package metadata. It does not ship this directory.
