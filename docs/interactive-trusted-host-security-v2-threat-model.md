# FlowKit Interactive — Trusted Host V2 威胁模型与攻击面登记（Draft）

**阶段：Phase 2（设计），2026-11-11。基线：** \`main@9bac8f86347a405efe068f96423ae3e501005061\`。  
**配套设计：** [Trusted Host V2](./interactive-trusted-host-security-v2-design.md)。  
**状态：** 威胁登记不等于测试通过；验证结果必须引用后续实测的 Git SHA、运行日志和 OS 证据。

## 1. 边界、信任主体与“不做”事项

| 主体 | 信任级别 | 可做 | 禁止 |
|---|---|---|---|
| MODEL_USER / Grok Build | 不可信模型/普通工具账户 | 查看授权 Public Task；通过受控工具产生结果 | 读取/修改私有 Store、签名密钥、Host 配置、任意 Run 的业务 State |
| Protected Bridge | 已核准受限通信客户端 | 接收仅来自允许的工具会话的数据；发送已鉴别的有限请求 | 任意新建 Run、重写 Program/policy、暴露私有 State、直接签收据 |
| HOST_USER / Host Adapter | 受信执行域 | 审核 Program、Data Disclosure、认证来源、签 receipt、CAS/Journal | 通过模型字符串授权签署、越过原协议伪造状态 |
| Provisioner / Operator | 受信部署主体 | 配置账户、ACL、证书、工件 allowlist、策略 | 作为模型可调用操作暴露这些权限 |
| Provider | 外部服务 | 在其协议范围内提供实际模型回复 | 不假设其一定有可验证会话签名或 exactly-once |
| Admin/root/Kernel | 根信任/明确出界 | 安装/审计 | 已被模型控制则停止宣称隔离 |

**既有契约：** M5 \`createTrustedInteractiveHost()\` 是 Host-only API，模型不应获得原始 \`complete()\`；Host 通过 Ed25519 v1 statement 和签名、Program/Policy Hash、DLP、Store CAS 保障可接受状态。上述机制不能替代底层 OS 权限边界。

### 1.1 同 UID/SID 与管理员原则

如果 Grok Build 有与 Host 相同的 OS 权限、可进入 Host token，或是本机管理员（可提权修改 ACL、服务及进程），即使程序在两个 Node.js 进程中，安全门禁仍记 \`BLOCKED\`。Linux 的 \`chmod\` 与 Windows 的 ACL 不具有直接可比的安全含义。

### 1.2 与阶段对应

- Phase 2：规范并审查所有威胁和验证门槛；不声称已运行 Windows/Grok 安全测试。
- Phase 3：TH-001–TH-017 的实际权限/IPC/签名测试。
- Phase 4：TH-018–TH-021 的真实 Grok 源绑定与原生 JS 工具调用。
- Phase 5/6：复核所有攻击族及 C08/C12/C22/C23 证据。
- P0-B Human 和 P1/P2 并行新增威胁在相应阶段扩展，不在当前 P0-A 偷做。

## 2. 可复现攻击矩阵

| ID / 级别 | 攻击 / 风险 | 防护或控制 | 必须出现的负例与通过标准 |
|---|---|---|---|
| TH-001 / P0 | 模型/工具可使用 Host 同一 OS 用户令牌，绕过一切文件目录约定 | Host 与 MODEL_USER 分离；实际 OS token / SID / UID 证明 | 同账户/管理员模式标 BLOCKED；受限模型身份不能提权到 Host |
| TH-002 / P0 | 模型读取 Ed25519 签名私钥或 KMS 授权 | Host-only key custody、ACL、最小进程权限 | MODEL_USER 的真正读取/复制/列目录失败；Host 自身签名 PASS |
| TH-003 / P0 | 模型直接读写 SQLite 主文件 | Host-only DB owner/DACL | 读取、覆盖、CREATE、DELETE、RENAME、替换文件失败 |
| TH-004 / P0 | 直接读写 SQLite \`-wal\`、\`-shm\`、备份、快照、导出日志 | 与主 DB 同级别的保护；禁止不安全备份 | 主 DB 被拒绝但 WAL/SHM 可读时 FAIL；Host 恢复正常 |
| TH-005 / P0 | 模型通过写入 Host 配置、artifact allowlist、Program 文件替换合法执行 | Host-only config/artifact manifest、exact hash、immutable verified bytes | 可写配置/产物时 FAIL；非授权 Program、policy drift fail closed |
| TH-006 / P0 | Windows 管道默认 ACL 给多余主体访问、预占/伪造管道名 | 优先 loopback mTLS；若用 pipe 必须显式 DACL+Peer SID+拒绝远程 | 非授权 SID 无法连接、无法预占、无法充当 Server；失败不能自动降级 |
| TH-007 / P0 | Loopback TCP 上未授权本地程序访问 Host | TLS mTLS、绑定回环、client cert/identity allowlist | 无证书、错证书、错误身份不能调用；非回环连接失败 |
| TH-008 / P0 | 客户端凭据落到模型工具可读范围，模型模仿 Bridge | Client key 仅限保护的 Bridge principal；Host 还校验独立工具证据 | 直接用模型账户/普通 node/curl 模仿 \`submit\` 不能生成已签回执 |
| TH-009 / P0 | 把普通 JSON、\`GROK_SESSION_ID\` 或模型声称已批准当来源证明 | Host-only supervisor 观察记录、受信 proofId 和 result digest 关联 | 改 sessionId/proofId/工具日志文件不能让 Host 发签名 |
| TH-010 / P0 | Host 给未验证的 response.json / 模型失败文本签署 Ed25519 | 观察证据验证先于 signer | 无工具/来源证据，Host 必须拒绝并保持 Pending/Store 不变 |
| TH-011 / P0 | 模型绕过 Bridge 直接调用 \`complete()\`、SQLite、signer | Coordinator & signer 只在 HOST_USER 运行，IPC strict method allowlist | 任何 model API 都无法获得低层 Host 对象或密钥；未授权方法必拒绝 |
| TH-012 / P0 | 模型触发 \`start\` 并给自己加入任意 Program artifact allowlist | 可信 provisioning/build manifest、预授权 Run scope | 模型自报 Hash 和初始 State 不能开始未经授权 Run |
| TH-013 / P0 | 错租户、错 Run、错 Node、错 requestId/attempt、旧 Pending 重放 | Host 从当前 Store 重新取 Pending，namespace-bound auth | 所有错身份请求无 CAS/Journal/receipt mutation |
| TH-014 / P0 | 有效签名/旧响应被替换或被其他 Run 复用 | v1 statement binds namespace/run/request/node/attempt/receiptHash/artifact/policy | 改任一字段，验证失败；相同合法重复回执只返回原 Ack |
| TH-015 / P0 | Checkpoint 尚未提交就发送下一个任务；Host 被杀后重复提交 | Store CAS 和先持久再派发；支持 same Run recovery | Publish/Accept/Commit 多切点 SIGKILL 后 Pending identity、State、Journal 一致 |
| TH-016 / P1 | 长输出、恶意 JSON、百万级对象造成内存/CPU/日志拒绝服务 | 有界 transport frame、限流、deadline、canonical receipt v1 2MiB | 上限+1、恶意 key、无效 UTF-8/JSON、重复/超时拒绝；不得篡改 State |
| TH-017 / P1 | 敏感 State/指令出现在 Pending、TLS 返回、Tool 结果或日志 | getPublicAgentTask allowlist + authorizeDisclosure + Host-only private view | canary 不得出现在模型可读流/日志；Host 内部仍保留完整 State |
| TH-018 / P0 | 原生 Grok CLI 输出流或 tool_call 由模型/脚本伪造或替换 | 受信 Supervisor 捕获真实 CLI 事件、安装路径/hash 固定，禁止模型写原始证据目录 | 用 echo/伪造 \`tool_call\` JSON/改本地日志不能认证为真实工具调用 |
| TH-019 / P0 | 客户端证书只证明 Bridge 账户，却被错当模型 Provider 身份 | \`HOST_OBSERVED\` 与 \`PROVIDER_VERIFIED\` 分开；独立原生事件证据 | 单独 mTLS PASS 不得让 C12/S13 获得 PASS；证明会话实际工具调用路径 |
| TH-020 / P1 | 真实模型中途崩溃、Provider 请求重复计费，Host 宣称 exactly-once | 固定 Pending/RequestId、对账、历史 Ack；外部调用按 at-least-once 风险处理 | 接受重复模型调用可能发生；只承诺一次有效 State commit |
| TH-021 / P0 | 工具/会话和 receipt 数据错配（结果 A 冒充结果 B） | 独立 ToolCallId/RequestId/TaskDigest/ResultDigest 绑定，Host-only proofId | 交换两次同 Run 不同 Pending 的结果或工具事件必须拒绝 |
| TH-022 / P1 | Host 签名证据过期、密钥轮换/策略漂移导致在途 Run 无出口 | 固定 policyHash、已核实历史 Ack、轮换排空或显式迁移 | 不制造新旧身份混合回执；旧 Host 可以审计/安全处置 |
| TH-023 / P1 | Windows service 控制权限、进程句柄、debug 权限让 MODEL_USER 以 Host 权限执行代码 | 专用服务 SID、SCM DACL、受限 Token、保护可执行路径 | MODEL_USER 不能修改/重启服务为任意程序，不能 attach/debug/dump Host |
| TH-024 / P1 | 路径重解析、符号链接、硬链接或 TOCTOU 替换 Host 文件 | Host owned path、真实路径/文件句柄验证、不跟随不安全链接 | 重定向私钥/SQLite/Program 读取失败或保持原已验证字节 |
| TH-025 / P0 | 模型构造 \`kind:'human'\` 或“人工已同意”让流程越权 | P0-A signed receipt 只接受 Agent；P0-B 必须另证 humanProvenance | P0-A \`kind:'human'\` 直接拒绝；Human 未实施不能表示审批通过 |
| TH-026 / P1 | 捕获会话 PID 后复用同 PID 或人为重放事件 | 进程启动时间/可执行文件摘要/session/tool sequence/host-only nonce | 旧 PID/session/toolCallId 不被新的 Run 自动承认 |

**验收证明强度**：
- “模型说无法访问”不是 TH-001–TH-005 证明，必须真的运行拒绝访问的文件/进程命令；
- Linux scripted nobody PASS 不能替代 Windows ACL；Windows 命令直接在不支持平台异常退出时保持 BLOCKED；
- 模型日志中普通 \`usage.signature\` 字段没有验证算法/密钥/覆盖字段，则不能升格为 \`PROVIDER_VERIFIED\`；
- 只有通过了原始 JS tool-call 证据、Host 可信接纳、OS 隔离的闭环，才可申请 C12/S13 的 N 层裁决。

## 3. Windows 身份及 ACL 防护检查表

所有测试必须使用正确的真实 OS Token 执行，而非在同一管理员终端中更改逻辑变量：

1. 查询 Host、Bridge、Grok CLI 的账户 SID、完整用户组和提升状态；
2. 查询 Host 私有根目录、Key、DB 主/WAL/SHM、Program manifest、可执行文件、日志的 DACL 与 Owner；
3. 验证 Host 服务对象的控制/更改配置权限不能被 Grok 用户调用；
4. 从 Grok 子进程尝试列目录、读、写、改名、替换、删除 Host 私有文件；
5. 从 Grok 子进程尝试打开 Host PID/进程句柄进行敏感权限操作；
6. 从 Grok 子进程尝试无证书/伪证书连接 loopback 端点；
7. 用真实受保护 Bridge client 连接并完成合法请求；
8. 证明新进程重启后仍保持隔离；
9. 所有记录脱敏，不把私钥、私有数据库原文上传 CI；
10. 若使用 Named Pipe，检查 SECURITY_ATTRIBUTES/DACL、非授权 SID 连接和服务 SID 验证；默认 Pipe ACL 不构成通过证据。

**工具参考**：\`whoami /groups\`、\`whoami /priv\`、\`Get-Acl\`、\`icacls\`、\`Get-LocalUser\`、Windows Service Control Manager 的安全描述符检查。实际测试命令在 Phase 3 写入自动化脚本并验证每个断言，不在这里假定其结果。

## 4. Linux UID/GID 防护检查表

1. \`id\` / \`stat\` / \`ls -l\` 验证 Host 与 Model 不同 UID/GID；
2. Host 私有根 \`0700\`、密钥 \`0600\`，包括 WAL/SHM/backup；
3. MODEl_UID 对私有目录全部 read/write/rename/traverse 失败；
4. MODEl_UID 对 \`/proc/<host-pid>/environ\`、FD、ptrace 和 Host PID 访问失败；
5. 真实 Grok Build CLI 在 MODEL_UID 下运行，观察证据由另一 Host UID 收集；
6. 如果采用 UDS，Socket path ACL/group/peer creds 必须复核；
7. 运行已经存在的 \`tests/security/host-isolation.mjs\` 作为最小回归，但不能把它当成真实 Grok 原生证明。

## 5. 安全 Finding 记录与关闭流程

每个实测攻击项至少包含：

\`\`\`json
{
  "threatId": "TH-003",
  "testId": "SEC-WIN-DB-DENY",
  "baselineCommit": "<sha>",
  "os": "windows-2025",
  "nodeVersion": "24.22.1",
  "hostPrincipal": "<redacted SID hash>",
  "modelPrincipal": "<redacted SID hash>",
  "inputDigest": "sha256:...",
  "observed": "Access denied on read / write / replace",
  "hostStillFunctional": true,
  "result": "PASS",
  "rawEvidenceRef": "<private signed evidence location>"
}
\`\`\`

关闭条件：
- 所有 P0 威胁通过可复现正反例；否则本阶段/宿主 \`BLOCKED\`。
- 对 P1 项若尚无运行条件，明确阻断原因、责任域、目标阶段与 re-entry gate；不得忽略。
- 任何对编译语义、M5 收据 v1、Program ABI 的新修改需要新契约与专门独立审查。
- 不因单一“安全扫描绿灯”替代负面 OS 访问测试。
- 建议的判停标准是“冻结攻击用例跑通且 P0/P1 结论可审计”，不是无限制的想象式 Finding 轮次。

## 6. 一致性参考

- [Existing M5 security contract](./interactive-host-security.md)
- [Proposed design](./interactive-trusted-host-security-v2-design.md)
- [Microsoft Windows pipe ACL](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)
- [Microsoft Windows file ACL/icacls](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- [Microsoft Process Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)
- [Linux scripted Host isolation](../tests/security/host-isolation.mjs)

---

**状态：威胁已登记，Phase 3/4 真实 OS / CLI 攻击测试尚未执行。** 所有测试入口不得声称现有 Grok Build Windows 同权实验已通过原生安全验收。
