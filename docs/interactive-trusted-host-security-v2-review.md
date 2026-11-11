# FlowKit Interactive — Trusted Host V2 阶段 2 定向安全复审记录

**2026-11-11；性质：作者之外不可替代的外部独立复审仍待执行。** 本文为当前 ChatGPT 的有界对抗性自审与源码/规范交叉核验，**不冒充 Grok Bot 或 Dot 的独立复审**。

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
