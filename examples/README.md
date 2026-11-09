# FlowKit 示例

初次使用请从[中文快速开始](https://devcodex-labs.github.io/flowkit/guide/quick-start.html)进入。用户教程主源位于 [docs/](docs/)，使用公开的 `@devcodex-labs/flowkit@1.0.0` 入口；下面保留原有三个仓库回归示例的命令与说明。

## 用户教程

各目录提供完整工作流、宿主及所需的 Skill 和辅助文件。按[站点示例](https://devcodex-labs.github.io/flowkit/examples/index.html)对应页面的安装、运行与预期结果操作。

| 目录 | 内容 |
|---|---|
| [quick-start](docs/quick-start/) | 两文件首次运行 |
| [host-integration](docs/host-integration/) | Agent、Skill、Schema 校验与审批宿主 |
| [conditional-routing](docs/conditional-routing/) | JavaScript / TypeScript 条件路由 |
| [parallel-review](docs/parallel-review/) | all / any 汇合、失败与延迟分支 |
| [verification-repair](docs/verification-repair/) | 循环检查、修复和耗尽 |
| [human-approval](docs/human-approval/) | 直接批准、拒绝后修订再批准 |
| [remote-skills](docs/remote-skills/) | 固定 HTTPS 响应、白名单、SRI 和缓存 |
| [aot](docs/aot/) | 独立目录部署、一致性检查和恢复 |
| [validation-retries](docs/validation-retries/) | 结果校验、重试次数和提交时机 |
| [cancellation](docs/cancellation/) | 取消传播和资源清理 |
| [run-cache](docs/run-cache/) | 进程内编译缓存和每次运行的状态 |
| [sdk-options](docs/sdk-options/) | SDK、配置、CLI 和公共类型 |

示例中的 Agent 输出、人工决策与远程响应用于演示编排行为，不调用真实模型或审批 UI。固定远程响应不代表已验证互联网服务。替换真实服务前阅读[宿主接入](https://devcodex-labs.github.io/flowkit/guide/host-integration.html)。

仓库构建后执行 `npm run docs:examples`，验证脚本会在临时项目真实安装候选 tarball 并运行这些教程。公开 npm 包消费与文档站发布步骤见[发布维护](https://devcodex-labs.github.io/flowkit/maintainers/releasing.html)。

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
import { compile } from '@devcodex-labs/flowkit';
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

示例目录不随 npm 包分发。v1.0.0 包包含 `dist`、`README.md`、`LICENSE` 和包元数据；用户可从仓库或文档站获取完整教程文件。
