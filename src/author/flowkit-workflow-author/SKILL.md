---
name: flowkit-workflow-author
description: 根据用户目标创建或修改 FlowKit 工作流，核对执行条件并准备可审查的 Workflow Skill 候选。
---

# 编写 FlowKit 工作流

从一句业务目标开始。使用当前项目、集合和已确认的用户选择。遇到会改变控制流、运行方式、权限或交付的歧义时，提供可行选项、推荐和理由，允许用户自定义。目标模式未定时保留草稿。

1. 通过宿主配置的 FlowKit Author 入口调用 Intent Runtime，显式传入当前回合、可用上下文和已绑定的基线。保留尚未生效的变更和未决问题。
2. 使用授权的 Capability Graph 查询能力及固定版本的官方文档。按实际依赖核对可执行条件。能力依赖由宿主检查，工作流顺序由 FlowKit DSL 表达。
3. 梳理节点、分支、审批、有限重试、失败和终态。只在当前集合内查找确需复用的 Professional Skill。为每个强制依赖固定身份、版本和内容摘要。
4. 用已确认的计划生成 DSL 候选，通过 FlowKit Compiler 生成 `workflow.js` 和 `workflow.mmd`。候选还应包含 `SKILL.md`。按用户要求选择是否保留 `source/workflow.dsl.js`。
5. 核对目标覆盖和控制流，向用户展示计划与产物差异。正式交付需绑定精确候选和预期旧版本的审查、用户批准与宿主授权。待确认的候选留在草稿区域。

执行已有 Workflow Skill 时，使用该 Skill 的运行入口。宿主根据已批准的 Artifact 和实际能力执行。
