# G02 — 真实用户意图 → JS 工作流执行产品闭环

本目录是 G02 产品闭环验证材料，不是新的 DSL、解析器或模型网关。

- 用户意图原文：[`user-intent.md`](user-intent.md)
- 由 Grok Build 根据现有 DSL 生成的工作流：[`feature-review.workflow.js`](feature-review.workflow.js)
- Skill 文本：[`skills/`](skills/)
- Standard 编译产物（由官方 `flowkit compile` 生成）：[`feature-review.workflow.js.compiled.mjs`](feature-review.workflow.js.compiled.mjs)、可视化 [`feature-review.workflow.js.mmd`](feature-review.workflow.js.mmd)（Mermaid 只是图，不能代替 JS 执行）
- Interactive 编译产物（由 `compileInteractive` 生成）：[`feature-review.interactive.mjs`](feature-review.interactive.mjs)
- 操作脚本：[`run-standard.mjs`](run-standard.mjs)、[`run-interactive.mjs`](run-interactive.mjs)
- 可重复测试：[`../../tests/interactive/g02-product-closed-loop.test.mjs`](../../tests/interactive/g02-product-closed-loop.test.mjs)
- 模型回执夹具：[`../../tests/fixtures/g02/`](../../tests/fixtures/g02/)
- 冻结证据：[83a0530中的G02历史目录](https://github.com/devcodex-labs/flowkit/tree/83a05306d82f374d054a5afef0137bd4e4cb8074/docs/evidence/g02-intent-js-closed-loop-20261112/)。根docs清理后仍按该不可变提交追溯；这些是当时的记录，不代表当前发行/生产验收通过。

## 分层说明

| 层 | 本目录实际验证的内容 | 不得声称 |
|---|---|---|
| Standard | 同一份 DSL 经官方 `compile`/`check`/`run()` 执行 Agent/Condition/Terminal，含成功、入口条件为 false、评审拒绝、非法输出重试 | 不得把这些结果写成 Interactive 已支持 Loop/Action/Human/Parallel |
| Interactive P0-A | `compileInteractive`、真实 JS Program、Pending、受信 Host 回执、SQLite 关闭后重开恢复 | 不得把 Node/Shell 执行或本地测试签名标为 N-PASS 或原生安全 Host 来源认证 |
| 现有 Standard golden | 与 [`../editorial.workflow.js`](../editorial.workflow.js) 对照，说明八类节点差异 | 不得把 editorial 的 Loop/Action/Human/Parallel 记为本次 Interactive 已实现 |

## 验证已提交的金标

需要 Node >=22.13.0，在仓库根目录：

```sh
npm ci
npm run build
node --test tests/interactive/g02-product-closed-loop.test.mjs
```

Standard 金标测试在临时目录编译同一份工作流，并将新生成的 JS 与提交中的 `feature-review.workflow.js.compiled.mjs` 比对。测试保持示例目录中的 JS 和 Mermaid 原样。请在重建产物前运行测试，以便检出已有的金标漂移。

## 重建并运行示例

需要重建产物时执行下列命令。第一条会写入示例目录中已跟踪的 Standard JS 和 Mermaid，重建后请审阅生成差异。

```sh
node dist/cli.mjs compile examples/g02/feature-review.workflow.js --skills-root examples/g02/skills
node dist/cli.mjs check examples/g02/feature-review.workflow.js --skills-root examples/g02/skills
node examples/g02/run-standard.mjs
node examples/g02/run-interactive.mjs
```

`run-*.mjs` 从源码树导入现有 SDK，不创建第二套编译器。Interactive 脚本会在临时 SQLite 中重放已绑定的夹具，并输出 `pendingAtEnd`（终态帧是否仍有 Pending）以及从本次 `route` 实测的 `publishedPendingCount`。夹具中 `source=scripted-invalid` 是故意非法的脚本负例；`source=grok-model` 共消费 6 次，对应 5 份独立撰写正文、1 次复用（重新绑定到新的 Pending 身份），不能计为 6 次独立模型推理。
