---
name: flowkit-author
description: 用一句业务目标起草 FlowKit Standard 工作流，按需求复审核对候选并导出供现有 SDK 或 Host 消费的文件。适用于生成、修改、复审或导出 FlowKit 工作流。
---

# 起草并交付 FlowKit 工作流

用当前工作区和用户已经提供的业务条件起草。只有歧义会改变控制流、资源或交付时才提问。给出可选方案和推荐，并在原草稿继续处理回答。用户要求改稿时先读取原要求和已有草稿。

1. 在用户工作区创建一个草稿目录，保存字面量 `draft.workflow.js` 和 `metadata.json`。按 [DSL 参考](references/dsl.md) 编写。元数据包含 `name`（小写短横线分隔的 Skill 名）、`description`、`version`（语义化版本）。用户要求保留 DSL 时加 `"includeSource": true`。根据已有 Host 能力命名业务回调，列出执行方必须提供的绑定。需要复用 Professional Skill 时，使用已核实的工作区 Skill 和 `professionalSkills` 清单，每项含 `nodeId`、`id`、`version`、`digest`。
2. 从用户工作区执行以下命令。用当前 Skill 的绝对路径替换 `<skill-directory>`，用实际草稿路径替换参数。每次修订使用新的候选 JSON 路径。编译失败时按诊断修同一草稿，保留原要求和补答。

   ```text
   node "<skill-directory>/scripts/workflow.mjs" prepare "<draft.workflow.js>" "<metadata.json>" "<candidate.json>"
   node "<skill-directory>/scripts/workflow.mjs" review "<candidate.json>"
   ```

3. 在编译之后做一次单独的语义复审。把候选的真实节点、分支、终点和所需 Host 能力逐项对照原需求与补答，指出漏项、意外动作和错误控制流。改稿时在 `review` 命令末尾加上一版同名 Skill 的候选 JSON，比较两版确切差异。先修复仍有问题的草稿，再重新编译和复审。把本次 `candidateHash`、复审结论和所需能力给用户。
4. 用户要求交付文件时，用刚复审的哈希导出到工作区里一个全新的目录。如果用户只要求复审，停在结论。

   ```text
   node "<skill-directory>/scripts/workflow.mjs" export "<candidate.json>" "<reviewed-candidate-hash>" "<new-output-directory>"
   ```

交付 `SKILL.md`、`workflow.js` 和 `workflow.mmd`，同时告诉用户产物 SHA-256。只有用户选择保留 DSL 时才附上源文件。将实际运行交给该项目现有的 FlowKit SDK 或 Host，按现有流程配置业务能力和执行权限。
