# FlowKit Interactive — Trusted Host V2 安全与原生 Grok Build 桥接设计（Draft）

> **阶段：Phase 2 / Design only。2026-11-11。**
>
> **代码核对基线：** `main@9bac8f86347a405efe068f96423ae3e501005061`。历史确认的 V0.3 需求与 V0.6-R5 设计原件在当前审查可用文件/仓库中未找到，完整 SHA-256 也不可核验；两份原文的符合性维持 BLOCKED，不以路线图摘要冒充原件。当前可核对基线是 M5 安全契约 [interactive-host-security.md](./interactive-host-security.md)；M6 完整路线 [full-delivery-roadmap](./interactive-full-delivery-roadmap-2026-11-11.md)。
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
  OS principal: MODEL_USER (non-admin)
  model + ordinary tools + optional configured MODEL_USER MCP tool
  never holds signer, private Store or Host TCB credentials
        |
        | (1) native tool_call rawInput/event: Host-captured CLI stream
        | (2) candidate result: constrained untrusted local transport
        v
TRUSTED HOST SUPERVISOR / ADAPTER (single HOST_USER TCB by default)
  Host captures tool events from its own CLI child pipe
  verifies tool input / result / current Pending and tenant policy
  approved immutable Program manifest + Host-only session evidence
  secure allowlist, disclosure, bounded reconciliation and Outbox
  --- private trust boundary ---
  createTrustedInteractiveHost()
  createAgentReceiptStatement() + Ed25519 Host signer
  createSqliteCheckpointStore() -> WAL / FULL / CAS
        |
        v
durable next Pending / Terminal

OPTIONAL: separate BRIDGE_USER / protected local mTLS hop only when a
deployment has a concrete need for another OS security boundary.
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
7. Supervisor 启动 MODEL_USER 时仅允许继承必要的匿名 stdout/stderr/明确授权的通信句柄，不得继承 Host 私钥、SQLite 主库/WAL/SHM、证书、配置、文件映射、进程/Token 句柄或机密环境变量。Windows 使用不继承句柄或经审查的显式句柄白名单。**实际子进程句柄表和跨账户测试**必须与路径 ACL 拒绝测试同时通过。

Windows 文件访问检查依据微软 ACL / File Security 文档。单纯设置 `chmod 0600` 或把路径命名为 `host-private` 不作为 Windows 隔离证据。

### 3.2 IPC 传输基线选择（ADR-H2）

**最小受信部署仅强制两套 OS 身份：MODEL_USER 与 Host TCB。** Bridge、Supervisor 与 Host 在同一 HOST_USER 内可合并为一个受保护进程，不强制在同一 TCB 内增加一跳 mTLS。仅在部署需要跨进程本地监听端点时，才选用 `127.0.0.1` TLS/mTLS；此时必须证明传输身份与原生工具事件的分离，ACP 不是必要前置。若使用 TLS/mTLS，要求：
- `127.0.0.1` 单独绑定（如需要 IPv6，明确独立回环绑定并认证）；禁止 `0.0.0.0`、LAN、自动外网暴露。
- TLS/mTLS 要求 `requestCert=true`、`rejectUnauthorized=true`、服务端证书身份固定、CA/客户端证书指纹白名单。客户端证书仅证明本地通道身份；如果客户端进程在 MODEL_USER 下运行，其凭据可被模型读取，绝不能作为 Model/Provider 原生来源证明或 Host 签名授权。Host-only 密钥仍由 HOST_USER 持有。
- 服务端的 Host 私钥与 Ed25519 回执私钥均仅在 HOST_USER 访问域。
- 客户端凭据只授权非常窄的 bridge 操作；**客户端拥有凭据 ≠ Provider/模型身份认证**，不允许以“mTLS 成功”直接给模型结果签署原生来源证明。
- 每个连接再经 Run/tenant/operation/taskDigest/requestId/attempt 绑定授权，必须检查终态、漂移和 replay。
- 使用有界长度前缀帧、idle/read 超时、并发上限、严格 JSON schema，拒绝未知字段；针对 P0-A 的 2 MiB signed receipt 上限重新计算传输尺寸，不能靠截断输出制造错误分类。
- 如果 Host 采用按需启动而非长驻进程，端点随 Run/调用按需生存；这不是 Core 的通用 Runtime。

### 3.2.1 最小信任边界及可选两跳通道（DR-01 / F-02）

不能把 **Host TCB 专用** mTLS 私钥交给 Grok Build 工具脚本：MODEL_USER 可复制其有权读取的凭据。模型侧候选连接若存在单独的客户端身份，其只能用于传输访问，绝不能代替模型来源证明。受信路径为：

1. **MODEL_USER 原生工具调用 → 不可信数据入口。** 模型只传公开 Run/flowkitRequestId 与 result；该入口不持有 Ed25519 signer、Host TCB 的 mTLS 私钥或 Store。即使拥有模型侧传输凭据，JSON 仍然只是候选数据。
2. **HOST_USER 控制的 Supervisor → 验证真实 native `tool_call` 事件。** Supervisor 从其保护的捕获通道获得 CLI 进程、Session 与 tool-call 事件，将它和入口收到的候选结果按 Run/RequestId/Attempt/ToolCallId/Hash 严格匹配。
3. **Host TCB 校验后才签收。** 受保护 Bridge 与 Host 若为同一 HOST_USER，可直接走内部受限调用；独立 Bridge 进程或 loopback mTLS 是部署选项，不是第二个独立信任域。任何输入候选只有与 Host 独立观察到的工具事件绑定后才可签名。
4. **Host 签署后才允许状态推进。** 任何观察链断裂、乱序、事件无法关联、超时或权限错误都不能发出 Host 签名和 CAS。

模型→Host TCB 的候选入口可以是受限 MCP/Node 工具与本地 IPC；该入口不被当作认证事实来源。**禁止**把所有 CLI 工具调用事件视为已被 Provider 数字签名。

此结构不要求修改 FlowKit JS Program 或核心 SDK；它仅在宿主部署层实现更强的证据收集。**受保护 Bridge 与 Host Adapter 同在 HOST_USER 时属于同一个可信计算基（TCB）**：模型工具无法读取或调用两者的私有资源，但不能宣称“Bridge 被 OS 阻止读取 Host signer”。若安全目标进一步要求即使 Bridge 被攻击也无法读取 Host key/DB，必须部署独立 BRIDGE_USER 并对 Host 目录与 signer 进行真实 ACL/UID 隔离；它是可选的更强隔离配置，不能靠进程名称或 JS 对象封装假装实现。当前 M6 原生硬门禁首先证明 **MODEL_USER 与整个 Host TCB** 的真实隔离。

**Named Pipe 作为可选 Windows 原生优化**，不得无审查替换上面的方案：
- Node `node:net` 支持 Windows named pipe，但“能 `listen(path)`”不证明 DACL 正确。微软官方说明默认描述符向 Everyone 和 Anonymous 授予读取权限，因此未提供自定义 DACL 的默认 `node:net` Named Pipe 禁止作为安全 IPC。Grok 报告中的具体 Windows Node SDDL 测量未附原始脚本，本轮不将其记作我已重现。
- Windows `CreateNamedPipeW` 可以在 `SECURITY_ATTRIBUTES` 中提供安全描述符；默认 DACL 可能给 Everyone/Anonymous 读取权限。
- 如选 Named Pipe，必须用经审查的 OS 原生启动/安全辅助模块，明确控制 DACL/SDDL、服务 SID、可访问的客户端 SID、`PIPE_REJECT_REMOTE_CLIENTS`，并验证连接方的实际 Token/SID；不能只根据 PID、管道名字或随机路径判断授权。
- Node 22/24 公开 `server.listen({path,readableAll,writableAll})` 没有直接设置自定义 SDDL/服务 SID 的选项，不能从 `readableAll:false` 推断默认 DACL 安全。若选 Named Pipe，必须在创建时提供明确 DACL 和客户端身份校验，并用真实 Windows 测试验证；不得在宽松创建后补改权限。

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

1. Host 持久化当前 Run 和 Pending，建立不可变 `{namespace,runId,nodeId,flowkitRequestId,attempt,artifactHash,policyHash,taskDigest}` 索引。`flowkitRequestId` 映射为原 M5 receipt 的 `requestId`；Grok CLI 的 `grokRequestId/grokSessionId/toolCallId` 保留为另外的 Host-only 观察字段，不能覆盖 FlowKit 身份。
2. Trusted supervisor 创建 Host-only `sessionEvidenceId`（不是模型输入），记录实测 CLI binary Hash、OS principal、启动时间、进程树、Grok 会话标识（若提供）、工具 invocation/update 事件、原始输出 digest、requestId 绑定和事件的单调序号。
3. 当 Grok Build 通过原生工具提交结果时，Bridge 只发送结果数据和公开 request identity。Supervisor/Host 通过**独立捕获的真实工具事件**及当前 Pending 核对 ToolCallId、`toolInputDigest/receiptHash`、会话/进程通道、租户权限、时效和容量。
4. **先捕获调用开始，再签署回执。** 对 `submit`，Host 必须在工具执行前独立捕获真实 `tool_call` 事件（携带完整输入参数或可验证摘要），与 Bridge 候选结果匹配。不能等待 `submit` 结束后才出现的 `tool_call_update` 或工具最终输出再签署，否则会形成“工具等待 Host，Host 等待工具”的死锁。完成事件用于签后审计；如果 Grok 当前版本无法证明开始事件时序，需要在 Phase 4 改为显式双阶段协议，不能假设已有能力。
5. 如果某个事件无法可靠证明对应当前结果、会话/进程或授权工具执行，**不得签署 Agent 回执**；保持原 Pending，写 Host-only 审计并按受控恢复策略处置。
6. Host 归一化 `normalizeHostAgentReceipt(receipt)` 后，建立 Host-only `proofId → verifiedSessionEvidence` 绑定，选择已核准的 `keyId`，调用现有 `createAgentReceiptStatement` 和 `encodeAgentReceiptStatement` 在 HOST_USER 下签 Ed25519。
7. 最后调用现有 `host.accept({receipt,attestation})`。现有 statement 的 `proofId` 和 `receiptHash` 正好绑定已认证事件与结果；**不新增 v1 ABI 字段**。
8. 原始证据若是任何模型可写的 JSON，则只能作辅助上下文，不是独立认证来源。
9. `agent-call-failed` 和 provider output-overflow 只在 Host 可信观察到真实失败/限制后签发，禁止把任意模型自报失败升级为可信状态变更。

### 5.4 对可验证性边界作出硬判定

- 若受控 CLI 输出只证明“本机特定进程输出”，而无法独立证明内部 Provider 服务端实际产生该响应，证据只能记 `HOST_OBSERVED`，不能虚构 `PROVIDER_VERIFIED`。
- C12/S13 的最终等级必须依照冻结验收条款判定。若条款明确要求 Provider 级来源且 Grok 没有可用的可验证机制，标 `BLOCKED` 并提交具体差异供审查，**不能降低验收要求**。
- 同一用户运行的普通 CLI、文件轮询、模型自报身份及 Host 自签未经校验的 JSON 都不能解除 C12/S13。
- 对于 ChatGPT/Codex/Claude 的后续适配，要求同样证据等级，并逐宿主声明不足；不允许为了平台兼容以通用伪 provenance 填补空白。

### 5.5 直接 Grok Build 工具注册与结果证据（F-02）

1. `--tools` 是内置工具 allowlist，**不会注册自定义 FlowKit JS 函数**。首选探针为在受信安装的 Grok `.grok/config.toml` 中配置受限的 **MCP FlowKit 工具服务器**，该服务器运行于 MODEL_USER 且不持有 Host 私钥、SQLite 或 signer；备选固定 Node/Shell 命令只有在能提供同等级原生输入事件证据时才可用。实际 MCP 工具的发现、启用、授权及 `tool_call.rawInput` 形式须实测，不能凭文档声称完成。
2. 受信 HOST_USER Supervisor 只从自己掌控的 CLI stdout 捕获结构化事件；模型和工具 stdout 的伪造/混淆能力通过 NAT-06/14 攻击实测排除。模型侧 MCP 工具发出的候选 RPC 是不可信数据，`--tools`/MCP 的存在本身不构成来源认证。
3. **两个摘要分别定义**：`toolInputDigest = sha256(canonicalBytes(rawInput))`，对比 Host 独立捕获的原生 `rawInput` 与 MCP 候选 RPC 参数；Host 根据当前 authoritative Pending 创建 `normalizedReceipt`，然后 `receiptHash = sha256(canonicalBytes(normalizedReceipt))`。必须从上述两条已验证输入路径重算出**相同 normalizedReceipt 与 receiptHash**，不是要求 `rawInput` 原文逐字节等于包含 Host 补充字段的完整回执。Grok 的 `grokRequestId`、`grokSessionId` 与 FlowKit 的 `flowkitRequestId` 不可互换。
4. 入参规模应实测 64 KiB、256 KiB 和接近合法回执上限的边界。2 MiB 是 M5 Signed Receipt 的**上限**，不是 Grok/MCP 保证支持的参数量。若 CLI 起始事件丢失/截断参数，或结果走模型可替换文件而只看到命令字符串，签名必须 BLOCKED；必要时另审 Host-owned immutable buffer + 对应可验证事件摘要的两阶段协议，不允许隐式降级。
5. 工具 `start/getPending/submit/continue` 是 Host Adapter 的行为映射，不是新增 FlowKit Core 公共 API。`start` 只能启动经可信用户预授权的 Program/State，不允许模型创造 allowlist 条目；`continue` 返回脱敏状态，不输出 Host frame 完整 State。

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
  "flowkitRequestId": "req-id",
  "attempt": 1,
  "payload": {"result": {"summary": "..." }}
}
```

说明：
- `correlationId` 只用于可观测性，不是认证材料；
- `flowkitRequestId` 是 FlowKit 当前 Pending 的身份，适配器映射成已有 receipt `requestId`；Grok `grokRequestId/grokSessionId` 仅为 Host-only 观察字段，不得覆盖它；
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
- 详见 §6.4 对签后、CAS 前进程崩溃的 Outbox 和过期证明处理；禁止无持久证据的重签。

### 6.4 Host-only 观察证据与签名回执 Outbox（关闭 DR-13）

**必须解决的故障窗口**：模型结果已被独立观察、Host 已签 v1 statement，但 `host.accept()` 还没提交持久回执就崩溃。如果签名已过期，M5 仅允许**已接纳、内容相同的回执**在过期后复用历史 Ack；**未接纳的过期回执不能直接重放成功**。

实现约束：

1. Host-only observation ledger 使用独立保护的持久存储（可为 Host Adapter 自己的 SQLite/附加表；不得未经批准改变 FlowKit Core Store Schema），记录受信工具事件摘要、`namespace/runId/flowkitRequestId/attempt/taskDigest/toolInputDigest/receiptHash`、Grok 的独立 `grokRequestId/grokSessionId/toolCallId`、CLI 进程、来源级别及审计 ID；`receiptHash` 与现有 `createAgentReceiptStatement` 对 `normalizedReceipt` 规范化后的 SHA-256 完全一致。Outbox 使用 SQLite WAL + `synchronous=FULL` 或已证明等效的 durable fsync 屏障。
2. 在调用 signer 前先持久写入 `OBSERVED` 事件与验证结果。签名成功后，**先持久写入完整的 signed statement/receipt 和 `SIGNED` Outbox 记录**（Host-only，保留原始字节），再调用现有 `host.accept()`。不能在内存里签完就立即调用，留下不可对账的崩溃窗口。
3. 若 `accept()` 成功，核实 Store 的 `getReceipt(runId,requestId)` 与 v1 `receiptHash/acceptedRevision` 相同后，标记 `ACKED`。如果此时又崩溃，重启时从 Store 核对后补写 `ACKED`，不能产生第二次业务 State 提交。
4. 若崩溃后为 `SIGNED` 但 Store 尚未接纳：**未过期**则原字节重放；**已过期**则保持 Pending，不得拿过期证明绕过 M5。只有 Host-only 原始证据仍有效、当前 Pending/namespace/Program/policy/attempt 未变，且 Outbox **持久保存的原始 normalizedReceipt canonical bytes 与 receiptHash 完全一致**时，才允许按审计规则在同一 proofId 与同一业务回执字节上生成新的签发时间/签名；不能从模型重新序列化或推断出另一份结果。已接纳的相同回执始终走原历史 Ack。否则 `BLOCKED/RECONCILE`。
5. `proofId` 应由 Host 独立分配，映射到不可变证据记录；必须限制同一 toolCallId/事件/结果在不同 Run、租户、attempt 之间复用。
6. 对冲突的两个合法结果，现有 Coordinator CAS 仍决定唯一有效提交；Outbox 记录未中标的结果必须标记 `CONFLICT/REJECTED`，不能“清理失败结果”时丢掉必要审计。
7. Outbox 保留策略应与 Run 生命周期、合规审查窗口、敏感数据最小化和存储上限绑定；默认禁止无限制记录完整模型文本、私钥、完整 State。实际保留时长/GC 策略作为 Host 部署配置在 Phase 3 验收中冻结，**不是**新增 FlowKit Core 通用业务产物库或 GC。
8. 必须测试 `OBSERVED→SIGNED`、`SIGNED→ACCEPTED`、`ACCEPTED→ACKED` 的真实进程强杀、错租户、超期签名、重复回复、签名轮换与审计 Outbox 恢复，并证明 Journal/Checkpoint 不被 Outbox 重建逻辑重写。

这个设计避免把“Host 自己可以重新签名”误当成持久恢复与 Provider exactly-once 证明，也不改变现有 M5 对过期证明与历史 Ack 的安全语义。

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
| H3-02 | Grok 工具/Transport adapter | 首选 MODEL_USER 下受信配置的 MCP FlowKit 工具；先做原生 ToolCall 参数/事件时序 PoC，再按 Profile 选择受限本地 IPC（可选 loopback TLS/mTLS） | H3-01；H3-02 编码前须验证工具实际可注册、NAT-14 时序与回执绑定 |
| H3-03 | Trusted observation / signed receipt Outbox | Host-only 进程/会话/tool/event/receiptHash 关联；OBSERVED/SIGNED/ACKED WAL/FULL 持久化、过期/重签与历史 Ack 对账 | H3-02 |
| H3-04 | M5 signer integration | 按 `proofId` 查证据，签原 v1 statement 后 `accept` | H3-03 |
| H3-05 | OS negative-security tests | Windows ACL、Linux UID、shell/pid/IPC/replay/tamper | H3-04 |
| H4-01 | Grok CLI native tool observer | 基于 H3-02 PoC 固定 streaming-json 事件、toolCallId/input 摘要及日志伪造防护 | H3-05 |
| H4-02 | Direct Grok JS/MCP tool loop | 启动授权 Run、获取 Pending、提交结果、续接终态；不得绕过 Host signer/Store | H4-01 |
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

**完成 Phase 2 的条件：**
1. 完成独立安全复审（至少一次对抗性核验，本轮模型自审不得自称外部独立）。
2. 冻结 OS 身份、认证、最小 IPC、Host-only session evidence、签名与恢复策略。
3. 每个威胁有可复现负例、PASS/FAIL/BLOCKED 分类和最小修复入口。
4. Phase 2 不要求真实 Windows/Grok 运行 PASS；Windows/Linux 权限实测属于 Phase 3 退出门禁，Grok 工具输入与时序探针是 H3-02 实施前置，NAT-14 在 Phase 4 正式验收。
5. 任何外部 Provider 证明能力不确定时记录为“需在 Phase 4 实测”，不得作为默认已支持。

### 9.1 唯一阶段入口与出口（F-01）

- **Phase 3 入口**：安全设计独立复审已通过；Host/Model 两套 OS 身份及 Key、SQLite、WAL/SHM、ACL 规则已冻结，禁止默认 Node Named Pipe 当作安全 IPC。无需预先运行 Grok 原生工具。
- **Phase 3 退出**：Windows 与 Linux 两个适用 Secure Host Profile 的 SEC P0 均有真实权限、进程、IPC、签名与恢复证据；单平台通过只计该 Profile，不宣称 Phase 3 整体完成。
- **H3-02 开工前**：用最小 PoC 选定实际可注册的 Grok MCP 或受限工具及参数绑定方式，验证可独立捕获调用输入和签前事件时序；否则 H3-02 BLOCKED，H3-01 OS 工作不被回滚。
- **Phase 4 入口**：Phase 3 退出门禁通过、原生工具和 NAT-14 时序可实施。正式 C12/S13 原生闭环只能通过 Phase 4 的真实证据放行。

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
