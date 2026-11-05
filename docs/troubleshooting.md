# Troubleshooting

## Contents

[First success](#first-success) · [Diagnostics](#diagnostics) · [CLI and options](#cli-and-options) · [Artifacts and distribution](#artifacts-and-distribution)

## First success

Use Node >=22.13.0 and run `npm ci`, `npm run build`, then
`node examples/demo.mjs` in a checkout. A generated artifact is inspectable text;
do not execute historical prototype files. Node can print an experimental warning
for TypeScript stripping. This warning is independent of Flowkit diagnostics.

## Diagnostics

| Symptom | Action |
|---|---|
| `FK_C007` | Use static imports and inline DSL literals; remove source side effects, spreads and runtime expressions |
| `FK_C015/016/017/080` | Check ids, successors, reachable nodes and permitted loop/human repair returns |
| `FK_C053` warning | A declared output input is unwritten on every arriving path; fix the path or move the input; undeclared host input is allowed |
| `FK_C051` / `FK_R010` | Check projectRoot, skillsRoot and the actual `.md` file; compile existence checks can be disabled, runtime reads still occur |
| `FK_C052` / `FK_R011` | Use relative portable paths; remove traversal/backslashes; check realpath containment and SRI format |
| `FK_C057` / `FK_R012` | Authorize the exact HTTPS host and port; redirects must stay on the original origin |
| `FK_C058` / `FK_R011` | Use one correctly sized sha256/384/512 digest, padded or unpadded; local Skills cannot have integrity |
| `FK_C059` warning | The remote Skill lacks integrity; pin the raw bytes when a stable revision is required |
| `FK_R013` | Content differs from the pinned raw bytes; review the change, update the digest and regenerate artifacts together |
| `FK_R014` | Inspect cause for read/transport/timeout/size/decode failure; check UTF-8 and the 262144-byte/10-second limits |
| `FK_R002` | Return strict booleans for verification/approval; valid human comment; valid checkStep type; use boolean when expressions |
| `FK_R004` | Inspect reasons and optional cause; return an object matching the schema, then check hook/verification behavior and retry count |
| `FK_R001` | Regenerate the AOT/check artifact from its matching source/options; preserve relative source placement |

`FK_R003` is reserved and is not emitted by v1. CLI invocation/configuration
errors have no invented FK code. The complete frozen set is 52 compile codes and
9 runtime codes, including the reserved code. See the independent code fixtures
under `tests/fixtures/errors` in the repository for legal/illegal pairs.

## CLI and options

CLI has two commands and six option families:

```sh
node dist/cli.mjs compile sample.workflow.ts --out-dir .
node dist/cli.mjs check sample.workflow.ts --no-mermaid
node dist/cli.mjs compile remote.workflow.js --remote-skill-host skills.example.test
```

The families are `--out-dir`, `--skills-root`, `--remote-skill-host` (repeatable),
`--no-skill-check`, `--trace`, and `--mermaid/--no-mermaid`. Arrays supplied on the
CLI replace the config array. The CLI loads only `flowkit.config.mjs` in cwd;
SDK functions do not load that file. Set `projectRoot` through that config or SDK
options. There is no `--project-root`, `--remote-skill-hosts`, or `run` command.
Exit 0 means success (warnings allowed), 1 diagnostic errors, 2 invocation,
configuration or operational failure. Diagnostic output is newline JSON on
stdout; invocation and operational errors are one-line text on stdout. Configuration
errors are JSON diagnostics with `code:null`. Node's own warnings may use stderr.

SDK options are `projectRoot`, `outDir`, `skillsRoot`, `skillCheck`,
`remoteSkillHosts`, `trace`, `mermaid`, `fetch`, `signal`, `runId`, `dump`.
Defaults: root is the nearest file package.json ancestor or cwd; output is beside
the workflow; Skills root `skills`; Skill checking and Mermaid on; trace off;
remote host list empty; no custom fetch/signal/dump; runId is a fresh UUID for each
execution when omitted. Undefined values use
defaults. Null and unknown keys are rejected. `compileSource` additionally needs
`filename`; it writes just like compile. `outDir` must be the source directory or
an ancestor. Use distinct output basenames if workflows share an output directory.

## Artifacts and distribution

The package is private and has not been published. Use a checkout or an explicitly
packed tarball, not `npm install @devcodex/flowkit` from a public registry. The
tarball ships runtime/compiler/DSL/declarations/CLI and README; repository examples,
docs and test assets stay in Git. Deep imports into internal paths are unsupported.

Run `npm run verify` to build, test, type-check, check the tarball whitelist and
install/consume a real tarball. Package consumer validation installs pinned test
tools and needs network or a populated npm cache. It keeps tools outside the
package. On Windows Node22.13, loading TypeScript5.7 from Unicode paths can crash
even for an empty TypeScript file; consumer validation uses an ASCII temp tools
directory and still checks actual diagnostics. Do not suppress type errors.
