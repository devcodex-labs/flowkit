# FlowKit

以 TypeScript / JavaScript 声明式 DSL 定义工作流，编译成可阅读、可执行的 JavaScript 控制流，由宿主运行。

This private development package implements the compiler, runtime, and compile/check CLI, with package checks and real tarball consumer validation. It checks static definitions, Skills, graph regions, dataflow, and restricted `when` expressions, then produces deterministic JavaScript and Mermaid text. The package root exposes `run`, `compile`, `compileSource`, `check`, `evalWhen`, and `isControlSignal`. Runtime supports source compilation, verified ahead-of-time artifacts, and optional dump files. Publication remains pending. The compiler does not execute workflow source, load API configuration, or fetch remote Skills. Project records live in `.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/` under the workspace.

## Golden examples and integration

From a checkout on Node >=22.13.0, run `npm ci`, `npm run build`, then
`node examples/demo.mjs` (editorial approval) or `node examples/demo.mjs --remote`
(pinned remote Skill bytes through an in-memory transport). Both use deterministic
adapters. They do not call a model or publish content.

Repository guides: [golden examples and byte manifests](https://github.com/devcodex-labs/flowkit/tree/main/examples),
[host Runtime integration](https://github.com/devcodex-labs/flowkit/blob/main/docs/host-integration.md),
and [troubleshooting](https://github.com/devcodex-labs/flowkit/blob/main/docs/troubleshooting.md).
These assets stay in Git; they are not included in the private npm tarball. The
remaining README provides the SDK/CLI contract within the installed package.

## 目录导航

先看本地使用，再查限制与方案材料；开发验证和历史资料在后。

## 本地定义一个流程

使用 Node >=22.13.0，在仓库目录运行 `npm install` 和 `npm run build`。M0 尚未发布到 npm，当前使用工作区内的包自引用。

```js
import { defineWorkflow, action, terminal } from '@devcodex/flowkit/dsl';

export default defineWorkflow({
  id: 'save-draft', version: '1.0.0', name: '保存草稿',
  nodes: [
    action('save', { name: '保存', action: 'saveDraft', next: 'done' }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
```

结果是复制后递归冻结的流程定义，不会执行保存动作，也不冻结传入的原对象。TypeScript >=5.0 可检查字面量 id 引用，允许先引用后定义；拼错 `next` 等引用会在 `defineWorkflow` 调用时报错。动态字符串、字段合法性和图结构的完整检查由后续静态编译器负责。

The DSL entry is `@devcodex/flowkit/dsl`; the package root provides three compiler functions, `run`, and two runtime helpers described below. The CLI provides compilation and checks. A DSL object describes a workflow and does not execute it. Getters, cycles, or nonliteral data cause TypeError; edit the input data and construct a new definition when changing a workflow.

## Compile and check locally

Build the package first, save the DSL example above as `sample.workflow.ts` or `sample.workflow.js` with its default export, then use:

```js
import { compile, compileSource, check } from '@devcodex/flowkit';

const result = await compile('sample.workflow.ts');
if (result.diagnostics.some(item => item.severity === 'error')) {
  console.log(result.diagnostics);
}
const diagnostics = await check('sample.workflow.ts');
// compileSource(text, { filename: 'virtual.workflow.ts' }) has the same output effects.
```

`compile` and `compileSource` return `{ code, mermaid, diagnostics }`. Success writes `<name>.compiled.mjs` and, by default, `<name>.mmd`; compile errors return empty text and leave artifacts untouched. Warnings permit output. `compileSource` requires a filename but does not require that source file to exist. With `mermaid: false`, diagram text is empty and any existing diagram remains untouched. Put the same source bytes on disk before later deploying an ahead-of-time artifact.

`check` recompiles the source on each call and writes nothing. It compares an existing `.compiled.mjs` against the newly generated full text; differences produce `FK_R001` at that artifact's path, line 1, column 1. Missing artifacts are allowed, and diagram files are not compared. Use the same compilation options, including `trace`, when checking a previously generated file.

The default output directory is the source directory. An explicit `outDir` must be that directory or an ancestor. Explicit relative `projectRoot` and `outDir` values use the working directory at invocation; paths are fixed before asynchronous reads. The default project root is the nearest ancestor of the source containing a `package.json` file, falling back to that invocation directory. Local `skillsRoot` and DSL Skill paths are relative to `projectRoot`. Local Skill existence is checked by default; `skillCheck: false` disables that check. APIs accept the eleven confirmed `FlowkitOptions` keys, reject unknown keys or invalid types with TypeError, and ignore legal runtime-only options. Only `compileSource` accepts the additional `filename` key. File I/O failures reject with the original filesystem error.

Output uses same-directory temporary files, flushes them, and replaces each target with a rename. All output text is prepared before replacement; the JS/diagram pair is not a cross-file transaction. Calls writing the same resolved target are serialized within the process. Separate processes or path aliases still depend on filesystem behavior. Failed writes clean only their own temporary files. Package declarations expose the six implemented functions.

## CLI and configuration

After building locally, invoke the real entry with Node:

```sh
node ./dist/cli.mjs compile ./sample.workflow.ts --trace --no-mermaid
node ./dist/cli.mjs check ./sample.workflow.ts --trace --no-mermaid
```

Use the same effective settings when checking an existing artifact. The entry has a Node shebang and is mapped as `bin.flowkit`. A local tarball installs that command into the consumer's `node_modules/.bin`; use `npx --no-install flowkit` from the consumer project. This private working copy has not been published to the registry.

| Option family | Behavior |
|---|---|
| `--out-dir <dir>` | Output directory, subject to the compiler's ancestor rule |
| `--skills-root <dir\|URL>` | Local or remote Skill root |
| `--trace` | Enable trace generation |
| `--mermaid` / `--no-mermaid` | Enable or disable diagram output |
| `--no-skill-check` | Disable local compile-time Skill existence checks |
| `--remote-skill-host <host>` | Repeat to set the complete allowed-host array |

Valued options also accept `--name=value`. Boolean switches take no value. The command must be `compile` or `check`, with exactly one `.workflow.ts` or `.workflow.js` file. Unknown options, missing values, or extra positional arguments fail before configuration is loaded. `--` terminates option parsing.

Only the invocation directory's optional `flowkit.config.mjs` default export is loaded:

```js
export default { trace: true, mermaid: false, remoteSkillHosts: [] };
```

The configuration must be an options object. Every configured key is validated before merging; a command-line override cannot hide an invalid key or type. Explicit false switches override true configuration. Any `--remote-skill-host` occurrence replaces the configured array, preserving flag order. Missing flags leave configuration values intact. Paths use invocation cwd and the API's project-root rules, including when configuration code changes cwd. `fetch`, `signal`, `runId`, and `dump` remain legal configuration keys but are unused by these two commands. API calls never auto-load configuration.

Diagnostics are written to stdout as one JSON object per line, with no success summary. Exit `0` means no error, including warning-only results; `1` means compiler errors or an artifact mismatch; `2` means invalid arguments/configuration or an invocation/I/O failure. Argument and other invocation failures use one text line. Configuration load, syntax, type, or unknown-key failures use one Diagnostic JSON object with `code: null`, `file: 'flowkit.config.mjs'`, and line/column `1/1`. A broken configuration link is a load error. Configuration is ordinary user-selected JavaScript and can have its own side effects; the CLI itself never executes workflow source or runs the workflow.

## Pack and consume locally

From the repository, using Node >=22.13.0 and npm:

```sh
npm run build
npm run check:package
npm run test:package
npm pack --ignore-scripts
```

`build` validates its inputs, replaces this project's derived `dist` tree, and preserves the CLI shebang and executable mode. It rejects a linked `dist`. `check:package` checks metadata, byte-for-byte build freshness, relative import/declaration dependencies, and the actual `npm pack --dry-run` file list. Only the 42 built modules/declarations, `package.json`, and README are currently included. The `LICENSE` whitelist entry permits a future approved license file; no license file has been chosen or added in this batch. Source, tests, scripts, project records, dependency caches, and runtime binaries are excluded.

`test:package` creates a real tarball, installs it into an independent temporary project, checks installed bytes and public/private export boundaries, executes ESM/CJS SDK consumers and the installed CLI command, and compiles positive/negative type consumers. It uses TypeScript 5.7.3 with `@types/node` 22.13.0 and also checks the existing TypeScript 5.0.4 minimum with DOM globals. These extra tools are installed only in the temporary consumer. npm may use the network or an already populated cache. The temporary project is removed on success or failure; this command does not publish anything.

After `npm pack`, install `devcodex-flowkit-0.0.0-m0.tgz` into another project with `npm install <path-to-tarball>`. Save the DSL example as `sample.workflow.ts`, then run `npx --no-install flowkit compile ./sample.workflow.ts` and `npx --no-install flowkit check ./sample.workflow.ts` there. ESM imports use `@devcodex/flowkit` and `@devcodex/flowkit/dsl`; CommonJS callers can use dynamic `import()`. TypeScript consumers use NodeNext/moduleResolution NodeNext; the Node consumer fixture supplies Node globals without DOM. Internal subpaths, including `dist`, CLI internals, and `testing`, are not package exports.

## Run source and verified artifacts

With the `save-draft` example saved as `sample.workflow.js`, run it with a host action:

```js
import { run, isControlSignal } from '@devcodex/flowkit';

const runtime = {
  isControlSignal,
  async runAction(action, _name, ctx) {
    if (action !== 'saveDraft') throw new TypeError('Unknown action');
    ctx.state.saved = true;
  },
};
const result = await run('sample.workflow.js', runtime, { draft: 'Example' });
console.log(result.status, result.state.saved); // succeeded true
// After compile('sample.workflow.js'), the same host can run('sample.compiled.mjs', runtime).
```

`run` accepts `.workflow.ts`, `.workflow.js`, or `.compiled.mjs`. Other extensions and invalid options reject with TypeError. It reads the supplied file on every call. Successful DSL compilation/loading is cached in process by source hash, absolute filename, effective project/Skill settings, ordered remote hosts, trace, and dump directory. Every execution still gets fresh state, context and default Skill caches. Compiler and loading failures are not entered into that success cache; simultaneous first calls may compile more than once. `compile` and `check` always perform their own current checks. No cache switch or eviction policy is exposed; changing sources and registered dump URLs can accumulate in a long-lived Node process.

Default `run` writes no artifacts. `outDir` and `mermaid` do not affect it, and it never reads a configuration module. DSL compile errors reject with `phase: 'compile'`, the first error code and all diagnostics; warnings permit execution. Runtime failures retain their original rejection value instead of becoming a failed terminal result.

Ahead-of-time runs reread the artifact and verify the fixed ten-line header, original source bytes and complete body hash on every call. Deploy the source at the header's encoded relative path. Absolute or escaping source paths, missing sources and mismatched hashes reject with `FK_R001`, without `phase`; other filesystem failures remain unchanged. Source paths may follow ordinary filesystem symlinks. Execution imports the saved verified snapshot, so replacing the file after that read cannot substitute different business code. AOT is a trusted deployment format, not a sandbox or signature scheme.

Set `dump: './debug'` to write and load `<name>.<whole-text-sha256-first-12>.run.mjs` from that directory. Relative paths are fixed at invocation. Manual edits are restored before the next run; a real digest prefix collision rejects without replacing the other artifact. Dump files persist for inspection, while failed writes clean only their own temporary files. The dump loader registers one process-level Node hook on first use, intercepts only its registered exact file URLs, and leaves unrelated imports alone. Host loaders must preserve its generated function text; incompatible transformations reject before business calls. Failed loads use a new internal attempt URL on retry to avoid Node-version-dependent negative caching. Idle loader ports permit normal process exit.

A broken or closed dump-loader communication channel rejects pending operations and further dump calls in that process; restart the process to reinitialize it. Normal transient file or host-loading failures can retry with the internal attempt URL. The library does not silently bypass a failed verification channel.

## Runtime helpers and context

```js
import { evalWhen, isControlSignal } from '@devcodex/flowkit';

const runtime = { isControlSignal };
evalWhen({ runtime, state: { ready: true } }, 'ready'); // true
isControlSignal({ control: true, kind: 'cancel' }); // true
```

`evalWhen` reads own state paths and returns a strict boolean; invalid syntax or runtime operand types retain the confirmed diagnostic codes. `isControlSignal` checks only `error?.control === true`, including host-defined kinds. These helpers can be supplied to a host Runtime; the execution core does not automatically fill business methods.

`run` creates a fresh context, copies own enumerable string state keys as data, preserves nested aliases, and returns terminal status with the actual final state. An `error` key is attached only when the context owns it, including `undefined` or other falsy values. Business errors and control signals keep their original rejection identity. Runtime methods retain the host object as `this`; signal is passed through and an omitted runId receives a UUID.

Every execution provides a fresh default Skill loader. A host's `loadSkill` or `loadSkillByAgent` overrides only that method; other methods keep the original host as `this`, including private class fields. The library leaves the host object unchanged and does not fill model, schema, approval or action methods. Generated-function verification rejects incompatible loader transformations before business calls; it is not a sandbox for malicious host code. Internal runtime modules are not package exports. Node's own ESM module cache remains process-wide, without a constant-memory guarantee.

Default local Skills use project-relative `.md` paths, realpath containment for the root and target, and strict UTF-8 decoding. Missing files produce `FK_R010`, invalid paths or escapes `FK_R011`, and malformed UTF-8 `FK_R014` with a cause; other filesystem failures retain their identity. Distinct legal aliases keep separate cache entries, while an explicit reference and an agent mapping to that same reference share their pending read. Each new execution reads again. Containment follows the confirmed filesystem boundary; it does not promise atomic isolation from concurrent hostile filesystem mutation.

The host's local `skillsRoot` can be relative or absolute and may contain Unicode or spaces. Agent names still obey the raw segment rules, and the resolved file must remain inside the canonical project root. Explicit DSL Skill references retain their stricter ASCII path contract; that restriction is not applied to the host root option.

Remote defaults require HTTPS, an exact allowed host and effective port, and a valid raw `.md` path. An explicit Skill may pin one SHA-256/384/512 digest of the original bytes, with canonical Base64 padding or no padding. The loader uses `credentials: 'omit'` and manual redirects, permits three same-origin redirect edges, enforces 262144 actual bytes, and applies one 10000ms budget through the complete body. A supplied fetch receives an internal AbortSignal. External cancellation becomes a `cancel` control signal; HTTP, network, timeout, size and UTF-8 failures produce `FK_R014` with the documented cause. Integrity mismatch is `FK_R013`. Pending reads share a per-execution URL-plus-integrity cache; failures are evicted and never trigger agent retries. Timers, external listeners and stream locks are released on every exit; unread bodies are cancelled, including a late body from a custom fetch that ignored cancellation. Custom loader overrides own these responsibilities themselves.

## 开发验证

Run `npm run verify` with Node >=22.13.0 to build, run DSL/compiler/runtime/CLI/package tests, execute generated modules with test hosts, check TypeScript 5.0.4 fixtures including 500-node definitions, check package contents, and run the real tarball consumer. Build before running tests individually because package self-references use `dist`. Tests require no server; loader probes run in isolated child processes. Acorn 8.19.0 is the sole runtime dependency.

The private analysis entry is `src/compiler/analyze.mjs`; it is tested directly and is not a package export. It returns literal data, role-aware graph edges, region ownership, dominators, forward graphs with postdominators and joins, parsed conditions, and may-written dataflow sets. A `FK_C053` warning concerns a declared input with no writer on any reaching path; keys without a workflow writer remain host initial state. Parallel joins conservatively union branch writes, including `any`, without promising that every output has completed.

Human repair paths can be entered by normal flow before the first approval. Folded edges preserve their actual `sourceNode` and `targetNode`; regions provide `entryTargets` and an `entryForwards` analysis for each entry. The root `entryTarget` retains the first declared node. Emission honors those entry targets and preserves initial repair prefixes. Normal approval and loop success/exhaustion may not re-enter their own repair region.

The public `evalWhen(ctx, when)` delegates to `src/when/evaluate.mjs`. It reads own state paths, short circuits strictly boolean logic, and gives comparison higher precedence than `!`. Parsing and evaluation use explicit stacks, not JavaScript evaluation. Diagnostics attach to the original source field; syntax messages separately report the decoded expression column. Compiler and runtime Skill checks share the same raw-path, host and integrity semantics.

The internal `compileToText(snapshot, options)` in `src/compiler/compile.mjs` returns code, Mermaid, and diagnostics without writing files. Create its snapshot with `createSourceSnapshot(bytes, filename)`. Public compiler functions share this text service. Generated modules export one `async function workflow(ctx)` and use native control flow with host-supplied `ctx.runtime` methods. A static emission plan prints shared joins once and expands only crossing regions into fixed boolean blocks; it emits no runtime graph dispatcher. Headers have ten lines and include raw-source and body hashes. `mermaid: false` returns empty diagram text; PascalCase id collisions remain compile errors. The output directory must be the source directory or an ancestor. Internal modules are not package exports. Tests cover public source/AOT/dump execution, the CLI, and real tarball consumers; complete golden acceptance and Mermaid renderer verification remain pending. Package batch records are in `M3-2-分发与消费/` beside the confirmed design.

## 方案材料

The following links refer to maintainer workspace records. They are not included in the npm tarball; installed-package users can use the SDK, CLI, and local consumption instructions above.

- [需求概述](../.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/需求概述.md)：当前开发阅读入口，说明目标、范围、职责、验收和 A03 输入。
- [使用契约](../.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/使用契约.md)：现行 API、DSL、配置、运行语义与错误码。
- [交接审阅记录](../.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/交接审阅.md)：原件校验、原型边界和待落实事项。
- [需求资料索引](../.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/README.md)：完整来源、原始 ZIP 和历史整理材料。

## 定稿来源

2026-11-03 已取得并核验完整需求 v15、使用契约 v4 和最终决策记录原件，均已归入上述需求目录。下列网页保留为接入阶段证据；开发优先使用归档原件及最终 RC 决定。

1. [完整需求 v15（已定稿）](https://flowkit-v15-utfz.pages.grok.bot/)：网页只展示相对 v14 的增量小节，不能替代它引用的 3429 行原始文件。
2. [使用契约 v4（已定稿、已生效）](https://flowkit-v1-z57x.pages.grok.bot/)：约定对外 API、CLI、宿主职责与输出。
3. [v14 基线网页](https://flowkit-kklt.pages.grok.bot/)：已还原 3148 行，补齐 DSL、映射规则、编译模板和历史示例。页面仍写“待定稿”，来源所列哈希与 v15 引用的 v14 基线哈希相同；保留此状态差异。

原网页的状态、历史决定及本次建议保持分离。重新整理不等于重新批准需求，也不等于验证了尚未实现的包。

## 当前状态

- 仓库目录：`D:\Worker\flowkit`。
- 方案接入与可访问网页内容审查：已形成材料。
- 原始需求全文、最终决策记录和最新示例目录：已取得并校验；示例中含本地替身 / 原型，不是正式库实现。
- DevCodex MCP 项目上下文与会话记忆：已绑定 flowkit，活动根为工作区 `.devcodex/flowkit`，规范记忆目录为 `.memory/clients/codex/`。Codex 应用侧栏目前仍归属 Worker；它与 MCP 项目绑定是两个状态。
- A03-r2.1 was confirmed on 2026-11-03. M0 is committed as `60a8bc8`, M1-1 as `37d4578`, M1-2 as `9204577`, M1-3 as `947e9e3`, M1-4 as `a05b1fc`, M2-1 as `052780c`, M2-2 as `ae66569`, M2-3 as `ff2dec1`, and M3-1 as `715df00`. M3-2 adds clean builds, package checks, and real tarball consumers. Complete golden acceptance and publication remain pending. Verification and review records are kept in the corresponding batch directories.
