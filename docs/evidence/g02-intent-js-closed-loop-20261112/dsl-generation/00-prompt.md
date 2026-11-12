# G02 DSL 生成：Grok Build 原始模型输入

记录时间：2026-11-12，Asia/Shanghai。
角色：Grok Bot / Grok Build，作为真实模型阅读用户意图，并按 FlowKit 现有 DSL 生成 `.workflow.js`。
本文件是生成尝试使用的完整输入。输出见同目录 `attempt-NN-raw.workflow.js`；若编译失败，后续尝试会完整保留，不会覆盖本输入或更早输出。

## 用户意图

见仓库文件 `examples/g02/user-intent.md`（生成时已完整阅读，内容与该文件一致）。

## 已阅读的现有 DSL 约束（摘自仓库，不是新语法）

- 从 `@devcodex-labs/flowkit/dsl` 导入 `defineWorkflow` 以及节点构造器。Agent 步骤使用 `node()`，并提供 `agent` 或 `skill`；条件使用 `condition()`；终态使用 `terminal()`。
- `export default defineWorkflow({ id, version, name, nodes })`。
- `id` 必须是 kebab-case，最多 64 字符；`version` 遵循 SemVer 2.0。
- Agent 节点需要 `name`、`agent` 或 `skill`、对象类型的 `output` schema、`next`。`retries` 为 0–10 的整数；缺省为 2。`inputs` 声明从 State 读取的键，缺失键进入 `missing`，不得被合成 null。
- 条件节点 `branches` 为 1–20 项，最后一项的 `when` 必须是 `'true'`。`when` 是针对 State 的表达式字符串，不能包含换行或反斜杠。
- 终端节点 `status` 只能是 `succeeded` 或 `failed`。
- 工作流文件名必须以 `.workflow.js` 或 `.workflow.ts` 结尾。
- Interactive P0-A 只允许 Condition / Terminal / 基本 Agent（无 Agent verify/checkStep，无 Human/Action/Loop/Parallel）。本任务的 DSL 必须能通过 `compileInteractive(..., { featureStage: 'P0-A' })`，因此不放入 P0-A 未实现的节点。
- 参考已有示例：`examples/interactive/c01-live-chatgpt.workflow.js`、`examples/editorial.workflow.js` 的构造方式。不要复制 C01 的业务文本，本任务是独立的功能变更评审闭环。

## 生成要求

只输出一份完整的、可保存为 `feature-review.workflow.js` 的 ESM 源码。不要输出 Mermaid、JSON 节点计划或伪代码来代替 DSL。节点后继必须写在 DSL 里，让编译后的 JS Program 做路由。
