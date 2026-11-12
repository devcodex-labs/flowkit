# G02 — 真实用户意图 → JS 工作流执行产品闭环

本目录是 G02 产品闭环验证材料，不是新的 DSL、解析器或模型网关。

- 用户意图原文：[`user-intent.md`](user-intent.md)
- 由 Grok Build 根据现有 DSL 生成的工作流：[`feature-review.workflow.js`](feature-review.workflow.js)
- Skill 文本：[`skills/`](skills/)
- Standard 编译产物（由官方 `flowkit compile` 生成）：[`feature-review.compiled.mjs`](feature-review.compiled.mjs)、可视化 [`feature-review.mmd`](feature-review.mmd)（Mermaid 只是图，不能代替 JS 执行）
- Interactive 编译产物（由 `compileInteractive` 生成）：[`feature-review.interactive.mjs`](feature-review.interactive.mjs)
- 操作脚本：[`run-standard.mjs`](run-standard.mjs)、[`run-interactive.mjs`](run-interactive.mjs)
- 可重复测试：[`../../tests/interactive/g02-product-closed-loop.test.mjs`](../../tests/interactive/g02-product-closed-loop.test.mjs)
- 模型回执夹具：[`../../tests/fixtures/g02/`](../../tests/fixtures/g02/)
- 证据目录：[`../../docs/evidence/g02-intent-js-closed-loop-20261112/`](../../docs/evidence/g02-intent-js-closed-loop-20261112/)

## 分层说明

| 层 | 本目录实际验证的内容 | 不得声称 |
|---|---|---|
| Standard | 同一份 DSL 经官方 `compile`/`check`/`run()` 执行 Agent/Condition/Terminal，含成功、入口条件为 false、评审拒绝、非法输出重试 | 不得把这些结果写成 Interactive 已支持 Loop/Action/Human/Parallel |
| Interactive P0-A | `compileInteractive`、真实 JS Program、Pending、受信 Host 回执、SQLite 关闭后重开恢复 | 不得把 Node/Shell 执行或本地测试签名标为 N-PASS 或原生安全 Host 来源认证 |
| 现有 Standard golden | 与 [`../editorial.workflow.js`](../editorial.workflow.js) 对照，说明八类节点差异 | 不得把 editorial 的 Loop/Action/Human/Parallel 记为本次 Interactive 已实现 |

## 从仓库复现

需要 Node >=22.13.0，在仓库根目录：

```sh
npm ci
npm run build
node dist/cli.mjs compile examples/g02/feature-review.workflow.js --skills-root examples/g02/skills
node dist/cli.mjs check examples/g02/feature-review.workflow.js --skills-root examples/g02/skills
node examples/g02/run-standard.mjs
node examples/g02/run-interactive.mjs
node --test tests/interactive/g02-product-closed-loop.test.mjs
```

`run-*.mjs` 从源码树导入现有 SDK，不创建第二套编译器。Interactive 脚本会在临时 SQLite 中重放已绑定的夹具；其中 `source=scripted-invalid` 的评审回执是故意非法的脚本负例，其余 Agent 正文是 Grok 在看到 Pending 之后撰写的模型输出。
