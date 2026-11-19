---
name: flowkit-workflow-author
description: 根据用户目标创建或修改 FlowKit 工作流，核对执行条件并准备可审查的 Workflow Skill 候选。
---

# 编写 FlowKit 工作流

从一句业务目标开始。使用当前项目、集合和已确认的用户选择。遇到会改变控制流、运行方式、权限或交付的歧义时，提供可行选项、推荐和理由，允许用户自定义。目标模式未定时保留草稿。

1. 使用 Host 装配的 `/host.createWorkflowAuthorHost`。Host 必须提供可独立响应的执行器及实际受预算约束的模型、工具和 I/O 端口；不能让 MCP 等待正在等待工具返回的同一调用者 Agent 来执行核心。
2. `start` 接受一句目标和 Host 已知的选择，持久化草稿，不调用模型或发布。已有版本须选准确 TargetRef，不能按相似名称覆盖。只解释时读取 `readDraft`，由 Host 有界解释；不重新生成、不使原批准失效。
3. Host 以当前认证身份、turnId、expectedStateVersion、实际上下文和基线调用 `advanceTurn`。收到 `needs-clarification` 时，展示 `questions` 给出的选项、推荐和自定义入口，沿用已知选择。例如交付或发布目标不明确时，可保留草稿，或请用户明确目标后再推进。共享固定 Standard DSL 核心实际调用 Intent Runtime、初始目录/文档、Plan、最终依赖、DSL 生成、真实编译及语义复审；不要在 Skill 或 MCP 中另写这套流程。保留未生效变更、原始要求及未决问题。
   只在当前集合内查找确需复用的 Professional Skill。为每个强制依赖固定身份、版本和内容摘要。
   Capability及requires依赖必须全部applicable；unknown/partial不进入可执行声明。Human自动修订必须设置有限maxRevisions。parallel.any存在写入或未知Agent副作用时，先取得Host对精确Artifact的安全策略认可；未认可则阻断，不改变引擎的迟到执行语义。
4. 内核仅在冻结语义内共享最多两次 Plan/DSL 技术修复。业务歧义、能力缺失、安全政策或语义复审阻断返回明确问题与选项，不通过删除约束来编译。引擎 succeeded 不等于 candidate-ready。同 Plan/资源/候选复用原字节与 builtAt；`advanceTurn(kind=review-only)` 只重新复审既有候选。
   已明确的目标和约束缺少 Plan 节点映射时，先在同一授权范围内做有限修复。编译结果与固定 Plan 的节点或控制边不符时，只修 DSL。真正未决定的业务规则继续在同一草稿询问，沿用已知选择。
   Plan 节点 ID 使用编译器的 kebab-case 规则，最长 64 字符。节点显示名最长 40 字符。每个 Standard Loop 的 Plan 节点固定不同的 `onSuccess` 和 `onMaxExceeded` 目标及对应控制边，生成 DSL 时沿用两者各自的角色。
   Standard Parallel 中，每个成员只有一条派生控制边通往汇合后的节点。成员失败由并行运行语义处理。
   无既有候选和外部基线的新建草稿收到补答时，继续沿用草稿 ID 和已知选择。按时间顺序读取该草稿的用户原话。Standard 草稿补答的 Plan 以各节点的 DSL 选项为准，由编译器推导控制边，并由 AuthorHost 从已校验的选项直接生成候选源码。
5. 用 `reviewCandidate` 展示准确 Diff 与真实 ReviewReceipt。默认分离步骤复核；用户明确要求独立主体时必须由 Host 提供真实身份和执行观察，缺少条件就报告缺口。复审须对照当前授权请求、有效意图、变更、基线证据、Plan、候选、Diff、资源八项材料。
6. 用户审阅精确候选后，Host 核验批准引用，通过 `recordApproval` 或在 `publish` 中原子登记批准并保存。绑定 contentHash、candidateHash、previousHash 和最新 stateVersion。模型声称“已批准”不能授予发布权。publicationId 重试读回原保存操作，不反激活旧版本；saved/discovery-pending 必须如实显示。
7. stdio/HTTP 使用同一服务的 `createMcpOptions(currentRequestContext, bindings)`，每次请求传当前身份和 Host 解析的 inputRef。八个既有 MCP 工具不增加名称；连接关闭不关闭共享 AuthorHost。仅服务所有者调用 `close`。取消后未知结果先用 SDK `settleTurn` 对账；一次性 retryRef 不重置原回合预算，不能自动重发未知写。

## 首次接入与恢复

Host 必须显式配置有限的 `capacity`：`maxPhysicalExecutions`、`maxDrafts`、`maxDraftBytes`、`maxRetainedDraftBytes`、`maxReceiptBytes`、`maxTurnsPerDraft`。待批准候选默认上限 16，与保留草稿及物理在途分开。缺执行器或容量时列出接入缺项，不等待正在调用 MCP 的同一原生 Agent 来执行核心。

每次传入的 RequestContext 包含 `namespace`、`principalId`、`sessionId`、`workspaceId`、`authorizedCollections`、`authorizationSnapshotRef`。它由 Host 认证生成，不能来自模型伪造参数。模型、工具及资源的所有实际请求都经过本回合 guarded ports；局部 adapter 重试也要计入持久总预算。可观察 usage 记录为观测值，其余保留 unknown，不报告精确费用。

取消先撤销旧执行的写回权。实际请求未结束仍占槽位，新输入可保留但不自动并发接管。已提交的回合直接读回原结果。`settleTurn` 只处理未提交的回合，且需要 Host 对准确 attempt 的证据。`confirm-result` 只提交已持久完成结果，`confirm-no-effect` 才可能发一次 retryRef，`abandon` 保留未知写的去重记录。重试与新回合共用物理槽位。遇到 `FKA_INFLIGHT` 时，等实际执行结束后使用原重试凭据。`close` 未关闭时须处理其 outstanding 报告，不关闭 Host 外部客户端。

启用发现需 Host 提供自有 root、`readMapping` 和 `compareAndSetMapping`；只有实际 CAS/读回匹配才显示 active。先保存全集合快照与固定 generation 路径，重试旧发布不反激活旧版。集合重命名须绑定当前全部批准 Skill 的 `expectedSnapshotHash`。清理 generation 还须 Host 提供 `readReferences`，确认撤映射、无 Run 引用且新 Run 接入已关闭；用户改动、未知目录和正式历史版本保留。跨集合迁移按回执对账，不宣称跨库原子，也不自动删除源。

完整固定响应接入示例见[Host 文档](https://devcodex-labs.github.io/flowkit/guide/host-integration)。示例只证明接线；真实模型质量、原生宿主发现、独立身份与费用分别验收。

## DSL 生成参考

生成字面量 JavaScript，导入 `@devcodex-labs/flowkit/dsl`。用选定能力的准确文档补充下表，不执行用户 DSL 来探测其含义。

| 构造器 | 关键字段 |
|---|---|
| defineWorkflow | id、SemVer version、name、nodes；第一节点为入口 |
| node | Agent：name、description、inputs、output JSON Schema、retries、next；requiredSkills 需准确版本 pin |
| action | name、action、writes、next；实际操作由 Host 执行 |
| condition | name、branches: [{when, next}]；兜底使用 when: 'true' |
| parallel | name、branches: [节点 ID]、join: {strategy: 'all_succeeded' 或 'any', next} |
| loop | name、maxIterations、body、onSuccess、onMaxExceeded；修复区域遵循实际编译器检查 |
| verification | name、verifier、onSuccess、onFailure；返回布尔 |
| human | name、onApprove、onReject、有限 maxRevisions；拒绝路径必须合法 |
| terminal | name、status: 'succeeded' 或 'failed' |

并行示例使用 `all_succeeded` 等待两个分支均正常完成，再进入 `done`。验证分支返回 `false` 仍属于正常完成。

<!-- standard-parallel-example -->
```js
import { defineWorkflow, parallel, action, terminal } from '@devcodex-labs/flowkit/dsl';

export default defineWorkflow({ id: 'parallel-inspection', name: 'Parallel inspection', version: '1.0.0', nodes: [
  parallel('inspect', { name: 'Inspect both inputs', branches: ['left', 'right'], join: { strategy: 'all_succeeded', next: 'done' } }),
  action('left', { name: 'Inspect left', action: 'inspect-left' }),
  action('right', { name: 'Inspect right', action: 'inspect-right' }),
  terminal('done', { name: 'Done', status: 'succeeded' })
] });
```

目标 Workflow 默认交付 `SKILL.md`、`workflow.js`、`workflow.mmd`，DSL 默认不分发；仅按显式选择保留 `source/workflow.dsl.js`。导入复用 Host 已批准源和既有集合规则；无 DSL 更新读取已验证 manifest.workflowDefinition、文件及依赖，不宣称反编译。Workflow Skill 与 Professional Skill 在集合的第二层平级，不加第三层。

执行已有 Workflow Skill 时，使用该 Skill 的运行入口。宿主根据已批准的 Artifact 和实际能力执行。
