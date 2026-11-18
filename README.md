# FlowKit

**v1.0.0 · Node.js >=22.13.0 · 专有授权 · 私有 GitHub Packages**

用 JavaScript / TypeScript DSL 定义工作流，静态检查流程结构，生成可读 JavaScript 与 Mermaid，并通过你提供的宿主 Runtime 执行 Agent、业务动作、验证和人工审批。

[公开文档](https://devcodex-labs.github.io/flowkit/) · [工作流示例](https://devcodex-labs.github.io/flowkit/examples/index.html) · [内部示例源码](https://github.com/devcodex-labs/flowkit/tree/main/examples)

完整使用说明维护在网站。站点尚未部署或暂时不可访问时，可读取同版本的[站点源码](https://github.com/devcodex-labs/flowkit/tree/main/website/content)与[完整教程文件](https://github.com/devcodex-labs/flowkit/tree/main/examples/docs)，或按[站点维护说明](https://github.com/devcodex-labs/flowkit/blob/main/website/content/community/contributing.mdx)本地预览；包安装仍需相应权限。

## 适用场景

自然语言编写入口为随包交付的 `dist/author/flowkit-workflow-author/SKILL.md`，由 Host 通过 `/host.createWorkflowAuthorHost` 装配。用户一句话起草，关键未知项选择后生成可复审候选；保存需 Host 核验用户批准。完整接入、恢复和发现合同见[Workflow Author](https://devcodex-labs.github.io/flowkit/guide/workflow-authoring)与[Host 接入](https://devcodex-labs.github.io/flowkit/guide/host-integration)。已有 Workflow 的运行不依赖 Author。

适合需要条件分支、并行处理、校验重试、循环修复或人工决策的多步骤任务。模型调用、业务接口、Schema 校验器及人工交互由宿主提供。下方 Standard 示例在同一进程执行，并行分支共享状态，`any` 汇合后其他分支仍可继续。需要持久化暂停和跨进程续跑的内部维护者可查看 [Interactive P0-A 接入](https://devcodex-labs.github.io/flowkit/guide/interactive)。

## 运营定位

FlowKit 是 **私有、内部部署的商业产品基础设施**。未来可通过 MCP 服务、托管 API 或付费工作流设计产品向客户提供能力，**不向客户分发 FlowKit npm 安装包或源码**。目前这些商业服务属于规划方向，尚未作为本仓库的现成服务发布。客户使用服务和取得生成工作流的权利，应由单独的服务条款约定。

## 内部安装（仅维护者）

以下命令仅供拥有仓库或内部部署权限的维护者使用；公开文档读者和未来付费客户**无需安装 FlowKit**。先为 GitHub Packages 配置 `@devcodex-labs` Registry，使用具备 `read:packages` 权限的 GitHub PAT (classic)，由环境变量 `NODE_AUTH_TOKEN` 提供，不把真实令牌提交到仓库。创建项目中的 `.npmrc`：

```ini
@devcodex-labs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

然后逐行执行（PowerShell / Bash 均可）：

```sh
npm init -y
npm pkg set type=module
npm install --save-exact @devcodex-labs/flowkit@1.0.0
```

## 内部开发示例：第一个工作流

以下是供内部开发与审查使用的最小示例，公开读者可阅读流程和公开可见源码；使用/安装/分发仍须符合专有许可及包权限。示例不需要模型密钥，也不依赖源码仓库。创建以下两个文件。

<!-- flowkit:quick-start:start -->
**sample.workflow.js**

```js
import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';

export default defineWorkflow({
  id: 'hello-flowkit', version: '1.0.0', name: '第一个工作流',
  nodes: [
    action('greet', { name: '生成问候', action: 'greet', writes: ['message'], next: 'done' }),
    terminal('done', { name: '完成', status: 'succeeded' }),
  ],
});
```

**host.mjs**

```js
import { run, isControlSignal } from '@devcodex-labs/flowkit';
import { fileURLToPath } from 'node:url';

const runtime = {
  isControlSignal,
  async runAction(action, name, ctx) {
    if (action !== 'greet') throw new Error(`未实现的动作：${action}`);
    ctx.state.message = `你好，${ctx.state.name}！`;
  },
};
const result = await run(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), runtime, { name: 'FlowKit' });
console.log(JSON.stringify(result, null, 2));
```
<!-- flowkit:quick-start:end -->

在这两个文件所在目录执行：

```sh
npx --no-install flowkit compile sample.workflow.js
npx --no-install flowkit check sample.workflow.js
node host.mjs
```

编译生成 `sample.compiled.mjs` 和 `sample.mmd`；检查成功退出0，通常无输出。运行结果：

```json
{
  "status": "succeeded",
  "terminal": "done",
  "state": {
    "name": "FlowKit",
    "message": "你好，FlowKit！"
  }
}
```

`writes` 是静态声明，实际赋值由 `runAction` 完成。`check` 不创建产物；文件缺失时仍可能成功，因此要检查编译生成的文件。完整解释、失败复原及后续学习路径见[快速开始](https://devcodex-labs.github.io/flowkit/guide/quick-start.html)。

## 公开接口

<a id="flowkit-doc-readme"></a>

实现与验证 [源码](https://github.com/devcodex-labs/flowkit/blob/main/src/index.mjs) · [类型](https://github.com/devcodex-labs/flowkit/blob/main/types/compiler-api.d.ts) · [测试](https://github.com/devcodex-labs/flowkit/blob/main/tests/contracts.test.mjs) · [示例](https://github.com/devcodex-labs/flowkit/blob/main/examples/docs/quick-start/sample.workflow.js)

可选集成 `@devcodex-labs/flowkit/capability-graph` 提供 `flowkitProvider` 和 `createCapabilityGraphActionAdapter`。先用[能力与文档指南](https://devcodex-labs.github.io/flowkit/guide/capability-provider.html)定位对应版本的文档，再按[宿主消费示例](https://devcodex-labs.github.io/flowkit/examples/capability-graph.html)提供实际动作和权限。

SDK 根入口提供 `run`、`runArtifact`、`compile`、`compileSource`、`compileArtifact`、`check`、`evalWhen`、`isControlSignal`。DSL 从 `@devcodex-labs/flowkit/dsl` 导入。CLI 提供 `compile` / `check`，运行流程使用 SDK。避免导入包内私有路径。

Standard 正式产物通过 `compileArtifact` 取得 `workflow.js` 文本及摘要。Host 从可信批准记录取预期摘要，使用 `runArtifact` 校验和执行。描述型 Agent 节点使用 `description`、`descriptionRefs` 或 `requiredSkills`，由 Host 提供 `runAgentTask` 并在需要时提供 `prepareAgentTask`。

工作流源文件必须以 `.workflow.js` 或 `.workflow.ts` 结尾。AOT 部署保留原始源码、编译产物及所需 Skill；一致性校验不能替代对宿主代码和产物来源的信任。

## 内部开发与许可

从仓库开发：`npm ci`，再运行 `npm run verify`。文档站位于 `website/`，其开发环境为 Node >=24，依赖与 SDK 分开安装。贡献入口见[贡献说明](https://github.com/devcodex-labs/flowkit/blob/main/CONTRIBUTING.md)。

FlowKit 是仅供内部部署的私有专有软件，公开文档并不授予安装权；当前使用 [专有授权协议](https://github.com/devcodex-labs/flowkit/blob/main/LICENSE)，Copyright (c) 2026 devcodex-labs。仓库当前版本为 v1.0.0，实际包发行以 GitHub Packages 记录为准；[更新记录](https://github.com/devcodex-labs/flowkit/blob/main/CHANGELOG.md)说明能力与限制。


文档是完整使用入口；参考[直接Host执行](https://devcodex-labs.github.io/flowkit/guide/direct-host)、[Interactive接入](https://devcodex-labs.github.io/flowkit/guide/interactive)及[能力选型与编写](https://devcodex-labs.github.io/flowkit/guide/workflow-authoring)。源码公开可见不改变专有许可、私有包分发或内部部署授权。
