# FlowKit

**v1.0.0 · Node.js >=22.13.0 · 专有授权 · 私有 GitHub Packages**

用 JavaScript / TypeScript DSL 定义工作流，静态检查流程结构，生成可读 JavaScript 与 Mermaid，并通过你提供的宿主 Runtime 执行 Agent、业务动作、验证和人工审批。

[中文文档](https://devcodex-labs.github.io/flowkit/) · [快速开始](https://devcodex-labs.github.io/flowkit/guide/quick-start.html) · [示例](https://github.com/devcodex-labs/flowkit/tree/main/examples)

## 适用场景

适合需要条件分支、并行处理、校验重试、循环修复或人工决策的多步骤任务。模型调用、业务接口、Schema 校验器及人工交互由宿主提供。FlowKit 不内置持久化审批服务或跨进程恢复；并行分支共享状态，any 汇合不会取消其他分支。

## 安装

仅限已获授权的消费者。先为 GitHub Packages 配置 `@devcodex-labs` Registry，使用具备 `read:packages` 权限的 GitHub PAT (classic)，由环境变量 `NODE_AUTH_TOKEN` 提供，不把真实令牌提交到仓库。创建项目中的 `.npmrc`：

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

## 第一个工作流

创建以下两个文件。示例不需要模型密钥，也不依赖源码仓库。

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

能力图谱可选适配由 `@devcodex-labs/flowkit/capability-graph` 导出 `flowkitProvider` 和 `createCapabilityGraphActionAdapter`，它不内置模型或执行引擎；参见[能力声明](https://devcodex-labs.github.io/flowkit/guide/capability-provider.html)与[宿主消费示例](https://devcodex-labs.github.io/flowkit/examples/capability-graph.html)。

SDK 根入口提供 `run`、`compile`、`compileSource`、`check`、`evalWhen`、`isControlSignal`。DSL 从 `@devcodex-labs/flowkit/dsl` 导入。CLI 提供 `compile` / `check`；运行流程使用 SDK。避免导入包内私有路径。

工作流源文件必须以 `.workflow.js` 或 `.workflow.ts` 结尾。AOT 部署保留原始源码、编译产物及所需 Skill；一致性校验不能替代对宿主代码和产物来源的信任。

## 内部开发与许可

从仓库开发：`npm ci`，再运行 `npm run verify`。文档站位于 `website/`，其开发环境为 Node >=24，依赖与 SDK 分开安装。贡献入口见[贡献说明](https://github.com/devcodex-labs/flowkit/blob/main/CONTRIBUTING.md)。

FlowKit 是私有专有软件，当前使用 [专有授权协议](https://github.com/devcodex-labs/flowkit/blob/main/LICENSE)，Copyright (c) 2026 devcodex-labs。仓库当前版本为 v1.0.0，实际包发行以 GitHub Packages 记录为准；[更新记录](https://github.com/devcodex-labs/flowkit/blob/main/CHANGELOG.md)说明能力与限制。
