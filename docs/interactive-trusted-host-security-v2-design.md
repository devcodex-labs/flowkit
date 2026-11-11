# FlowKit Interactive — Trusted Host V2 安全与原生 Grok Build 桥接设计（Draft）

> **阶段：Phase 2 / Design only。2026-11-11。**
>
> **设计基线：** `main@9bac8f86347a405efe068f96423ae3e501005061`；已批准的 Interactive V0.3 需求与 V0.6-R5 技术设计；M5 安全契约 [interactive-host-security.md](./interactive-host-security.md)；M6 完整路线 [full-delivery-roadmap](./interactive-full-delivery-roadmap-2026-11-11.md)。
>
> **状态：待针对性安全复审，不是已实现功能。** 本文没有批准修改 Core、Program ABI、SQLite Schema 或现有 SDK 导出。发现需求/安全契约冲突时必须先处理差异。
>
> **目标宿主：** Grok Build 首选，未来 ChatGPT / Codex / Claude Code 使用同一个宿主中立协议。直接 Grok Build 为首选；ACP 不是强制依赖。

## 0. 结论与范围

### 0.1 最终设计方向

1. **保留现有 FlowKit Core**：Compiler、签名后的不可变 JS Program、`createInteractiveCoordinator`、SQLite WAL/FULL/CAS、Journal 与历史 Ack 不重写。
2. **保留 M5 协议**：`createTrustedInteractiveHost`、`getPublicAgentTask`、`accept({receipt,attestation})`、`createAgentReceiptStatement` 与 Ed25519 v1 canonical statement 不改变。
3. **新增边界属于 Host Adapter / Deployment，而非 FlowKit Runtime**：受保护的 Host 进程/账户、信任配置、密钥与数据库访问控制、受限 IPC、会话与模型输出观测证据、原生 JS 工具桥接。
4. **将三个概念分开**：OS 隔离、Host 独立观测的来源/工具调用、Provider 级可验证身份。任何一项不能靠另外两项替代。
5. **先安全验证、再对接真实 Grok**：不允许 Grok 在能读取 Host 私钥、数据库或 Coordinator 的同权身份下充当安全验收主体。
6. **不创建通用 Agent Runtime**：Host 是否作为受保护按需进程或服务运行，是部署适配层的生命周期问题。Core 不依赖常驻 Server。
7. **不扩张 P0-A**：Human/Action/Verification/Loop/Parallel/通用上下文、业务产物持久化、GC、Provider exactly-once 均不在本轮实现。

### 0.2 威胁模型与资产

**受保护资产：**
- Host Ed25519 私钥 / KMS 授权；
- Host-owned SQLite 主文件、`-wal`、`-shm`、Checkpoint、Journal、receipt index；
- Program 不可变字节、可信构建清单与 artifact allowlist；
- Host policy/binding versions、tenant namespace、完整 State 和敏感业务输入；
- Host-only provider/session/tool-call 观察记录、审计密钥、IPC 认证凭据；
- 持久化的 Run / Request / attempt 绑定和历史 Ack。

**不可信主体：**
- Grok Build 的模型推理、可控工具调用/终端脚本；
- prompt-injected Skill、工作流任务描述、模型生成的 JSON、文件内容和第三方远程资源；
- 共享电脑上的其他普通用户/进程；
- 会被模型触及的工作区、用户家目录、宿主的 shell 工具。

**信任边界：** OS Token/SID/UID → Host Private FS → 可信执行器 → 受保护 IPC → Host signing → `accept` → SQLite CAS。流程描述和 JS API 包装 **均不是** OS 沙箱。

**明确不覆盖的威胁：** 已取得管理员/root、内核权限或可控制 Host 签名进程的攻击者；受信 Host 本身被恶意代码替换；Provider 服务端被攻破。这些属于部署根信任或事件响应范畴。若 Grok Build 进程实际拥有可随时提升到管理员的权限，则不能称为隔离通过。

## 1. 现有源码与已验证事实

| 组件 | 现状 | 证据 | 设计动作 |
|---|---|---|---|
| Compiler / Program | 产物 Hash、静态 ProgramTable、verified byte loader、零 import 校验 | `src/interactive/compile.mjs`、`src/interactive/load.mjs` | 复用；禁止模型控制 artifact allowlist |
| Coordinator | 只由 Host 执行、决定状态与路由、持久化 CAS | `src/interactive/coordinator.mjs` | 不新增模型侧可写入口 |
| Store | Namespace、SQLite WAL/FULL、Journal、历史回执索引 | `src/interactive/sqlite-store.mjs` | Store 由独立 Host 账户拥有，连 WAL/SHM 一起隔离 |
| Trusted Host M5 | `allowedInputKeys` + `authorizeDisclosure`，签名先验证后 CAS | `src/interactive/trusted-host.mjs` | 只在信任域内使用；公共工具不返回原始 Host frame |
| Receipt V1 | 已签字段包含 namespace/run/request/node/attempt/receiptHash/program/policy/proofId/times | `src/interactive/host-attestation.mjs` | **不增加**新签名字段；session evidence 通过独立 Host-only `proofId` 索引绑定 |
| Linux OS 隔离 | 真 Node `nobody` 子进程不能读取 Host 私钥/SQLite | `tests/security/host-isolation.mjs`；main CI | 已存在，只需扩展到实际原生模型 |
| M6 scripted Host | 独立 Host 与 scripted worker；projectRoot 兼容修复后主 CI 通过 | PR #13、main `9bac8f8` | 不冒充模型/来源证明 |
| Grok 实测 | 15 个真实模型结果经文件 Harness → Host；Windows 同权信任边界无有效证明 | 2026-11-11 Grok 验收报告 | M 层部分成功；C12/S13 N 层仍 BLOCKED |

### 1.1 历史 Finding 不重复开发

- **N1** 确定性 FK_R002、FK_I_VALIDATOR_CONTRACT → errored：源码与测试存在，实施前只做门禁复核。
- **N3** Program ABI/ProgramTable、静态合法转移：源码与 TypeScript 定义存在，不新增第二套解析器。
- **N5** namespace 主键及 startKey 唯一索引：SQLite Store 已实现并有跨租户测试，不重复建租户系统；Host 进程权限仍需验证。
- **N7** P0-A 终态 State 在 Host frame 已可读取；`contextError` 的 P0-B 扩展仍待实现。**不要将原 N7 全量误判为缺失。**
- **N8/N9/N10/N11**：零 import、只允许 P0-A Stage、package exports、Agent Pending name/overview 已有源码路径与测试，核查而非重做。
- **N6**：不可变 Program 字节已持久化，但**跨 SDK 版本升级 + 在途运行**专门实验尚未覆盖；保留既定阶段。
- **N12**：现有 `stableTransitionId` 为确定性；P0-B Action operationId/reconcile 和 P1 并行冲突尚未实现。
- **N2/N4/N13**：按既定 P0-B 门禁保留。Human provenance 不能由当前模型提交 Agent 回执代替。

## 2. 目标部署拓扑

```text
UNTRUSTED Grok Build / Codex / Claude / ChatGPT
  model + ordinary tool/shell permissions
  OS principal: MODEL_USER (no admin/root)
        |
        | Native JS tool: only permitted operation + bounded task/result
        v
MODEL-FACING BRIDGE (least privilege)
  explicit allowlist, schema/size/auth checks
  cannot read signing key, SQLite or Coordinator
        |
        | authenticated, local-only transport
        v
TRUSTED HOST ADAPTER / SUPERVISOR (HOST_USER)
  approved immutable Program manifest + Host policy
  session/tool/provider observation ledger owned by HOST_USER
  bounded reconciliation + per-run ownership/authorization
  --- private trust boundary ---
  createTrustedInteractiveHost()
  generate/validate signed v1 Host receipt
  createSqliteCheckpointStore() -> WAL / FULL / CAS
        |
        v
durable next Pending / Terminal
```

**Control plane vs data plane**

- `start`/bootstrap (Program approval, initial State, tenant, policy) **仅由可信用户/Host 控制面**发起。
- 模型数据面可见的只有 `getCurrentPublicTask`、`submitAgentResult`、`continuePublic` 等**适配层操作**。这只是拟议命名，不是新增到 SDK 的 API；最终应复用现有 `getPublicAgentTask` 和 `accept`。
- `resumePublic` 是要求 Host 根据已认证 Run 重算并返回脱敏公共视图，不开放未经授权的原始 `resume`。
- 现有 `InteractiveRunFrame` 是 **Host-visible**，终态可以含 `state`，绝不能无过滤转发给 Grok。模型可见终态仅含 status/terminal/可公开摘要。
- 业务正式输出由用户/Host 的专用读取能力获取；任何该能力都不能被模型工具直接调用。
- Host 的签名输入来自 Host **独立观察**的结果/事件，不来自模型要求“给这个 JSON 签名”。

## 3. Windows：可落地的安全部署方案

### 3.1 安全身份

推荐：
1. 安装时创建或选择独立 **HOST_USER**（例如受限 Windows Service SID/专用服务账户），Host 在该 Token 下运行。
2. Grok Build 运行在普通、非管理员 **MODEL_USER**；其用户及工具子进程对 HOST_USER 私有资源必须没有访问权。
3. 私有 Store 和签名密钥放在 Host 专有目录（例如 ProgramData 下的专有子树），通过显式 DACL/Owner 控制；**检查主 DB、WAL、SHM、备份/日志、产物、配置和目录本身**。
4. Host 服务控制权限必须防止 MODEL_USER 重启为任意代码、修改服务可执行文件、修改配置或向 Host 注入调试/进程访问。
5. `Get-Acl` / `icacls` 和实际以 MODEL_USER 身份进行的读取、写入、重命名、替换、子进程及进程访问负例必须一起通过。
6. UAC 提示、用户同意、管理员/root 权限不可被当作“自动隔离能力”。**如果 Grok Build 仍以管理员 Token 运行，就 BLOCKED。**

Windows 文件访问检查依据微软 ACL / File Security 文档。单纯设置 `chmod 0600` 或把路径命名为 `host-private` 不作为 Windows 隔离证据。

### 3.2 IPC 传输基线选择（ADR-H2）

**推荐跨平台第一版采用：`127.0.0.1` 的 Host-owned TLS/mTLS 控制端点**，利用 Node 内置 `node:tls`，不需要 Grok ACP，不修改 Core。要求：
- `127.0.0.1` 单独绑定（如需要 IPv6，明确独立回环绑定并认证）；禁止 `0.0.0.0`、LAN、自动外网暴露。
- 双向证书认证：`requestCert=true`、`rejectUnauthorized=true`、Host 配置信任的 CA/客户端证书指纹白名单；证书私钥由不同 OS 主体持有并受 ACL 保护。
- 服务端的 Host 私钥与 Ed25519 回执私钥均仅在 HOST_USER 访问域。
- 客户端凭据只授权非常窄的 bridge 操作；**客户端拥有凭据 ≠ Provider/模型身份认证**，不允许以“mTLS 成功”直接给模型结果签署原生来源证明。
- 每个连接再经 Run/tenant/operation/taskDigest/requestId/attempt 绑定授权，必须检查终态、漂移和 replay。
- 使用有界长度前缀帧、idle/read 超时、并发上限、严格 JSON schema，拒绝未知字段；针对 P0-A 的 2 MiB signed receipt 上限重新计算传输尺寸，不能靠截断输出制造错误分类。
- 如果 Host 采用按需启动而非长驻进程，端点随 Run/调用按需生存；这不是 Core 的通用 Runtime。

### 3.2.1 必须分离的两跳通道（封闭 DR-01）

不能把 mTLS 证书直接交给 Grok Build 的工具脚本：这样 MODEL_USER 就能够复制客户端私钥，冒充受信 Bridge。正确的接入路径为：

1. **MODEL_USER 原生工具调用 → 不可信数据入口。** 模型只传公开 Run/RequestId 与 result；该入口不持有 Ed25519 signer、mTLS client key 或 Store。这里的 JSON 永远只是候选数据。
2. **HOST_USER 控制的 Supervisor → 验证真实 native `tool_call` 事件。** Supervisor 从其保护的捕获通道获得 CLI 进程、Session 与 tool-call 事件，将它和入口收到的候选结果按 Run/RequestId/Attempt/ToolCallId/Hash 严格匹配。
3. **受保护 Bridge → mTLS → Host signer/Store。** mTLS 的 client cert key 只在受保护的 Bridge Principal 中存在；MODEL_USER 无法读、复制或通过通用代理 API 滥用该凭据。Bridge 的转发行为由受信 Supervisor 的事件证据驱动，不接受纯模型自报“已经验证”。
4. **Host 签署后才允许状态推进。** 任何观察链断裂、乱序、事件无法关联、超时或权限错误都不能发出 Host 签名和 CAS。

模型→Bridge 的入口可以是限制功能的本机工具命令/临时 IPC；该入口不被当作认证事实来源。**禁止**把所有 CLI 工具调用事件视为已被 Provider 数字签名。

此结构不要求修改 FlowKit JS Program 或核心 SDK；它仅在宿主部署层实现更强的证据收集。受保护 Bridge 与 Host Adapter 可以在同一个 HOST_USER 安全域中运行，但必须遵守独立代码入口和最小权限，不通过模型可写模块加载。

**Named Pipe 作为可选 Windows 原生优化**，不得无审查替换上面的方案：
- Node `node:net` 支持 Windows named pipe，但“能 `listen(path)`”不证明 DACL 正确。
- Windows `CreateNamedPipeW` 可以在 `SECURITY_ATTRIBUTES` 中提供安全描述符；默认 DACL 可能给 Everyone/Anonymous 读取权限。
- 如选 Named Pipe，必须用经审查的 OS 原生启动/安全辅助模块，明确控制 DACL/SDDL、服务 SID、可访问的客户端 SID、`PIPE_REJECT_REMOTE_CLIENTS`，并验证连接方的实际 Token/SID；不能只根据 PID、管道名字或随机路径判断授权。
- Node 公开 `node:net` 接口是否允许设置足够精细的 Windows DACL **需在 Node 22/24 当前版本上验证**。未验证前不承诺“纯 `net.createServer` 即可安全使用”；若需要 Win32 辅助模块，其功能限定为平台安全引导，不得引入工作流第二 Runtime。

两种传输都不是模型来源证明；传输认证只证明授权通信主体。需配合 §5 的可信观察。

## 4. Linux：对应安全方案

1. HOST_UID 与 MODEL_UID/GID 分离，MODEL_UID 不得为 root、不得拥有 `sudo`、`CAP_DAC_OVERRIDE`、调试 Host 的能力。
2. Host-only 私有根目录 `0700`，密钥 `0600`，数据库及 WAL/SHM 继承相同隔离；公共 Task 由 Host 明确披露。
3. 可复用相同的 loopback mTLS 协议；若使用 Unix Domain Socket，则 socket 所在目录、所属 group、权限、Peer Credential 及符号链接/路径替换风险都必须单独审查。
4. 测试 MODEL_UID 的文件读取/写入、目录遍历、pid/fd/env 访问、Host 进程调试/注入、IPC 伪造、跨租户访问。
5. 现有 `tests/security/host-isolation.mjs` 只能证明**脚本模型子进程**的 Linux UID 边界；真实 Grok Build 对应进程仍需同样的测试和进程证据。
6. 不把 Docker 非特权容器、WSL2 或运行时目录名本身当作安全隔离，除非隔离配置经过实际攻击测试。

## 5. 来源证明和真实模型调用证据（ADR-H3）

### 5.1 证据等级，不得混淆

| 级别 | 已证明事项 | 不能宣称的事项 |
|---|---|---|
| P / scripted | Compiler → JS Program → Host/SQLite、协议测试 | 真实模型行为 |
| M / live-model | Grok Build 当前会话确实在真实 Pending 后作答，有工具事件/输出 | 模型/Host OS 隔离、Provider 加密来源证明 |
| T / host-observed transport | 独立 HOST_USER 通过受保护会话/IPC 观测到指定 CLI 进程和工具事件，并绑定该响应 | 供应商端对会话/回答的数字签名 |
| N / native-host-attested | 冻结 C12/S13 所需全部原生工具链 + 可信来源与隔离证据、Host 和 Store 不变量 | 不覆盖管理员攻破或 Provider 内部事件 |
| V / provider-verifiable（如果供应商支持） | 供应商可公开验证规则和可信根支持的响应来源证明 | 不能由 Grok 普通 JSON `signature` 字段推断 |

**证据身份不能由模型随意填写。** Host-only evidence ledger 的事件必须由不受模型写权限控制的可信 Transport/Supervisor 记录。

### 5.2 直接 Grok Build CLI 可复用的证据

xAI Grok Build 文档提供：
- 交互模式 `grok`；
- headless `grok -p ... --output-format streaming-json`；
- streaming-json 的 `tool_call`、`tool_call_update`、`usage`、`end` 等事件，以及在部分后端可用的 `sessionId`、`requestId`、`toolCallId`。
- 不同后端不保证完全相同的来源或签名字段；`usage.signature` 不能未经官方验证规范、密钥和签名范围确认就称作 Provider attestation。
- 不要求 ACP；如果以后 Host 需要稳定、长期操纵多个会话，再评估 ACP，但 **不能因为切换 ACP 就放宽隔离和来源门禁**。

**安全验收模式**推荐由受信 Host Supervisor 启动受限的 Grok Build CLI，固定二进制位置/Hash、配置、允许的工具集合、CWD、运行账户；捕获 CLI 原始结构化事件流。捕获通道和证据目录应仅 HOST_USER 可写。运行环境不得允许模型修改其自身被测 CLI 二进制或 Host 端记录。

如果只是用户现有 Grok Build 交互窗口自行写文件、模型填写 `GROK_SESSION_ID`、或同一 OS 用户运行 Host，自然可执行 M 层试验，但 **不能充当 N 层安全验收**。

### 5.3 绑定算法和 Host 回执签署前置条件

1. Host 持久化当前 Run 和 Pending，建立不可变 `{namespace,runId,nodeId,requestId,attempt,artifactHash,policyHash,taskDigest}` 索引。
2. Trusted supervisor 创建 Host-only `sessionEvidenceId`（不是模型输入），记录实测 CLI binary Hash、OS principal、启动时间、进程树、Grok 会话标识（若提供）、工具 invocation/update 事件、原始输出 digest、requestId 绑定和事件的单调序号。
3. 当 Grok Build 通过原生工具提交结果时，Bridge 只发送结果数据和公开 request identity。Supervisor/Host 通过**独立捕获的真实工具事件**及当前 Pending 核对 ToolCallId、result digest、会话/进程通道、租户权限、时效和容量。
4. **先捕获调用开始，再签署回执。** 对 `submit`，Host 必须在工具执行前独立捕获真实 `tool_call` 事件（携带完整输入参数或可验证摘要），与 Bridge 候选结果匹配。不能等待 `submit` 结束后才出现的 `tool_call_update` 或工具最终输出再签署，否则会形成“工具等待 Host，Host 等待工具”的死锁。完成事件用于签后审计；如果 Grok 当前版本无法证明开始事件时序，需要在 Phase 4 改为显式双阶段协议，不能假设已有能力。
5. 如果某个事件无法可靠证明对应当前结果、会话/进程或授权工具执行，**不得签署 Agent 回执**；保持原 Pending，写 Host-only 审计并按受控恢复策略处置。
6. Host 归一化 `normalizeHostAgentReceipt(receipt)` 后，建立 Host-only `proofId → verifiedSessionEvidence` 绑定，选择已核准的 `keyId`，调用现有 `createAgentReceiptStatement` 和 `encodeAgentReceiptStatement` 在 HOST_USER 下签 Ed25519。
7. 最后调用现有 `host.accept({receipt,attestation})`。现有 statement 的 `proofId` 和 `receiptHash` 正好绑定已认证事件与结果；**不新增 v1 ABI 字段**。
7. 原始证据若是任何模型可写的 JSON，则只能作辅助上下文，不是独立认证来源。
9. `agent-call-failed` 和 provider output-overflow 只在 Host 可信观察到真实失败/限制后签发，禁止把任意模型自报失败升级为可信状态变更。

### 5.4 对可验证性边界作出硬判定

- 若受控 CLI 输出只证明“本机特定进程输出”，而无法独立证明内部 Provider 服务端实际产生该响应，证据只能记 `HOST_OBSERVED`，不能虚构 `PROVIDER_VERIFIED`。
- C12/S13 的最终等级必须依照冻结验收条款判定。若条款明确要求 Provider 级来源且 Grok 没有可用的可验证机制，标 `BLOCKED` 并提交具体差异供审查，**不能降低验收要求**。
- 同一用户运行的普通 CLI、文件轮询、模型自报身份及 Host 自签未经校验的 JSON 都不能解除 C12/S13。
- 对于 ChatGPT/Codex/Claude 的后续适配，要求同样证据等级，并逐宿主声明不足；不允许为了平台兼容以通用伪 provenance 填补空白。

## 6. IPC / JS 工具契约（Host Adapter Proposal，不修改 SDK）

### 6.1 API 角色隔离

| Adapter 操作 | 发起主体 | Host 动作 | 返回内容 | 关键禁令 |
|---|---|---|---|---|
| `bootstrapRun` | 受信用户/部署控制面 | 校验不可变 Program/policy，调用 Host `start` | Run 身份和私有管理 Ack | 模型不能上传 Program Hash 并自动加入 allowlist |
| `getCurrentPublicTask` | 已认证 Grok Bridge | 检查 Run/tenant、`getPublicAgentTask`、授权披露 | 只含当前白名单 Task + adapter correlation | 不返回 Host frame、完整 State、私钥 |
| `submitAgentResult` | 已认证 Grok Bridge | 关联独立 session/tool evidence → Host 签 receipt → `accept` | acceptedRevision/duplicate/status（脱敏） | 模型不能提交签名、proofId 或 Host policy |
| `continuePublic` | 已认证 Grok Bridge | 检查 Run 归属，Host `resume` 并重新授权披露 | next Public Task 或脱敏终态 | 不调用原始 Coordinator `complete` |
| `getRunStatus` | 已认证受限调用方 | Host 私有 `load` 或安全状态派生 | status、revision、可披露摘要 | 不外发完整 State |
| `readPrivateResult` | 受信用户/Host 控制面 | 按用户策略读取 Host-visible 终态 | 受授权业务 State | 不注册成模型可用工具 |

**对 `start` 的含义**：用户原始的 S13 流程包含 Grok 调用 JS 工具启动工作流；真实工具 `bootstrapRun` 的入口必须已由受信用户明确授权初始 State、Program 与 Run scope，不能给模型任意启动新 Run 的权限。模型可以触发“已授权 run 的 start”，不拥有“授权一个新工作流”的权力。

### 6.2 Transport envelope 草案

```json
{
  "protocol": "flowkit.host.bridge.v1",
  "operation": "submitAgentResult",
  "correlationId": "host-allocated-or-non-authoritative",
  "runId": "run-id",
  "requestId": "req-id",
  "attempt": 1,
  "payload": {"result": {"summary": "..." }}
}
```

说明：
- `correlationId` 只用于可观测性，不是认证材料；
- 真实桥接器应使用 strict key allowlist、受控 JSON/UTF-8 解析、长度前缀帧、deadline、连接并发限制和生命周期清理；
- `namespace`、`artifactHash`、`policyHash`、`nodeId` 从 Host 当前 Pending 读取，模型提交的同名字段不能改变它们；
- Host 把调用绑定到已验证 OS 客户端 principal、授权租户和当前 Run；错误 Run/Request/attempt、越界字段均拒绝；
- 具体传输 body 上限需与既有 v1 receipt **2 MiB** canonical limit、Checkpoint active reserve、Skill 输入范围协调，经实测冻结；超限发生在签名前按现有三类故障分类处理，不允许随意截断；
- 未认证请求、非法 JSON、签名错误和 stale Pending **零 CAS、零 Journal、零 receipt index 变更**；
- 不得把 `getPublicAgentTask()` 返回的敏感以外字段扩张为任意 State 全量读取；
- 用户中止/断线不能凭模型 JSON 直接写入“Human 批准”或“取消”终态，P0-A 只处理合法 Agent 回执。

### 6.3 错误和恢复

- 新增 Adapter 错误只限宿主传输诊断，不改 FlowKit 的既有 `FK_I_*` 错误集合；需要新增 SDK 错误码时必须另签设计变更。
- 掉线/Host 崩溃：保存证据链和原 Pending；重启时通过现有 `resume` + `getReceipt` 对账。不得声称 Provider exactly-once。
- 同内容重复提交 → 原 acceptedRevision；不同内容同 requestId → `FK_I_RECEIPT_CONFLICT`；迟到或错租户按原协议拒绝。
- 策略/密钥轮换：保留已批准旧运行的身份/密钥策略直到 Run drain；无法提供安全迁移时 fail closed，不得重签一个编造的旧回答。
- 缺来源证据、隔离破坏或私钥访问异常时停止签署新 receipt，Store 保持在可审查的最后 durable State；不能用无穷重试假装恢复成功。

## 7. 部署与运行模式

| 模式 | 实际用途 | 可宣称层级 |
|---|---|---|
| Developer Mode | 用户直接打开 Grok Build，手工读 Pending/写 response，Host 可共享普通用户进程 | 仅 P/M；**不能**通过 N 层安全门禁 |
| Secure Windows Host | HOST_USER 与非管理员 MODEL_USER 分离，显式 ACL、TLS/mTLS、独立可信 CLI 观察 | P/M/T；只有完成全部 C12/S13 测试才可 N |
| Secure Linux Host | HOST_UID 与 MODEL_UID 分离，0700/0600 与已认证 IPC、独立观察 | P/M/T；只有完成全部 C12/S13 测试才可 N |
| Unsupported Host | 没有 JS 执行工具、不能隔离、不能绑定来源 | `NO_JS_EXECUTOR` 或 `BLOCKED`，不得回退模拟 |

**最小安装原则**：运行时只要求目标 Host 环境已有 Node 22.13+，Host 适配可作为按需子进程；Windows 独立服务账户部署需要一次性管理员配置，不代表每个用户一个独立服务器。对于多用户 Host，租户 `namespace` 必须与 IPC 的经认证身份绑定，而不是接受模型自报 tenant。

## 8. 实施拆分（Phase 3/4，不在本 PR 动工）

| 序号 | 独立交付 | 最小改动目标 | 前置 |
|---|---|---|---|
| H3-01 | Host bootstrap/provisioning | Windows/Linux 受保护身份、private FS、信任配置 | 本设计通过安全审查 |
| H3-02 | Transport adapter | 127.0.0.1 mTLS、严格 framing/ACL-bound auth | H3-01 |
| H3-03 | Agent result evidence ledger | Host-only 进程/会话/tool/event/result digest 关联 | H3-02 |
| H3-04 | M5 signer integration | 按 `proofId` 查证据，签原 v1 statement 后 `accept` | H3-03 |
| H3-05 | OS negative-security tests | Windows ACL、Linux UID、shell/pid/IPC/replay/tamper | H3-04 |
| H4-01 | Grok direct CLI native JS tool | 原生工具启动、获取 Pending、提交、续接终态 | H3-05 |
| H4-02 | Grok CLI output observer | `streaming-json` 原始事件捕获、可信 ToolCallId/result link | H4-01 |
| H4-03 | Native Grok adversarial acceptance | S13/C12、kill/resume、双会话、提示注入和大输出 | H4-02 |

上述编号仅表示交付片段，不新增正式阶段。每个片段有独立测试/审查并保留失败反例。未来可切换其他 IPC 实现，但要保持相同权限与身份断言。

## 9. 明确的设计判停和升级条件

**不得进入 Phase 3 的条件：**
- 未决定可信 OS 主体、私钥/DB 的真正访问控制；
- 把 Node `net.createServer` 默认 Windows Named Pipe 当成已证明 ACL；
- 让模型或同一权限的 Bridge 获取 Host 原始 Store/Signer；
- Host 在独立验证来源前签署任意模型 JSON；
- 把 `usage.signature`、`GROK_SESSION_ID`、普通日志或 mTLS client 证书直接当成 Provider 签名；
- 新设计与现有签名 v1、Program ABI、PolicyHash 或只读/公开视图冲突；
- 未证明原生 Grok 的工具执行机制具备必要的可观测与受控调用入口。

**完成 Phase 2 的条件：**
1. 完成独立安全复审（至少一次对抗性核验，本轮模型自审不得自称外部独立）。
2. 冻结 OS 身份、认证、最小 IPC、Host-only session evidence、签名与恢复策略。
3. 每个威胁有可复现负例、PASS/FAIL/BLOCKED 分类和最小修复入口。
4. 不要求在 Phase 2 完成 Windows/Grok 的真实运行证据；**真实证据是 Phase 3/4 的准入条件**。
5. 任何外部 Provider 证明能力不确定时记录为“需在 Phase 4 实测”，不得作为默认已支持。

## 10. 官方资料及解释边界

- [FlowKit M5 existing security contract](./interactive-host-security.md)
- [FlowKit M6 roadmap](./interactive-full-delivery-roadmap-2026-11-11.md)
- [Microsoft: named pipe security and access rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft: CreateNamedPipeW SECURITY_ATTRIBUTES / PIPE_REJECT_REMOTE_CLIENTS](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)
- [Microsoft: icacls / file DACL](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- [Microsoft: restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
- [Node.js: IPC support](https://nodejs.org/api/net.html#ipc-support)
- [xAI: Grok Build overview](https://docs.x.ai/build/overview)
- [xAI: Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting)
- [xAI grok-build: streaming-json event types](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)

仅在微软文档支持的范围内断言 Windows ACL/Named Pipe；仅在 xAI 文档支持的范围内断言工具事件存在。**没有公开的证据证明 Grok 的 `usage.signature` 可以直接用于独立 Provider-origin 验证。**

---

**设计结论：** 采用“Host 受保护 OS 身份 + 默认跨平台 loopback TLS/mTLS + Host-only 原生工具观察/证据索引 + 现有 Ed25519 receipt v1 + FlowKit Core 不变”的 Phase 3/4 实施方向。Named Pipe 可保留为经独立 DACL 与身份验证后的后续优化，不能成为 Windows 安全通过的捷径。
