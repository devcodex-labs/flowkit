# G02 工作流与现有 Standard golden 的可解释差异

对照对象：仓库已冻结示例 `examples/editorial.workflow.js`（及其 `editorial.compiled.mjs` / `editorial.mmd`），它是 Standard 八类节点的回归 golden，由 `tests/runtime/golden.test.mjs` 维护。本文件只解释差异，不更新该 golden，也不把 editorial 的能力记为 Interactive 已实现。

| 维度 | editorial golden | G02 `feature-review.workflow.js` | 说明 |
|---|---|---|---|
| 产品目的 | 编辑审批：起草、并行审阅、循环修复、人工批准、发布 | 功能变更评审：入口门禁、需求分析、技术设计、独立评审、终态 | 都是“分析/评审/结论”类闭环，但业务对象不同 |
| 节点种类 | Action、Agent、Parallel、Condition、Loop、Verification、Human、Terminal | Condition、Agent、Terminal | G02 必须同时通过 Interactive P0-A 功能门禁，因此不放入尚未实现可恢复路径的节点 |
| 条件路由 | `styleOk && factOk` 决定进入批准或质量循环 | `materialsReady` 决定是否进入分析；`reviewApproved` 决定成功或失败终态 | 都由编译后的 JS 调用 `evalWhen` / Interactive `advance()` 求值，而不是由模型选择下一节点 |
| 重试 | 起草 Agent `retries: 1`；另有 Loop 质量预算 | 仅评审 Agent `retries: 1`；分析/设计 `retries: 0` | G02 用 Schema 校验失败演示一次可控重试，不引入 Loop |
| 并行 | `reviews` 并行 style/fact，`all_succeeded` | 无 | Parallel 属于 Standard 已实现、Interactive 未实现（P1/P2） |
| 人工/动作 | Human 批准/拒绝；Action 准备、修复、修订、发布 | 无 | 这些是 Standard 已实现语义；Interactive 要到 P0-B。G02 不把它们算进 Interactive 验收 |
| 编译器 | 同一套 Standard 静态分析器与 `flowkit compile` | 同一分析器；另外再走 `compileInteractive` 生成独立的 `.interactive.mjs` | 没有第二套 DSL 解析器 |
| 执行入口 | Standard `run()` | 同时演示 Standard `run()` 与 Interactive Coordinator/Trusted Host | Interactive 产物不能用 Standard `run()` 加载，反之亦然 |
| Agent 输出来源 | 示例适配器按 Skill 词汇生成固定对象，不调用真实模型 | 成功/拒绝路径的 Agent 正文由 Grok 在看到 Pending 后撰写；非法评审是脚本负例 | 证据等级不同，见夹具说明 |

结论：G02 有意使用 P0-A 可执行子集来验证“意图 → DSL → 真实 JS Program → 程序决定分支”的产品闭环；完整八类节点的 Standard 行为仍以 editorial golden 为准，不在本阶段扩展 Interactive。
