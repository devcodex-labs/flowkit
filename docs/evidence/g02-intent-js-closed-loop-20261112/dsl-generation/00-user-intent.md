# G02 用户意图（真实任务原文）

记录时间：2026-11-12，Asia/Shanghai。
本文件是 Grok Build 在生成本阶段 `.workflow.js` 时实际阅读的用户任务原文，未事后改写需求。

## 任务名称

内部「功能变更评审」可执行闭环。

## 任务正文

请为 FlowKit 内部维护团队设计一个可重复执行的「功能变更评审」工作流，用来处理维护者提交的功能请求。要求如下：

1. 入口先检查材料是否齐全（状态字段 `materialsReady`）。若材料不齐全，流程必须直接失败结束，不得调用任何 Agent。
2. 若材料齐全，按固定顺序执行三个 Agent 步骤，模型不得自行选择下一个节点：
   - 需求分析：阅读功能请求 `request`，输出 `requirementSummary`（字符串）。
   - 技术设计：基于上一节点的需求分析，输出 `designSummary`（字符串）。
   - 独立评审：同时阅读需求摘要和技术设计摘要，输出 `reviewApproved`（布尔）和 `reviewNotes`（字符串）。评审结果必须符合约定的 JSON 对象 schema；非法输出允许重试一次。
3. 评审通过则成功结束；评审不通过则失败结束，并给出可核查终态。
4. 流程推进、条件分支、重试与后继节点必须由 FlowKit 编译出的 JavaScript Program 决定，而不是由模型在回答里指定下一个节点。
5. 只使用 FlowKit 现有 DSL 语法，不要发明第二套解析器、模型网关或独立 FlowKit Server。Interactive 验收仅使用已实现的 P0-A 子集：Condition、Terminal、基本 Agent。Standard 可用同一份 DSL 展示已实现的 Agent/Condition/Terminal 语义；Loop/Action/Human/Parallel 不是本任务的必要步骤，对照现有 editorial golden 说明差异即可。

## 本次实际提交的功能请求（作为工作流输入 `request`）

为 FlowKit 维护者增加一条只读的工作流运行摘要查看能力：在不修改现有 Standard Root 六个 API、不引入独立 FlowKit Server 的前提下，允许受信 Host 读取一次运行的终态状态（succeeded/failed/errored）、terminal 节点和公开投影，便于排障。不在本阶段实现 adminTerminate，也不改变 Interactive P0-A 的节点范围。

说明：上述功能请求只是本工作流要评审的业务对象，G02 阶段本身并不实现该能力。
