---
name: flowkit-workflow-author
description: 根据用户目标创建或修改 FlowKit 工作流，核对执行条件并准备可审查的 Workflow Skill 候选。
---

# 编写 FlowKit 工作流

从一句业务目标开始。使用当前项目、集合和已确认的用户选择。遇到会改变控制流、运行方式、权限或交付的歧义时，提供可行选项、推荐和理由，允许用户自定义。目标模式未定时保留草稿。

1. 使用 Host 装配的 `/host.createWorkflowAuthorHost`。Host 必须提供可独立响应的执行器及实际受预算约束的模型、工具和 I/O 端口；不能让 MCP 等待正在等待工具返回的同一调用者 Agent 来执行核心。
2. `start` 接受一句目标和 Host 已知的选择，持久化草稿，不调用模型或发布。已有版本须选准确 TargetRef，不能按相似名称覆盖。只解释时读取 `readDraft`，由 Host 有界解释；不重新生成、不使原批准失效。
3. Host 以当前认证身份、turnId、expectedStateVersion、实际上下文和基线调用 `advanceTurn`。收到 `needs-clarification` 时，展示 `questions` 给出的选项、推荐和自定义入口，沿用已知选择。例如交付或发布目标不明确时，可保留草稿，或请用户明确目标后再推进。共享固定 Standard DSL 核心实际调用 Intent Runtime、初始目录/文档、Plan、最终依赖、DSL 生成、真实编译及语义复审；不要在 Skill 或 MCP 中另写这套流程。保留未生效变更、原始要求及未决问题。
   只在当前集合与 Host 明确授权的目录内查找确需复用的 Professional Skill。Agent 步骤确实需要规范化指令时，在 Plan 节点上填写 `professionalNeeds: [{ id, description }]`。由 Host 核对正文适用性并提供确切来源、ID、版本和摘要。搜索无结果且完整时才起草。目录不可用、拒绝访问或存在多个候选时，保留缺口和待选择项。
   普通节点可只写 `description`。原生目录启用时，Host 使用当前授权的 Codex 目录及原字节。复审把已选定的 `SKILL.md` 正文作为证据，每次重开复审都重新验证授权和摘要。批准引用绑定精确摘要，不因进程重启、其他集合发布或相似名称改变。
   本机默认使用正式 Intent Runtime。遇到 `FKA_INTENT_BASELINE_REVIEW_REQUIRED` 时，先确认原请求和现有约束，再用新的 turn 和 `reconfirmIntentBaseline: true` 开始重审。
   有 Graph 发现结果时，引用经过授权的能力和 Host 取得的文档。只把实际执行所需的能力列为执行依赖。Host 已读入提案的文档需要随 Plan 进入复审和候选。Document 内容是证据，不能授予权限。
   Capability及requires依赖必须全部applicable；unknown/partial不进入可执行声明。Human自动修订必须设置有限maxRevisions。parallel.any存在写入或未知Agent副作用时，先取得Host对精确Artifact的安全策略认可；未认可则阻断，不改变引擎的迟到执行语义。
4. 内核仅在冻结语义内共享最多两次 Plan/DSL 技术修复。业务歧义、能力缺失、安全政策或语义复审阻断返回明确问题与选项，不通过删除约束来编译。引擎 succeeded 不等于 candidate-ready。同 Plan/资源/候选复用原字节与 builtAt；`advanceTurn(kind=review-only)` 只重新复审既有候选。
   已明确的目标和约束缺少 Plan 节点映射时，先在同一授权范围内做有限修复。编译结果与固定 Plan 的节点或控制边不符时，只修 DSL。真正未决定的业务规则继续在同一草稿询问，沿用已知选择。
   Plan 节点 ID 使用编译器的 kebab-case 规则，最长 64 字符。节点显示名最长 40 字符。每个 Standard Loop 的 Plan 节点固定不同的 `onSuccess` 和 `onMaxExceeded` 目标及对应控制边，生成 DSL 时沿用两者各自的角色。
   已明确的业务职责写在 Plan 节点的 `requiredRole: { id, label }`。它表达由谁承担职责。执行身份、绑定与访问权限由 Host 在运行时核验。角色与 Skill 需求均留在 `node.options` 之外。
   Standard Parallel 中，每个成员只有一条派生控制边通往汇合后的节点。成员失败由并行运行语义处理。
   无既有候选和外部基线的新建草稿收到补答时，继续沿用草稿 ID 和已知选择。按时间顺序读取该草稿的用户原话。采用 `planSource: node-options` 时，Standard、Interactive P0-B/P1/P2 均以 Plan 节点的 DSL 选项为准。编译器推导控制边，AuthorHost 直接使用经过校验的节点选项生成候选源码。没有附加关系时填写 `edges: []`。附加关系使用 `{from,to,kind}` 和既有节点 ID，`kind` 为 `data`、`capability` 或 `resource`。
   每个 Interactive Action 都必须明确声明外部效果。只读回调使用 `effect: 'read-only'`，仍可将结果写入工作流 state。经授权的外部写入使用 `effect: 'write'`。效果尚未确定时先澄清。复审用编译证据中的 `actionEffects` 逐个核对。
   新建草稿的模型输出无效或不完整时，AuthorHost 在同一轮预算内至多再解析一次，已有答案保留。修复预算耗尽时，以新 turnId 在原草稿继续即可。原样重发一条补答只计入一次，不把模型的早期理解当作用户基线。
   补答后，模型报告的待确认事项必须指向仍未决定的业务选项。已经选定的方案、已知 Host 事实和技术诊断留在 Plan 校验路径。独立复审未通过时，展示 `reviewRejection.findings` 及绑定同一 `candidateHash` 的两个动作。用户可选 `review-only` 重审原候选，或用 `authoring` 按意见修订。修订沿用同草稿的原始授权对话，审查意见作为证据随 Plan 提供。
5. 用 `reviewCandidate` 展示准确 Diff、真实 ReviewReceipt 或 `rejection`。默认分离步骤复核；用户明确要求独立主体时必须由 Host 提供真实身份和执行观察，缺少条件就报告缺口。复审须对照当前授权请求、有效意图、变更、基线证据、Plan、候选、Diff、资源八项材料。使用 `candidateDiff.compilerEvidence` 区分声明节点、声明终点、Mermaid 渲染标记和 Parallel 实际后继。复核根输入输出与用户目标、实际来源和失败路径。编译通过但遗漏必填业务输出时，复审不得通过。
6. 用户审阅精确候选后，Host 核验批准引用，通过 `recordApproval` 或在 `publish` 中原子登记批准并保存。绑定 contentHash、candidateHash、previousHash 和最新 stateVersion。模型声称“已批准”不能授予发布权。publicationId 重试读回原保存操作，不反激活旧版本；saved/discovery-pending 必须如实显示。
7. stdio/HTTP 使用同一服务的 `createMcpOptions(currentRequestContext, bindings)`，每次请求传当前身份和 Host 解析的 inputRef。使用当前 Host 公布的工具列表。可选的 `flowkit_match_capability` 给出发现结果，批准、交付和续办仍按对应入口操作。连接关闭不关闭共享 AuthorHost。仅服务所有者调用 `close`。取消后未知结果先用 SDK `settleTurn` 对账；一次性 retryRef 不重置原回合预算，不能自动重发未知写。

## 候选评审和用户交付

本机 MCP 返回候选时，先展示工具返回的候选预览链接，让用户查看交互流程图、节点详情和各分支。使用该候选的 `candidateHash` 发起复审。修改业务流程、根契约或依赖后，重新取得候选、图及复审结果，请用户确认更新后的具体版本。只有当前候选得到 Host 确认后才调用导出。

向用户提供导出工具真实返回的三个文件链接，分别为可运行的 `workflow.js`、Mermaid 文件 `workflow.mmd` 和可离线打开的交互图 `workflow.html`。保留候选标识及工具返回的文件 SHA-256。源码 DSL 与内部清单留在 AuthorHost。旧预览、未确认和复审不通过的版本按照工具返回的状态处理。执行导出结果使用相应 SDK 或受信 Host。

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
| defineWorkflow | id、SemVer version、name、nodes；第一节点为入口。需要业务边界时使用根 `contract.input` 和 `contract.output` |
| node | Agent：name、description、inputs、output JSON Schema、retries、next；requiredSkills 需准确版本 pin |
| action | name、action、writes、next；Interactive 还可声明 reads 和 effect；实际操作由 Host 执行 |
| condition | name、branches: [{when, next}]；兜底使用 when: 'true' |
| parallel | name、branches: [节点 ID]、join: {strategy: 'all_succeeded' 或 'any', next}；Interactive P1/P2 可用 branchMode: 'subflow' |
| loop | name、maxIterations、body、onSuccess、onMaxExceeded；修复区域遵循实际编译器检查 |
| verification | name、verifier、onSuccess、onFailure；返回布尔 |
| human | name、onApprove、onReject、有限 maxRevisions；Interactive 可用独立 onDecline 区分拒绝终止和要求修订 |
| terminal | name、status: 'succeeded' 或 'failed' |

### 根输入和业务输出

在 Plan 的顶层 `contract` 使用与 `defineWorkflow` 相同的 JSON 对象。按已授权请求填写根 `input` 和 `output` 的对象 Schema，分别核对字段名、类型及必填性。必填输出必须来自已声明的根输入或成功路径上确实产出该键的节点。例如成功返回 `receipt` 时，由对应 Action 的 `writes: ["receipt"]` 或 Agent 的输出 Schema 声明该字段，并将业务要求映射到实际生产节点。运行时按根输出 Schema 投影结果，供执行过程使用的内部状态留在运行内。验证失败、拒绝、取消和待对账状态按原语义结束或等待。

Interactive Human 的 `onReject` 可进入有界修订再回到原审批，`onDecline` 直接进入独立终止。审批前的产物不得当作已批准结果。外部写入需要 Host 已授权的效果和对账能力。

下面的 Standard 并行示例使用 `all_succeeded` 等待两个分支均正常完成，再进入 `done`。Standard 并行成员的布尔校验返回 `false` 属于正常完成。

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

### Interactive subflows

Interactive P1 使用 `all_succeeded`，P2 也支持 `any`。为包含多步或下一层并行的组使用 `branchMode: "subflow"`。每项 `branches` 是互相独立的分支入口。组内各步用自己的正常 DSL 后继。分支到达当前组的 `join.next` 时以成功完成，或以本分支内的 Terminal 状态完成。只有组的成功条件满足后才执行汇合后继。P2 内层 `any` 允许某个分支失败后继续等待其他分支。

以下是一个嵌套 P2 的节点选项示例。外层必须同时通过输入校验和内层复核。内层只需要一个复核通过。使用已知的 Host 布尔回调作为 `verification.options.verifier`，`onSuccess` 和 `onFailure` 连接到实际目标。采用相同结构时，保留实际用户的回调名、意图覆盖和资源约束。

```json
{
  "entryNodeId": "checks",
  "nodes": [
    {"id":"checks","kind":"parallel","name":"Check workflow","options":{"branchMode":"subflow","branches":["input","review"],"join":{"strategy":"all_succeeded","next":"done"}}},
    {"id":"input","kind":"verification","name":"Check input","options":{"verifier":"check-input","onSuccess":"done","onFailure":"input-failed"}},
    {"id":"review","kind":"parallel","name":"Review alternatives","options":{"branchMode":"subflow","branches":["copy","original"],"join":{"strategy":"any","next":"done"}}},
    {"id":"copy","kind":"verification","name":"Check copy","options":{"verifier":"check-copy","onSuccess":"done","onFailure":"copy-failed"}},
    {"id":"original","kind":"verification","name":"Check original","options":{"verifier":"check-original","onSuccess":"done","onFailure":"original-failed"}},
    {"id":"input-failed","kind":"terminal","name":"Input rejected","options":{"status":"failed"}},
    {"id":"copy-failed","kind":"terminal","name":"Copy rejected","options":{"status":"failed"}},
    {"id":"original-failed","kind":"terminal","name":"Original rejected","options":{"status":"failed"}},
    {"id":"done","kind":"terminal","name":"Checks succeeded","options":{"status":"succeeded"}}
  ],
  "edges": []
}
```

每个验收关注点应映射到真实节点。复审核对外层全部通过、内层选首个成功、单分支失败仍可由另一路通过、必需校验失败和全失败终态。

AuthorHost 内部 Workflow Skill 候选默认包括 `SKILL.md`、`workflow.js`、`workflow.mmd`。本机 MCP 向用户导出的三个文件是 `workflow.js`、`workflow.mmd`、`workflow.html`。DSL 留在内部，通用 Host 仅按显式选择保留 `source/workflow.dsl.js`。导入复用 Host 已批准源和既有集合规则；无 DSL 更新读取已验证 manifest.workflowDefinition、文件及依赖。Workflow Skill 与 Professional Skill 在集合的第二层平级。

执行已有 Workflow Skill 时，使用该 Skill 的运行入口。宿主根据已批准的 Artifact 和实际能力执行。
