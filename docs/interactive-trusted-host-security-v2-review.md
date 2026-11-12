# FlowKit Interactive — Trusted Host V2 阶段 2 定向安全复审记录

**2026-11-11；性质：Grok Build 独立审查者已完成三轮定向复核。** 本文同时记录作者侧的源码/规范交叉核验；不将作者自审冒充外部审查，也不将 Grok 模型复审冒充第三方专业安全认证。Phase 2 整体仍为 CONDITIONAL，F-02/F-04/F-07 的后续门禁未关闭。

**固定对照源码：** `main@9bac8f86347a405efe068f96423ae3e501005061`。**审查对象：** 本分支三份 Draft 设计文件。

## 1. 源码及产品事实交叉核对

| 事实/限制 | 直接证据 | 结论 |
|---|---|---|
| Core 不提供 Agent Provider 客户端，Host 管理 Coordinator | `src/interactive/coordinator.mjs` | 不引入第二 Runtime |
| M5 默认 Host-only signer 和独立数据披露 | `src/interactive/trusted-host.mjs` / `docs/interactive-host-security.md` | 保留 v1 签名契约 |
| v1 statement 有 `proofId`、`receiptHash` 及 Run/Program/Policy identity | `src/interactive/host-attestation.mjs` | 以 Host-only proofId 外部证据索引实现来源绑定，不新增签名字段 |
| M3 Store 按 namespace 隔离，WAL/FULL、transactional CAS | `src/interactive/sqlite-store.mjs` | 不重做 N5；需独立 OS 文件权限 |
| 终态 Host frame 包含完整 State | `src/interactive/coordinator.mjs` | 模型公共结果不能直接使用 Host frame |
| M6 scripted worker 与原生模型不是同一证据 | `tests/integration/m6-worker.mjs` 和 Grok 验收报告 | CI 不能宣称原生 C12/S13 PASS |
| Linux nobody 隔离已有真实脚本证明 | `tests/security/host-isolation.mjs` | Windows ACL / 真实 Grok 仍需补证据 |
| Windows Named Pipe 有默认安全描述符风险 | 微软 CreateNamedPipeW/Named Pipe Security 官方文档 | 优先跨平台 loopback mTLS；Pipe 只作条件替代 |
| Grok Build headless 有结构化工具事件 | xAI Grok Build streaming-json 官方文档 | 需宿主独立观测，不能把 JSON 的 signature 字段当 Provider 级证明 |

## 2. 对抗性 Finding 逐项验证

| ID | 严重性 | 初始发现 | 修订动作 | 当前状态 |
|---|---|---|---|---|
| DR-01 | P1（设计阶段） | 如果让 MODEL_USER 的工具持有 mTLS client key，任何同权限脚本都可冒充受信 Bridge | 增加 §3.2.1 双跳通道：模型仅交候选 JSON，受保护 Bridge 才持 client key，Host 验证独立 `tool_call` 事件 | **设计已关闭；SEC-06/TH-027 待实测** |
| DR-02 | P1（设计阶段） | 若 Host 等待 `submit` 的工具完成事件才签名，而工具等待 Host 结果，会死锁 | §5.3 冻结签名前的 `tool_call` 起始事件+输入摘要关联；签后事件仅用于审计；事件时序不支持时标 BLOCKED 并另审双阶段协议 | **设计已关闭；NAT-14/TH-028 待实测** |
| DR-03 | P1（验收边界） | mTLS、Host 自签 Ed25519 与 Provider 签名三个层次容易被混算 | 定义 P/M/T/N/V 五种证据等级；缺可验证来源不得通过 C12/S13 | **设计已关闭；原生证据待实测** |
| DR-04 | P1（平台安全） | Windows `net.createServer` 没有给出经验证的受控 Pipe DACL/Peer SID | 默认选 Host-owned loopback mTLS；Pipe 必须走独立 Win32 安全说明和负例 | **设计已关闭；Windows 实测待 Phase 3** |
| DR-05 | P1（权限） | 用户的 Grok Build 可能在管理员 Windows session 中运行 | Secure mode 强制非 admin MODEL_USER 和独立 HOST_USER；否则 BLOCKED | **设计已关闭；Windows 身份实测待 Phase 3** |
| DR-06 | P1（签名来源） | Host 只要调用 `createAgentReceiptStatement` 就能签任意 JSON，容易产生认证洗白 | Host-only `proofId→session evidence` 绑定，签名必须后于可验证工具事件，所有不匹配请求零 CAS | **设计已关闭；TH-010/NAT-06 待实测** |
| DR-07 | P1（秘密泄露） | `asPublicFrame` 终态包含完整 State，不可直接转发模型 | Adapter `continuePublic` 返回脱敏 terminal；`readPrivateResult` 只能是 Host/User 控制面 | **设计已关闭；SEC-11 待实测** |
| DR-08 | P2 | Windows Hosted Runner 不能直接继承 Linux UID 证明 | SEC-WIN 独立账户/ACL、Host service control 与真实文件/进程操作负例，缺条件 BLOCKED | **设计已关闭；需专用 Windows 安全测试环境** |
| DR-09 | P2 | CLI `usage.signature` 字段不具备已确认的 Provider 验签契约 | Provider 等级 V 的判断单独进行，任何非正式机制只能提供 HOST_OBSERVED | **设计已关闭；NAT-13 待核验** |
| DR-10 | P2 | 可能把 Human/Action/Parallel 越界引入 P0-A | Bridge v1 仅 Agent result；Human 未有真实渠道时只拒绝并延期 P0-B | **设计已关闭；TH-025 回归** |
| DR-11 | P2 | 只封 DB 主文件，不封 WAL/SHM、日志和备份 | 将 WAL/SHM/证据/backup/Service control/进程句柄列入 OS 负例 | **设计已关闭；SEC-03/04/13 待实测** |
| DR-12 | P2 | Provider 模型调用可能重复，避免误称 exactly-once | 只承诺 CAS 有效状态至多一次；由 Host 处理供应商调用幂等/对账 | **设计已关闭；NAT-08/09 待实测** |

| DR-13 | P1（持久恢复） | Host 已签回执、尚未接纳就 SIGKILL；签名超期后可能丢失原始证明或误签编造结果 | §6.4 增加 Host-only OBSERVED/SIGNED/ACKED Outbox、签后持久化再 accept、过期未接纳 fail closed、严格原事件重证 | **设计已关闭；TH-029/SEC-18/NAT-15 待实测** |
| DR-14 | P2（容量/隐私） | 原生会话事件和签名 Outbox 可能永久堆积或记录敏感 State | Host-only 审计只保存必要证据与摘要；保留窗口和容量在 Phase 3 配置并测试 | **设计已关闭；TH-030/SEC-19 待实测** |

| DR-15 | P1（信任边界一致性） | 如果 Bridge 与 Host 同用 HOST_USER，不能同时宣称 Bridge 在 OS 层无权读取 Host signer/SQLite | 明确 Bridge+Host 同权时是一个可信计算基（TCB），只能声明 MODEL_USER 被隔离；需要 Host 对 Bridge 的再隔离时必须使用独立 BRIDGE_USER 及真实 ACL/UID | **设计已关闭；SEC-01/02/05/06 待实测** |

## 3. 设计冻结所需的可核对不变式

- [x] 现有 M5 Ed25519 Statement V1 不变；新增来源证据采用独立 Host-only ledger。
- [x] Host signer、Coordinator、SQLite、完整 State 不向模型公开。
- [x] Windows/Linux 身份隔离要求有实际系统权限失败/拒绝证据。
- [x] Windows 默认 Named Pipe 不会被直接认定为安全。
- [x] 直接 Grok Build 优先；ACP 不是前置条件。
- [x] 同权 Developer Mode 只计 P/M，不计 N。
- [x] 冻结了 tool_call start 与 Host 签名之间的时序；存在反例 NAT-14。
- [x] 签后、accept CAS 前崩溃和过期回执具备 Host-only Outbox/对账设计及 NAT-15 反例。
- [x] 30 个 TH Threat、19 个 SEC OS/IPC 用例与 NAT-01..NAT-15 均已列出（NAT-14 为事件时序，NAT-15 为签名 Outbox 恢复）。
- [x] 对比 P0-A / P0-B / P1 / P2，未在安全设计中偷加 Action/Human/Parallel 能力。
- [ ] 外部审查者重新核查 Provider/source provenance 能否满足冻结 C12/S13 条件。
- [ ] Phase 3 的 Windows Host 用户/服务 SID/ACL/mTLS 真实负例 PASS。
- [ ] Phase 4 Grok CLI 的 native JS Tool loop、`tool_call` 起始事件时序、普通脚本伪造攻击负例 PASS。

最后三项是**实施/独立验证门禁**，不是可用文档编写替代的事项。

## 4. 对 Stage 0/1 追踪状态的纠正

代码层存在的 N1/N3/N5/N7/N8/N9/N10/N11/N12 **不能因为历史设计 Finding 仍在列表里而重写**。它们只需对照冻结需求补足对应负例。N6 跨 SDK 版本兼容仍未实测；N2/N4/N13 由 P0-B 接手。其他 T/S/C 项继续使用完整路线与各自冻结矩阵，当前设计 PR 不会删除或合并它们的状态。

## 5. 本轮复审裁决

**自审结论：有条件通过设计方向；0 个尚未写出控制措施的新 P0/P1 设计 Finding。**

**不是外部独立审查通过。** 由于当前执行环境无法代替用户本地的 Windows 服务账户和 Grok Build 会话，Phase 3 的真实安全证明、Phase 4 的原生事件序列均未执行。必须保留 BLOCKED，不得将文档 CI PASS 写成安全验收 PASS。

**建议：** 保持文档设计 PR Draft，独立审查时按 DR-01..15、TH-001..030、SEC/NAT 矩阵逐项核对。若没有实质性新设计 Finding，可正式确认本设计并开始 Phase 3；如发现信任域或工具事件顺序不可实现，必须先修正本设计再实施，禁止绕开门禁。


## 6. Grok 独立复审 F-01–F-07 的逐条核验（2026-11-11）

**外部材料：** `FlowKit-PR14-Trusted-Host-V2-Independent-Security-Review-Grok.md`（对 PR #14 frozen head `d1c7c76d03780f04a5b761699cdbc9ac82f0b86c` 的只读审查，结论 `CONDITIONAL PASS`）。本小节是后续交叉核验，**不是替代 Grok 初审的新第三方意见**。

| Finding | 独立交叉核验 | 处理结果及剩余门禁 |
|---|---|---|
| F-01 P1 | **确认。** 旧 §9 同时要求先验证 Grok 工具和把它放到 Phase 4，门禁冲突。 | 主设计 §9.1、路线图 Phase 3 改成唯一入口/退出规则；H3-02 工具能力探针先于通信代码，原生 C12/S13 仍 Blocked。 |
| F-02 P1 | **核心缺口确认，Grok 的“只有 Shell/MCP”和“rawInput 必须逐字节包含全部 normalizedReceipt”不是已证实的硬事实。** 官方 Grok Build 支持通过 MCP 扩展工具；`--tools` 本身仅为内置工具 allowlist。 | 主设计 §5.5 冻结优先 MCP PoC、受信配置及两条摘要：rawInput→toolInputDigest、Host 当前 Pending+参数→receiptHash；在 NAT-14/Grok 实测之前 H3-02 不能投入生产。 |
| F-03 P2 | **确认。** TH-017/023 为 P1，却对齐 SEC-11/04 的 P0。 | 威胁表升级至 P0；TH-028 保留 P1（协议活性而非 P0 越权），但 NAT-14 作为 Phase 4 强制阻断门禁，不得延期放行。 |
| F-04 P2 | **确认机制风险，非跨账户实测。** Windows 句柄继承保留权限；报告只做同用户 fd 探针。 | 主设计、SEC-02/03 增加真正继承句柄表/子进程非授权访问负例；Windows 跨 SID 攻击实测仍 BLOCKED。 |
| F-05 P2 | **官方规则确认，具体 Node SDDL 未独立复现。** 微软说明默认 Named Pipe DACL 给 Everyone/Anonymous 读取，Node 公开选项未提供可指定 SDDL 的安全接口。 | 默认 Node Named Pipe 明确禁止安全 IPC；仅创建时自定义 DACL+SID 的 Win32 引导经验证后可选，或采用受信的本机传输。 |
| F-06 P2 | **确认。** C12 交叉索引缺行、Grok requestId 与 FlowKit requestId 混用风险、Outbox 正文摘要未冻结。 | 验收矩阵补 C12，增加独立 `flowkitRequestId/grokRequestId/grokSessionId/toolCallId`；重签仅对 Outbox 保存的同一 normalizedReceipt canonical bytes/proofId 和当前 Pending 重新核证。 |
| F-07 P2 | **可访问性缺口确认。** 既有会话曾给出 V0.3/V0.6-R5 历史生成路径，但此 PR、当前文件库和工作环境未找到可复核原件。不能推断文件从未存在。 | 从 PR 中移除“已有可核验正式契约”暗示；要求补原文不可变定位和完整 SHA-256 后才可裁决正式契约符合性，当前 BLOCKED。 |

**额外核验说明**：Grok 本地 Node 默认管道 DACL 与同用户句柄实验没有提供可独立执行的原始脚本/日志；本交叉复审仅采用 Windows 官方文档所证明的权限机制，不冒充已在用户电脑复现。Grok Build MCP 支持来自官方用户指南，但尚未执行 `grok -p` 的 NAT-14 工具时序实测。

**当前裁决：** 七项均已登记修订；F-01/03/05/06 的文档矛盾已修正；F-02/04 的设计控制已定义但关键平台实测仍缺；F-07 缺正式原文仍 BLOCKED。PR #14 继续 Draft，**不得以文档 CI 通过替代 Phase 2 的修订段落独立复核，也不得进入 Phase 3 的受信通信实现**。

后续：让 Grok Build **只复审本轮修订 diff**、官方 MCP/工具事件时序前置条件与 F-07 原件可访问性；无新实质性设计 Finding 且正式契约可核验后方可关闭 Phase 2。Phase 3/4 的运行证据在其阶段分别取得。

- [Microsoft: Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft: process handle inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/inheritance)
- [Grok Build: MCP server configuration](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/07-mcp-servers.md)
- [Grok Build: headless events and `--tools`](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)

## 7. Grok Build 第二轮定向复审与追加闭环

**原始报告：** `FlowKit-PR14-Trusted-Host-V2-F01-F07-Targeted-Rereview-Grok.md`；本轮上传文件 SHA-256：`4528278eddb1ade36c8a388c4ad4181f93f8d364a323ca54b0a4c19ea4ee3062`；Grok 核对冻结 HEAD `51a759975abcaee928faf50aec99ebed324fdfcc`，只读裁决 **CONDITIONAL PASS**。本节是事后的针对性代码/文档交叉验证记录，不能冒充 Grok 对新提交的再审 PASS。

### 7.1 外部复审裁决（冻结旧 SHA，不能倒填）

| Finding | Grok 二轮结论 | 独立交叉核对 | 这次修订 | 后续边界 |
|---|---|---|---|---|
| F-01 P1 | PARTIAL | 原 `H3-05→H3-04→H3-03→H3-02`，H3-02 却引用 Phase 4 NAT-14，确有依赖环 | 把 H3-05 移到 H3-01 后、只依赖 H3-01；H3-02 改为独立「工具注册与签前 tool_call 最小能力探针」，**不是 NAT-14**；H3-04 负责集成后全量安全测试，Phase 4 正式 NAT-14 不提前记 PASS | 本次改动需定向 diff 复核，真实 PoC/NAT-14 仍未运行 |
| F-02 P1 | PARTIAL | Grok MCP 工具已具官方扩展机制，但 tool_call.rawInput flush/参数一致性/大值仍未实测 | 维持 §5.5 的候选工具探针与 `toolInputDigest` / `receiptHash` 双哈希规则；没有把 PoC 伪装成成功 | H3-02 实现 BLOCKED，直到可复现小型工具能力探针；C12/S13 仍 BLOCKED |
| F-03 P2 | CLOSED | TH-017/TH-023 与 SEC-11/SEC-04 P0 已对齐 | 不重做 | Phase 3 实际 OS 安全证明未完成 |
| F-04 P2 | PARTIAL | Grok 测到 Node 同用户继承的 fd 可被子进程读取；**没有跨 OS 身份实测** | 保留句柄白名单和跨用户负例 | Phase 3 SEC-02/SEC-03 仍 BLOCKED |
| F-05 P2 | CLOSED | Windows 官方默认 Named Pipe 赋予 Everyone/Anonymous 读取权；报告称 Node 22/24 实测 SDDL，但未提供原始脚本文件 | 保留禁止默认 Node Pipe，安全 Pipe 必须创建时自定义 DACL+SID | SEC-16 仅采用 Named Pipe 时适用，未跑 Win32 实测 |
| F-06 P2 | CLOSED | C12 映射、flowkitRequestId 与 grokRequestId、Outbox canonical bytes 和 receiptHash 规则已存在 | 不重写 Core 或重新序列化签名业务正文 | 真实签后崩溃 SEC-18/NAT-15 未运行 |
| F-07 P2 | NOT_VERIFIABLE | 历史存档存在正式原件的名称与沙箱路径记录，但本次原始字节不可用；不能据此说文件从不存在 | 保留正式契约 V0.3/V0.6-R5 的符合性 **BLOCKED** | 完成符合性裁决仍需正式原文和完整 SHA-256，不得由路线图或审查报告代替 |
| F-R2-01 P2 | 新 Finding | §3.2 说本地端点可选，§7 Profile 与 §10 总结又把 mTLS 当默认，且 SEC-05/07 会暗示必须创建监听器 | §7 Windows/Linux Profile 和最终结论都改为两 OS 身份、Key/DB/句柄保护必选，**mTLS/独立 Bridge/监听端口按实际部署可选**；SEC-05 验证真正的候选入口，SEC-07 无监听时记 N/A—NO_LISTENER 而非 PASS | 本次设计修订需 diff 复核；没有网络端点不能免除模型输入权限验证 |

### 7.2 单向阶段依赖检查（不得出现旧循环）

```text
Phase 2 design review
       |
H3-01 Host OS identity & secrets isolation
       |
H3-05 OS-only security negatives          <-- only H3-01; no Grok tool dependency
       |                               |                         Grok tool capability probe (no NAT-14 PASS)
       |                                     |
       |                                   H3-02 ingress/tool adapter
       |                                     |
       |                                   H3-03 evidence/Outbox
       |                                     |
       +-----------------------------------H3-04 signer + integration security checks
                                             |
                                Phase 3 OS/IPC security exit (Win + Linux)
                                             |
                                Phase 4 native Grok, formal NAT-14/S13/C12
```

**范围纪律：** 本次仅文档修订，没有触碰 Program ABI、Ed25519 receipt v1、Coordinator、Store 或其他生产 Core。CI 全绿只证明现有回归没受影响，**不证明**跨用户 Windows ACL、Grok 原生事件时序、Provider 身份或 Phase 3/4 执行完成。

**下一步判停：** 本轮 F-01/F-R2-01 的段落修订无新 P0/P1 Finding 后，可认为**这两项设计矛盾**在文档层关闭；但 F-02 的工具能力、F-04 的跨账户隔离和 F-07 的正式契约证据均必须保持原有状态。PR #14 继续 Draft，不因文档回归或作者自审直接合并。



## 8. Grok Build 第三轮最终定向复核（F-01 / F-R2-01）

**外部报告：** `FlowKit-PR14-F01-FR2-01-Final-Targeted-Review-Grok.md`，SHA-256 `7936d6cef9d3c26f5870eb2303fe52c6f215487e740c1fa57787e06716c67933`。审查者为前两轮同一 Grok Build 独立审查者；只读核对冻结 HEAD `316e426aa8d96e4a6b6bee8afd35c0cd313fd244`。裁决：F-01、F-R2-01 **CLOSED（设计文档层面）**；不表示 Phase 3/4 安全验收完成。

| 复核项 | Grok 最终裁决 | 本项目核验 | 后续状态 |
|---|---|---|---|
| F-01 阶段依赖 | CLOSED | H3-05 仅依赖 H3-01；H3-02 使用独立能力 PoC，不将其冒充 NAT-14；H3-04 负责接入/签名/恢复集成验证；正式 NAT-14 在 Phase 4 | PoC、SEC 与 NAT-14 真实执行仍待后续阶段 |
| F-R2-01 IPC Profile | CLOSED | Secure Windows/Linux 最小 Profile 不强制 mTLS、TCP listener 或独立 Bridge；SEC-05 始终验证真实候选输入路径；SEC-07 仅监听型 TLS/mTLS 存在时强制 | Windows/Linux 两个 Profile 仍需真实权限测试 |
| F-02 | PARTIAL | Grok 原生 MCP tool_call 起始事件、rawInput 对照、截断/大输入仍未实测 | H3-02/NAT-14 BLOCKED，直到真实能力探针与后续验收 |
| F-04 | PARTIAL | 继承句柄机制有 Node POC，但没有 Windows 跨 SID/服务 Token 的真实负例 | Phase 3 SEC-02/03 BLOCKED |
| F-07 | NOT_VERIFIABLE | 正式 V0.3/V0.6-R5 原文和完整 SHA-256 未获得 | 正式契约符合性继续 BLOCKED |

**本轮额外文档对齐：** Grok 指出 Windows 检查表中“无证书访问 loopback”和“受保护 Bridge client 合法访问”两步未明确限定部署条件。虽然 SEC-05/SEC-07 与 §9.1 已经规定无监听路径，但为避免执行者误解，已把威胁模型第 3 节第 6–7 项改为条件步骤：无监听记录 `N/A—NO_LISTENER` 并验证 SEC-05；无独立 Bridge 记录 `N/A—NO_SEPARATE_BRIDGE` 并验证 SEC-05/06。该修订属于文档一致性收尾，不改变安全要求、不创建新监听端点，也不降低实际候选入口的验证要求。

**裁决边界：** 本轮关闭的是 F-01 与 F-R2-01 的设计矛盾。PR #14 仍是 docs-only 设计记录；F-02/F-04/F-07 不得改成 PASS。CI 只证明既有回归，不能证明 Windows Secure Host、Grok 原生来源、C12/S13 或正式契约符合性。是否合并 PR #14 应由用户在确认其作为“带明确 BLOCKED 限制的设计记录”后决定；合并也不自动授权 Phase 3 实施。



## 9. PR #14 merge gate and remaining limitations

- The final design review remains documentation-only. GitHub Actions run `43096045021` for HEAD `b9d0c1efe17c386f798e30b4331f7bd90a1936e3` remained queued with zero jobs created for several hours; this is not a PASS or FAIL test result. GitHub Status reported an Actions/Pages/Copilot incident on 2026-11-11 20:48–21:21 UTC, now resolved. The last fully successful regression run is `43045141302` for prior docs-only HEAD `316e426aa8d96e4a6b6bee8afd35c0cd313fd244`. A fresh exact-HEAD PR run is required before the authorized squash merge. No production source changed between those two heads; the intervening changes are documentation only. Do not merge based on a queued run.
