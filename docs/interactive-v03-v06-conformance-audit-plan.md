# FlowKit Interactive — V0.3 / V0.6-R5 正式契约符合性审查计划

**状态：已批准进入审查；尚未形成符合性结论。**  
**基线日期：2026-11-12（UTC+8）**  
**当前 main：** `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`  
**需求基线：** Requirements V0.3（已确认）  
**技术基线：** Technical Design V0.6-R5（已确认）  
**安全补充：** PR #14 Trusted Host V2（已合并的安全设计记录，不覆盖 V0.3/V0.6-R5）  
**关联：** [正式原件登记](./interactive-phase2-formal-source-register.md) · [完整路线图](./interactive-full-delivery-roadmap-2026-11-11.md)

## 0. 本次审查的目标与边界

目标不是重新设计 FlowKit，也不是把所有现有测试重新跑一遍，而是基于用户确认的两份正式原件，回答四个问题：

1. V0.6-R5 是否逐条遵守更高优先级的 V0.3 需求？
2. 当前 main 的真实代码、测试与已合并 PR #14 安全设计，分别符合、部分符合或偏离哪些正式条款？
3. 2026-11-10 Core POC 已经证明了什么、没有证明什么；哪些 POC 缺口必须先补？
4. 对照已有 **P0-A 实施计划 V0.1 Confirmed**（M1–M6、31 项文件级任务）和当前 main 已实施的 M1–M5，哪些已具备可核验代码与测试、哪些仍属于 M6/Host 后续门禁？

**权威层级：**
- Requirements V0.3 是最高业务需求，技术设计不能覆盖或擅自修改它。
- Technical Design V0.6-R5 是已确认的统一技术规范；正文 §§1–18 是唯一规范性设计。
- PR #14 Trusted Host V2 是后续安全设计补充，必须映射回 V0.3/V0.6-R5，不能静默改变 Program ABI、Core API、Checkpoint/Store 语义或 P0-A/P0-B/P1/P2 边界。
- Core POC 报告是有限范围的运行证据，不是需求或技术规范，也不能把未实现范围判 PASS。
- 当前 main 是实现核验对象；V0.3/V0.6-R5 中引用的 `ea2df674f3d3fd7f2b0ba4b48eb21e3bd47c3a2c` 是历史源码参照，不得与当前 main SHA 混为一谈。
- **已有用户确认的 P0-A 实施计划 V0.1（2026-11-10），当前 main 亦已有 M1–M5 实施代码**。本轮不得重新生成第二份 P0-A 正式计划覆盖历史确认版，也不能把 PoC 时代的“未实施”直接投射为当前 main 状态；应建立既有 31 项任务、现有实现与未关闭 M6 门禁的对照。

本计划不授权修改已确认原件、Program ABI、Core API、SQLite Schema、P0-A 状态语义；不授权生产代码开发、PR 合并、发布或部署。任何正式契约变更先形成差异与建议，等待用户确认并独立版本化。

## 1. 已冻结的输入与证据

| 输入 | 固定身份 | 已知状态 |
|---|---|---|
| Requirements V0.3 | SHA-256 `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e`；56,883 bytes | 已确认原件，归档校验通过 |
| Technical Design V0.6-R5 | SHA-256 `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba`；114,621 bytes | 已确认原件，两个归档副本哈希一致 |
| V0.6 Confirmed Handoff ZIP | SHA-256 `2deb5b3fa60ed3b7c2d29f028e33835c47aaa0a976e947de717128caf7326549` | 内部 SHA256SUMS 9/9 PASS；包含批准/PoC 计划、R5 独立收敛复审、需求追踪与静态验证结果 |
| Core POC Evidence ZIP | SHA-256 `a6b5201e8327463b57700174297bf986fbc4902c6ef6493710e8cac021f178` | 内部 manifest 28/28 文件条目 PASS；最终 TAP 22/22；9 个 SIGKILL 断点 |
| V0.3 Grok Development Handoff ZIP | SHA-256 `8a2f679a796234383b5108d58db16c1016a35c6110301bc4eb7e091ee2ed5826` | 仅含 V0.3-R2 technical draft，不是 V0.6 Confirmed Handoff |
| PR #14 | Merge commit `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd` | Trusted Host V2 安全设计记录已合并；不等于安全实施通过 |
| 当前 main | `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd` | 本次代码符合性核验的当前基线 |

POC 报告的限定结论：
- POC-01 PARTIAL：使用受限 JSON Fixture，未接入真实 FlowKit AST/Fields/Graph/Dataflow。
- POC-02 PASS（本地进程级）：SQLite Genesis/CAS/Journal、事务回滚。
- POC-03 PASS（9 个进程级断点）：跨 Node 进程 SIGKILL 恢复。
- POC-04 PASS（本地竞争）：双进程相同/冲突 Receipt、历史 Ack、丢响应恢复。
- POC-05 PARTIAL：不可变 Program Registry 有限验证；升级、迁移、GC/灾备未验证。
- POC-06 PARTIAL：namespace 与 Linux UID 文件拒绝有限验证；生产 Host/Model 隔离和 ExecutorContext 全链路未验证。
- POC-07 BLOCKED（Human）/ PARTIAL（Admin）：没有真实独立 Human 审批来源。
- POC-08 BLOCKED（完整矩阵）：尚未完成 Node 22.13/24.22 × Windows/Ubuntu、TS 5.0.4 与现有 Standard 全量回归。
- POC-09 PARTIAL：只测简化 Fixture 的 CAS 写入与阶段预算。
- POC-F04：完整 RFC 8785/JCS 测试向量尚未证明。

**证据纪律：** 22/22 是隔离原型测试结果，不是 POC-01–09 全部 PASS；9/9 是原型环境进程崩溃点，不是 Windows、断电、多机或真实模型 exactly-once 证明。

## 1.1 编号体系的权威性与来源（不得混为一谈）

| 编号体系 | 来源与性质 | 本次审查用途 |
|---|---|---|
| T01–T34 | 用户确认的 Requirements V0.3 正式验收需求 | **最高业务需求**；逐条保留原文和阶段 |
| R01–R22 | V0.6-R5 保留的历史技术反例 | 技术设计必须解释并有对应验证入口；不是新的用户需求 |
| S01–S14 | V0.6-R5 中的 Grok 定向验收场景 | 对应设计/实现阶段的定向验证；不因文档覆盖而 PASS |
| C01–C24 | 后续 M6/PR12 交付验收矩阵 | 当前交付/真实宿主验收扩展；**不是 V0.3 原始 T 需求，也不是 V0.6 原始 S 场景**，必须保留其自身来源和状态 |
| TH-001–TH-030 / SEC-01–SEC-19 / NAT-01–NAT-15 | PR #14 Trusted Host V2 安全设计 | 后续 Host 安全威胁/测试补充；映射到 V0.6 §7/§11、T27/S13 和 C 矩阵，不得回写成原始需求 |
| POC-01–POC-09 / POC-F01–F05 | 2026-11-10 核心机制 PoC 计划/报告 | 证明实际原型覆盖范围与未关闭差距，不改变正式需求编号 |

**判定时必须保留来源层级**：若 C/TH/SEC/NAT 的后续安全验收与 T/V0.6 存在差异，先登记为补充要求或潜在冲突，不能悄悄改写 V0.3/V0.6。

## 2. 审查工作流

### Step 1 — 原件与基线锁定（已完成）

- [x] 两份正式文件 SHA-256 完整值已计算。
- [x] V0.6 Confirmed Handoff 内部 9/9 SHA256SUMS 校验。
- [x] Core POC Evidence 内部 28/28 文件条目校验。
- [x] 两个独立归档中的 V0.3/V0.6 基线文件哈希一致。
- [x] 当前 main、PR #14 merge commit 和 CI 记录已登记。
- [ ] 将原始文件字节、归档哈希、当前 main SHA 和工具版本写入最终审查报告的不可变 Evidence Index。

### Step 2 — V0.3 需求逐条提取与验收语义锁定

逐条读取 V0.3 原文，不以路线图摘要代替：

- T01–T10：P0-A 核心纯流程、Agent、Checkpoint、回执、身份和预检。
- T11：没有 JS 执行工具时必须如实 BLOCKED。
- T12–T14：Standard/包/类型/错误码兼容与 Agent 重试/失败语义。
- T15–T23：P0-B 的验证、Action、Human、Loop、取消。
- T24/T26：P1 Parallel all_succeeded。
- T25：P2 any，业务预期未获专项确认。
- T27：真实宿主 JS 工具链（包括 ChatGPT 专项）必须提供真实执行证据。
- T28：源码、生成 JS、包、类型、文档、测试交叉一致。
- T29–T34：崩溃、伪造、竞态、未知副作用、Standard/Interactive 差异、预算和隐私。

产物：`V03-T01-T34-Requirement-Ledger`。每条保留原始措辞、阶段、必要不变量、正例、负例、退出证据；不改编号、不重写正式需求。

### Step 3 — V0.6-R5 §§1–18 技术规范逐章审查

按正式正文唯一规范逐章核对：

| V0.6 章节 | 必查内容 | 关键输出 |
|---|---|---|
| §1 | 产品边界、既有源码、非目标 | 是否扩张为 Server/模型网关/数据库/沙箱；是否保持内部引擎定位 |
| §2 | 十四条不可退化不变量、分层图、编译流水线、Program/Coordinator 边界 | Program 唯一控制流、可信 Registry、零 import、同字节加载 |
| §3 | 生命周期、Phase/Proposal 矩阵、持久化屏障、paused/取消 | 是否所有持久边界和恢复时序唯一可判定 |
| §4 | SDK API、Host 授权和恢复参数 | API 参数、能力对象、namespace 权限是否一致 |
| §5 | Program ABI V1、HostSubmission、Store/Registry/Runtime 类型 | 类型、判别联合、字段与实际源码/PR14 是否冲突 |
| §6 | ProgramRegistry、Run retain、升级/回滚/删除 | 原产物固定、旧 Run 兼容与 GC 是否有完整规则 |
| §7 | PublicTask、TrustedExecutorContext、回执接纳和 CertifiedEvent | 模型可见/可信执行器视图隔离；来源不能由模型自报 |
| §8 | CheckpointStore 五操作、事务、Journal、Receipt、单写者 | Genesis/CAS/历史 Ledger/丢响应/单 Dispatcher 约束 |
| §9 | SQLite V1 参考 Schema | DDL 与五操作/外键/namespace/事务边界一致；仅作为参考 Store |
| §10 | Agent、Condition、Action、Verification、Human、Loop、Parallel | 节点语义、失败分类、State 读写视图与阶段边界 |
| §11 | 多租户、JSON/JCS、安全边界和不可能承诺 | OS 身份、密钥/DB/审批来源与 Host 安全设计一致 |
| §12 | 错误码与失败归属 | 新 FK_I_* 不改旧 61 码；业务失败与设施错误不混淆 |
| §13 | 资源预算、性能、保留、宿主模式 | 2 MiB/128 stages 等是候选预算还是实测承诺；不得过度承诺 |
| §14 | Standard/Interactive 有意差异 | T33 对照范围和明确不等价项 |
| §15 | T01–T34、R01–R22、S01–S14、统一验收证据 | 编号、原意、章节、阶段与状态完整 |
| §16 | P0-A/P0-B/P1/P2 实施门禁 | 是否按阶段拒绝未实现能力；P0-A 的模块顺序和退出门槛 |
| §17 | R5 修订、残余风险、停机门槛 | 文档修订不被冒充代码/运行 PASS |
| §18 | 用户确认与后续顺序 | 先 PoC、再 P0-A 规划、再单独授权正式开发 |

### Step 4 — 需求、技术设计和实现三方追踪

建立统一矩阵，至少包含：

`requirementId`、`sourceText`、`V0.6Section`、`designDecision`、`currentMainFiles`、`tests`、`PR14SecurityMapping`、`POCEvidence`、`designStatus`、`implementationStatus`、`evidenceTier`、`gap`、`owner`、`reentryGate`。

必须分开回答：
- **需求符合性**：V0.6 有没有忠实实现 V0.3？
- **设计完整性**：技术规范是否唯一、闭环、可实施？
- **代码实现状态**：当前 main 实际实现到哪里？
- **验证状态**：是否有真实运行证据？

不得将“设计覆盖”写成“代码已实现”，不得将“脚本/POC PASS”写成“真实宿主 PASS”。

### Step 5 — 历史反例和定向场景追踪

- R01–R22：逐项对照 V0.6 §15.2、相关 §3/§7/§8/§10；确认事故反例仍保留且有可执行验证入口。
- S01–S14：逐项对照 §15.2.3；确认 Host、P0-A、P0-B、P1/P2 的边界和真实证据要求。
- 不因 R5 独立审查称“设计修订已关闭”就把 R01–R22 测试状态改为 PASS。

### Step 6 — PR #14 Trusted Host V2 补充安全设计一致性

将 PR #14 的 TH-001–TH-030、SEC-01–SEC-19、NAT-01–NAT-15、F-01–F-07 作为**后续安全补充追踪**，不冒充 V0.3 原始 T 编号或 V0.6 的原始章节。

重点核对：
- Host/Model OS 主体、密钥、SQLite/WAL/SHM、进程句柄边界是否落实 V0.6 §7/§11。
- 最小安全拓扑是否保持 V0.6 的无强制 Server/监听器/MCP 原则。
- mTLS/Bridge 是否按实际部署可选，而不是无条件引入。
- 模型候选结果、真实工具事件、HostSubmission、CertifiedEvent、Receipt 的身份绑定是否一致。
- Outbox/Receipt 恢复是否符合 V0.6 §3/§7/§8 的原子提交语义。
- F-02/F-04 的待实测项不得改成 PASS；C12/S13/N 层不得用文档/CI 代替。

### Step 7 — 复核已有 Core POC 证据并冻结剩余差距

不重跑已通过的原型测试来“刷绿”。逐条核对 POC-01–09 和 POC-F01–F05：

| POC | 已有结果 | 下一步 |
|---|---|---|
| POC-01 | PARTIAL | 接入真实 FlowKit AST/Fields/Graph/Dataflow；真实 DSL → IR/JS；核对 Standard 对照和非法边 |
| POC-02 | 本地 PASS | 在目标 Node/OS 上复验真实 SQLite Genesis/CAS/Journal、事务回滚和持久性 |
| POC-03 | 9 个进程级断点 PASS | 补目标 OS/Node 矩阵和 Store 恢复；区分模型外部调用丢响应与纯本地崩溃 |
| POC-04 | 本地双进程 PASS | 在真实 Node/OS 矩阵复验竞争、历史 Receipt、丢响应和线性化读取 |
| POC-05 | PARTIAL | 验证 immutable artifact、Run retain、升级兼容矩阵、GC、备份/恢复和旧执行器保留 |
| POC-06 | PARTIAL | 真实 Host/Model OS 身份、私有 DB/Key/ExecutorContext/namespace ACL 负例 |
| POC-07 | Human BLOCKED / Admin PARTIAL | P0-A 只验证真实受权 adminTerminate；Human 属 P0-B，缺独立审批通道继续 BLOCKED |
| POC-08 | 完整矩阵 BLOCKED | Node 22.13.0/24.22.1 × Ubuntu 24.04/Windows 2025；TS 5.0.4；Standard 与包导出消费者回归 |
| POC-09 | PARTIAL | 用真实 P0-A Agent 重试、阶段预算、Checkpoint/Journal 测量 CAS、大小、耗时和写放大 |

额外 POC-F04：为 JCS/I-JSON 子集准备 RFC 8785 测试向量、重复键/Unicode/数字边界/首次 await 前快照测试。  
额外 POC-F03：真实 OS 安全主体、Dispatcher 单写者与 admin 通道验证；不把 P0-B Human/Action 语义提前带入 P0-A。

### Step 8 — 形成正式符合性审查报告与独立复审

报告至少包含：
1. 原件身份、完整 SHA-256、归档校验和源码基线。
2. V0.3 T01–T34 逐项矩阵。
3. V0.6 §§1–18 逐章审查。
4. R01–R22、S01–S14 追踪。
5. 当前 main 文件/测试实现映射。
6. PR #14 安全设计补充映射。
7. POC-01–09 与 POC-F01–F05 证据边界。
8. Findings（P0/P1/P2/P3）及可复现证据、最小修订、验收入口。
9. 未实现、阻断、延期和不在范围的事项。
10. Phase 2 收口裁决与 P0-A 规划准入建议。

先由本轮审查形成证据矩阵，再交 Grok Build 独立复核；不得让复审者只看摘要或只读上一轮结论。修订正式契约前必须取得用户确认。

## 3. 已确认 P0-A 实施计划核对与后续路线

### Step 9 — 定向 PoC 补验证（按依赖并行）

- 真实 FlowKit 前端/IR PoC（POC-01）：优先。
- SQLite/Node/Windows/Ubuntu/跨进程持久性矩阵（POC-02/03/04/08）。
- Host OS 身份、私有 Store/Key/句柄和 admin 安全负例（POC-06/07；与 PR14 H3-01/H3-05 对齐）。
- JCS 规范向量与严格 JSON（POC-F04）。
- 代表性 Agent 重试、预算和写放大（POC-09）。
- Registry/Retain/升级/恢复（POC-05）。

每个补验证保留源 Commit、Program Hash、Node/OS 版本、命令、原始日志和 PASS/PARTIAL/FAIL/BLOCKED；不能用 Linux 结果代替 Windows，也不能用 POC 代替生产实现。

### Step 10 — 核对已确认 P0-A 实施计划 V0.1 与当前 M1–M5

不是重新制定已确认的计划。对照 `01-P0A-IMPLEMENTATION-PLAN-V0.1-CONFIRMED.md`、`00-APPROVAL-RECORD.md` 和当前 M1–M5 源码/PR/CI，映射 31 项任务，记录已实现、已验收、缺口与 M6 尾项；只产生差异台账与有证据的补充执行计划。依据 V0.6 §16.1/§16.2 核对：
- 模块/文件级范围与依赖图。
- Frontend/Feature Gate/Resumable IR/IR Validator/JS Emitter。
- Loader/同字节验证/ProgramRegistry/retain。
- Canonical JSON/JCS/Checkpoint/Coordinator/Transition Journal/Receipt。
- SQLite 参考 Store 适配器及五操作事务契约。
- Host Runtime Binding/PublicTask/TrustedExecutorContext/HostSubmission/单 Dispatcher。
- Trusted Host OS 权限、adminTerminate 和模型候选输入通道。
- types、package exports、Standard 回归、集成/故障注入测试。
- 每项关联 T/R/S/POC/TH/SEC/NAT、风险、回滚和退出标准。

**V0.6 §16 的 P0-A 范围**：共享 DSL 分析、Resumable IR、真实 JS Program ABI、可信 Registry/Store/Journal/Receipt、Condition/Terminal/基本 Agent（Skill + 同步纯 validateResult + 默认重试）、compileInteractive/start/complete/resume、受权 adminTerminate、namespace/结果投影和跨进程恢复。Action、独立 Verification、Human、Loop、Parallel 和 Agent 非纯 checkStep/verify 必须拒绝，不能提前开放。

### Step 11 — 对尚未完成的 M6/Host 工作执行独立变更门禁

- 已合并 M1–M5 不重复开发；只针对真实差异或未关闭的 M6/Host 工作实施独立改动，精确说明影响的正式要求。
- 新增生产 Core/ABI/Schema 或改变被冻结语义，必须经过具体变更方案及用户批准；纯审查与测试不会扩大授权。
- 尚未完成的 Host 隔离、模型来源、M6 原生工具调用只能按相应阶段和证据门禁实施。
- 每个阶段先跑本地针对测试，再跑四平台/Node CI，再独立复审。
- 每个 PR 只解决已确认范围；任何 ABI/Schema/语义变化先走变更审查。
- P0-A 退出：T01–T14 中 A/Host、T29/T30/T34-A、S01–S07、S12-A、S14 的适用项有真实证据；Standard 全量回归通过；真实 JS Host 工具能力如不支持则明确 BLOCKED，不伪装完成。

### Step 12 — P0-B 顺序节点

实现 Agent 完整 checkStep/verify、Action/operationId/reconcile、普通 Verification、可信 Human 修订前缀、Loop、业务 cancel、可信 contextError/Trace。验收 T15–T23、T31–T33、S08–S12；Human 缺少独立可信审批通道时仍 BLOCKED。

### Step 13 — P1 Parallel all_succeeded

实施前另行冻结 fail-fast/outstanding、分支迟到结果、State 写集合冲突与 Join 语义。通过 T24/T26 和 P1 专项测试后才可进入。

### Step 14 — P2 Parallel any

T25 的赢家选择、未完成分支、迟到副作用、下游状态可见性必须重新形成独立设计并由用户确认。不得复用未经批准的 settle-outstanding 草案。

### Step 15 — 全量兼容、真实宿主与正式交付

按 T27/T28/T33/T34、S13/S14、PR14 C01–C24 和安全矩阵核验：
- Codex/Grok/Claude/ChatGPT 只有真实 JS/Node 工具路径才算宿主接入。
- Standard/Interactive 有意差异透明。
- Node/OS/TS/包导出/类型/文档/性能/安全回归完整。
- C12/S13 必须有真实原生工具、来源绑定和 Host 安全证据。
- 发布/部署另行授权，不因 P0-A/P0-B 完成自动进行。

## 4. 统一状态和停机规则

每条矩阵只能使用：
- `PASS`：有精确源码/原文和可复现运行证据。
- `GAP`：设计或实现缺项，尚不一定构成冲突。
- `CONFLICT`：与更高优先级已确认契约冲突。
- `NOT-IMPLEMENTED`：设计存在但当前生产代码没有实现。
- `PARTIAL`：仅部分路径或平台有证据。
- `BLOCKED`：缺少必要工具/平台/信任来源或测试环境。
- `DEFERRED`：由已确认阶段边界推迟到 P0-B/P1/P2。

最终只有在 T01–T34、V0.6 §§1–18、R01–R22、S01–S14、当前 main 和 PR14 安全补充均完成交叉追踪、重大 Findings 收敛并通过独立复审后，才可将正式契约符合性标为 PASS。

**本计划不改变 V0.3/V0.6-R5，也不自动授权新的生产语义开发。** V0.6 §18 约定的前期计划阶段已完成：2026-11-10 有用户确认的 P0-A V0.1 实施计划，后续 M1–M5 已进入当前 main。本轮只评估已有成果与未关闭的 M6/Host 工作，不重开已完成里程碑。
