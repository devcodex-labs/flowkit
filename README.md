# FlowKit

以 TypeScript / JavaScript 声明式 DSL 定义工作流，编译成可阅读、可执行的 JavaScript 控制流，由宿主运行。

This private development package implements the DSL, TypeScript reference checks, and the compiler through M1-4. It checks static definitions, Skills, graph regions, dataflow, and restricted `when` expressions, then produces deterministic JavaScript and Mermaid text. The package root exposes `compile`, `compileSource`, and `check`. The compiler does not execute workflow source, load API configuration, or fetch remote Skills. The workflow runtime and CLI are planned for subsequent batches. Project records live in `.devcodex/flowkit/requirements/flowkit-需求与使用契约整理/` under the workspace.

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

The DSL entry is `@devcodex/flowkit/dsl`; the package root provides the three compiler functions described below. `run`, public runtime helpers, and the CLI remain pending. A DSL object describes a workflow and does not execute it. Getters, cycles, or nonliteral data cause TypeError; edit the input data and construct a new definition when changing a workflow.

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

Output uses same-directory temporary files, flushes them, and replaces each target with a rename. All output text is prepared before replacement; the JS/diagram pair is not a cross-file transaction. Calls writing the same resolved target are serialized within the process. Separate processes or path aliases still depend on filesystem behavior. Failed writes clean only their own temporary files. The private development package currently exposes only the implemented compiler functions and matching compiler declarations; the final six-function SDK is still in progress.

## 开发验证

Run `npm run verify` with Node >=22.13.0 to build, run DSL and compiler tests, execute generated modules with test hosts, and check TypeScript 5.0.4 fixtures including 500-node definitions. Build before running tests individually because package self-references use `dist`. Tests require no server. Acorn 8.19.0 is the sole runtime dependency.

The private analysis entry is `src/compiler/analyze.mjs`; it is tested directly and is not a package export. It returns literal data, role-aware graph edges, region ownership, dominators, forward graphs with postdominators and joins, parsed conditions, and may-written dataflow sets. A `FK_C053` warning concerns a declared input with no writer on any reaching path; keys without a workflow writer remain host initial state. Parallel joins conservatively union branch writes, including `any`, without promising that every output has completed.

Human repair paths can be entered by normal flow before the first approval. Folded edges preserve their actual `sourceNode` and `targetNode`; regions provide `entryTargets` and an `entryForwards` analysis for each entry. The root `entryTarget` retains the first declared node. Emission honors those entry targets and preserves initial repair prefixes. Normal approval and loop success/exhaustion may not re-enter their own repair region.

The private `src/when/evaluate.mjs` implements `evalWhen(ctx, when)` for later API integration. It reads own state paths, short circuits strictly boolean logic, and gives comparison higher precedence than `!`. Parsing and evaluation use explicit stacks, not JavaScript evaluation. Diagnostics attach to the original source field; syntax messages separately report the decoded expression column. Local Skill realpath containment and UTF-8 loading remain pending.

The internal `compileToText(snapshot, options)` in `src/compiler/compile.mjs` returns code, Mermaid, and diagnostics without writing files. Create its snapshot with `createSourceSnapshot(bytes, filename)`. Public compiler functions share this text service. Generated modules export one `async function workflow(ctx)` and use native control flow with host-supplied `ctx.runtime` methods. A static emission plan prints shared joins once and expands only crossing regions into fixed boolean blocks; it emits no runtime graph dispatcher. Headers have ten lines and include raw-source and body hashes. `mermaid: false` returns empty diagram text; PascalCase id collisions remain compile errors. The output directory must be the source directory or an ancestor. Internal modules are not package exports. Generated-module tests use injected hosts; full SDK execution and Mermaid rendering acceptance remain pending. Batch records are in `M1-4-公开编译与检查/` beside the confirmed design.

## 方案材料

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
- A03-r2.1 was confirmed on 2026-11-03. M0 is committed as `60a8bc8`, M1-1 as `37d4578`, M1-2 as `9204577`, and M1-3 as `947e9e3`. M1-4 adds public compiler APIs and artifact output. M2 runtime, M3 CLI, and complete SDK acceptance remain pending. Verification and review records are kept in the corresponding batch directories.
