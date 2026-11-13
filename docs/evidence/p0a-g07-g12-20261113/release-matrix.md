# P0-A 发布验收矩阵

[Draft #22](https://github.com/devcodex-labs/flowkit/pull/22) 的汇总基线为 `32fec01c22a90f02535456cf099e31f7c8b0d744`，[基线 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43370955427) 8/8 通过。Requirements V0.3、Technical Design V0.6-R5、P0-A V0.1 的本地原件 SHA-256 均与 [G01 冻结登记](../p0a-g01-20261112/verified-inputs.txt) 一致。适用条款见 [SEC／NAT 原矩阵](../../interactive-trusted-host-security-v2-acceptance.md)、[C01–C12](../../interactive-complex-acceptance-c01-c12.md)、[C13–C24](../../interactive-complex-acceptance-extension-c13-c24.md) 和 [T／R／S 与 31 项计划追踪表](../p0a-g01-20261112/traceability.md)。

本次回填既有证据。**PASS** 适用于该行注明的样本和环境。**BLOCKED** 表示完整条款尚缺实测或正式裁决，已通过的子项仍保留。**N/A** 限于本批已核对的配置或发布范围。P 为程序与 OS 测试，M 为真实模型执行，T 为受保护通道中的独立观察，N 为完整原生可信验收，V 为供应商可独立验证的证明。以下原生样本为 P/M/T。Windows 与 Linux 各自在表中记录的同一候选上运行，采用各自的 Codex 版本和独立普通账户。

## 原始证据索引

| 编号 | 已实测提交 | 场景与原始记录 |
|---|---|---|
| E1 | `d9dcc0067b5d24e8a91bbe459256e99d9f285428` | 双账户普通闭环、256 KiB 文件引用、近 2 MiB 文件引用。两端各三例，接纳 revision 4、终态 9、Journal 10 条。[命令、协议日志归档和 SHA-256](../p0a-codex-isolated-20261113/live-samples.md) |
| E2 | `81a4c6e4400f95ca5dc0b771342411d0f587a464` | 两个真实会话竞争同一 Pending，唯一接纳。签后、CAS 前强杀，恢复以原签名和回执完成接纳。[日志和归档哈希](../p0a-codex-isolated-20261113/outbox-live.md#实测结果) |
| E3 | `f01f2b5c008bc3f9dba32ed72d8a5ddca7b01115` | CAS 后、Outbox `ACKED` 前强杀。两个文件大小在入口原件删除后从私有快照恢复。[日志和归档哈希](../p0a-codex-isolated-20261113/outbox-live.md#cas-后强杀和文件引用恢复) |
| E4 | `ddf8c688abaa6450c615b81e3bd0daaceaed53b8` | 签名前强杀、未接纳回执过期、仍受信旧钥的过期回执返回原 Ack。[日志和归档哈希](../p0a-codex-isolated-20261113/outbox-live.md#签名前强杀过期和轮换) |
| E5 | `ab931afe0699ca89d9f5f29aea8263caf1031cba` | 移除旧公钥后拒绝加载、恢复和旧回执重放。Store 原 Ack 和 Outbox 记录仍在。新策略下新 Run 通过。[两端日志、验签和归档哈希](../p0a-codex-isolated-20261113/revocation-retention.md#实测结果) |
| E6 | `57a39c84934071450fadbe238dcc475f50b84d30` | Windows/Linux 一次性双账户 OS 负例，包含密钥、SQLite/WAL/SHM/备份、进程权限及完整性检查。P 级。[运行命令和平台结果](../p0a-g05-g06-20261112/README.md) |
| E7 | `eb5823094cdee0f5d8fe8a558a9824e1c712db4d`、`7acdfdd0137bc34cd4407ee9ffb8c2fa1e5a18a7`、`9584184d7098a402a15f3edd8bfb11ea95f7ed49` | 64 KiB 同账户真实内联成功。256 KiB 和近 2 MiB 的内联试验均未发出工具调用。文件替换、链接、截断、摘要和重复消费有定向 P 级回归。[内联记录](../p0a-admin-codex-20261113/README.md) · [文件入口记录](../p0a-codex-file-fallback-20261113/README.md) |

## SEC · 生产配置与候选入口

| 条款 | 当前裁决 | 证据和仍需验证的内容 |
|---|---|---|
| SEC-01 | PASS，双平台测试配置 | E1 记录实际普通 Host 和 Model 的不同 SID 或 UID/GID，以及真实 App Server 身份。生产部署按最终选定配置复核。 |
| SEC-02 | BLOCKED，完整原生负例 | E6 两端保护密钥、配置和 Program 清单的路径访问，Host 签名成功。E1 有标准流继承限制。尚缺生产启动链下实际 Model 进程对密钥及可继承句柄的拒绝证据。 |
| SEC-03 | BLOCKED，完整原生负例 | E6 两端拒绝数据库、WAL、SHM、备份的路径访问和修改，完整性通过。补实际 Model 进程句柄或映射和实际配置下的保护证据。 |
| SEC-04 | BLOCKED，最终启动链 | E6 Linux 进程访问、Windows 进程和 Token 权限请求拒绝。补生产启动顺序下的进程权限负例和实际启用的服务控制。 |
| SEC-05 | BLOCKED，候选入口授权 | E1 真实 stdio 工具通道正常，E7 有错请求、错会话、缺观察的 P 级负例。补实际启用的 stdio、文件入口及其启动入口的错主体、错租户、无观察证据，断言零签名和零 CAS。 |
| SEC-06 | BLOCKED，真实入口拒绝 | 补独立 Model 账户用普通进程重放同一提交的拒绝结果，核对没有 Host 签名、接纳索引或状态推进。 |
| SEC-07 | N/A，当前配置无 TLS/mTLS IPC | 实测为受控 stdio，回环 SSH 负责启动。实际输入路径按 SEC-05 验收。 |
| SEC-08 | BLOCKED，原生身份和正文负例 | E7 有替换、截断、错 Pending 与会话的定向回归，E5 有真实策略不匹配拒绝。补实际候选入口逐项变更 Run、request、attempt、node、Program、policy 和正文，核对无写入及错误脱敏。 |
| SEC-09 | BLOCKED，真实自报身份拒绝 | E1/E2 从受保护通道取得调用 ID，由 Host 分配证明。补实际 Model 自报 proof／session 或审批字段的拒绝日志。 |
| SEC-10 | BLOCKED，完整切点矩阵 | E2/E3/E4 的签名前、签后 CAS 前和 CAS 后强杀恢复通过。发布 Pending 前后等其余适用切点按 T29 和故障矩阵核对，缺原生证据的切点保持 BLOCKED。 |
| SEC-11 | BLOCKED，完整披露矩阵 | E1 使用含 Host 私有标记的任务并走公开投影，现有 P 级回归独立检查结果读取权限。补任务、工具回复、终态和生产日志全路径标记检查。 |
| SEC-12 | BLOCKED，真实资源边界 | E1 文件入口两个大小通过。E7 内联 64 KiB 通过，两档更大内联无工具调用。补实际入口异常正文、限流／超时及内联回执上限分类。 |
| SEC-13 | BLOCKED，完整替换负例 | E7 的文件替换、硬链接、符号链接或目录联接点有 P 级证据。E5 的旧策略拒绝有双平台原生结果。补实际启动链下 Program 和所有已启用配置入口的替换负例。 |
| SEC-14 | BLOCKED，生产轮换与撤销 | E4 验证仍受信的两把钥轮换和原 Ack。E5 验证仅信任新钥时旧 Run 拒绝、旧索引保留。补实际权限变更及按部署配置适用的证书／KMS 操作、旧 Run 处置和撤销后历史对账。 |
| SEC-15 | BLOCKED，真实跨租户并发 | E2 是同租户、同 Pending 的两个会话。现有脚本测试有租户拒绝。补实际入口两个租户同 startKey 和 Run 标识的隔离证据。 |
| SEC-16 | N/A，当前 Windows 配置无 Named Pipe 候选入口 | 当前使用标准流。若发行选择 Named Pipe，按原矩阵重新裁决。 |
| SEC-17 | BLOCKED，Linux 实际 CLI 拒绝 | E6 记录受限进程的 47 项文件和进程权限拒绝，E1 记录真实 Codex 同 PID 启动、不同 UID/GID 和零能力。补真实 CLI 的相应拒绝日志。Windows 不适用。 |
| SEC-18 | PASS，双平台 Outbox 样本 | E2/E3/E4 覆盖签名前、签后 CAS 前及 CAS 后 `ACKED` 前的真实强杀、原字节验签与对账、未接纳过期拒绝和仍受信的历史 Ack。E5 单列移除公钥后的拒绝和账本保留。 |
| SEC-19 | BLOCKED，生产有界保留 | E4/E5 核对重启后原记录仍在。补期限、容量、清理、合规保留和清理后 Ack／Journal 复核，见下方待确认方案。 |

## NAT · Codex 等价验收

以下裁决适用于已确认的 Codex App Server 候选。原生 Grok 的完整验收沿用 [G03 的 PARTIAL／BLOCKED](../p0a-g03-20261112/README.md)。ChatGPT 产品专项仍按 T27 独立取证。

| 条款 | 当前裁决 | 证据和仍需验证的内容 |
|---|---|---|
| NAT-01 | BLOCKED，未授权启动负例 | E1 的真实 `flowkit_start` 使用 Host 预配置 nonce、Program 和任务。补错误 nonce、未授权 Program 或 Run 的真实拒绝和零写入。 |
| NAT-02 | PASS，样本 Public Task | E1 真实工具取得当前 Pending，日志关联 request、任务摘要和 Program。全路径披露按 SEC-11 验收。 |
| NAT-03 | PASS，小内联模型结果 | E1 普通闭环中模型真实生成并提交答案。两档大文件正文由受信合成生产者提供，模型真实提交引用。 |
| NAT-04 | PASS，小内联与已批准文件引用样本 | E1 签前核对开始和回调的 thread／turn／call、规范参数；E2/E3 导出原签名。完整大内联、缺开始事件和失配负例分别随 NAT-10、NAT-14 和 SEC-08 裁决。 |
| NAT-05 | BLOCKED，完整真实续跑与可信读取 | E1 中程序在接纳后达到终态，真实 `flowkit_continue` 读取公开终态。补有非平凡分支或下一 Pending 的真实多阶段续跑，以及单独受权的完整结果读取。 |
| NAT-06 | BLOCKED，普通进程重放 | 对应 SEC-06。补绕过实际 Codex 通道时的拒绝、零签名、零 CAS。 |
| NAT-07 | BLOCKED，自报来源 | 对应 SEC-09。补伪造来源字段无法替代独立观察的真实入口负例。 |
| NAT-08 | PASS，强杀恢复与新会话重试样本 | E4 签名前强杀后原 `OBSERVED` 不自动接纳，新会话使用新 call ID 对同一 Pending 成功重试。E2 单独验证使用原证明的自动恢复。 |
| NAT-09 | PASS，两个真实会话争同一 Pending | E2 两个独立原生回调、不同签名，唯一 `ACKED`、另一条 `CONFLICT`，Store 只有一个接纳索引。 |
| NAT-10 | BLOCKED，真实失败与传输边界 | E7 的大内联未发出工具调用，E1 已通过文件回退。补真实断线、供应商失败、非法输出和重试耗尽，核对错误分类与有界退出。 |
| NAT-11 | BLOCKED，真实模型权限负例 | E6 有跨账户 P 级拒绝。补真实模型会话的密钥、数据库、全量 State 及伪审批负例，再走合法提交。 |
| NAT-12 | BLOCKED，真实会话和版本换绑 | E5 证明改变公钥集合后的拒绝。补切换会话、模型版本或工作区后的旧调用拒绝及显式重新授权。 |
| NAT-13 | BLOCKED，V 级 | 已有 Host Ed25519 验签证据。缺供应商可验证的规范、可信公钥和实际签名。按原定义单独裁决。 |
| NAT-14 | BLOCKED，完整时序与死锁负例 | E1/E2/E3 正常路径已观察到原生开始事件、匹配规范入参后才签收。补真实候选入口缺失、迟到或失配开始事件，以及有界超时、零签名、零 CAS 的可复验记录。 |
| NAT-15 | PASS，双平台 Codex 实测样本 | E2 用原签名、回执和同一 Run 恢复签后 CAS 前切点。E3 增补文件引用与 CAS 后 Ack 修复，E4 增补真实过期拒绝。完整 N 级随 C12／S13 的组合证据复审。 |

## C01–C24 与阶段收口

[原 G11 矩阵](./matrix.md) 记录各项 P 级测试。本表回填后续真实 Codex 证据，按原条款适用范围给出当前发布裁决。

| 条款 | 当前裁决与证据 |
|---|---|
| C01 | BLOCKED，E1 是单 Agent 闭环。缺真实 4 Agent＋2 Conditions 的原生记录。 |
| C02 | BLOCKED，条件 false 有 P 证据。缺真实模型拒绝和未派发路径的组合记录。 |
| C03 | BLOCKED，有受控无效结果重放。缺原生非法输出、按同一 Run 重试并恢复。 |
| C04 | BLOCKED，重试耗尽有 P 证据。缺真实持续失败及完整工具日志。 |
| C05 | BLOCKED，E2/E3/E4 的原生强杀和恢复样本 PASS。Pending 发布及纯校验前后的完整原生故障切点归 SEC-10／T29。 |
| C06 | PASS，E2 双会话竞争和 E3 已 CAS 但未记 Ack 的恢复样本。R11 的后续多阶段丢响应有 P 证据。 |
| C07 | BLOCKED，E5 补实策略漂移拒绝。缺真实模型／宿主升级和重新授权。 |
| C08 | BLOCKED，E1/E6 补普通账户真实启动和 P 级权限拒绝。生产路径和真实披露负例按 SEC-02–06、SEC-08/11。 |
| C09 | BLOCKED，E1 补双平台大文件引用，Checkpoint 容量有 P 证据。缺完整大内联和真实异常输出的容量分类。 |
| C10 | PASS，P 级长链与持久回执，含 300 Agent 账本测量。 |
| C11 | PASS，P 级预算 1 与 128 的终态对照。 |
| C12 | BLOCKED，E1–E5 补齐多个原生子样本，完整 SEC／NAT 和来源链待复审。 |
| C13 | PASS，P 级分支与预算。 |
| C14 | PASS，P 级链中错误与超限拒绝。原生入口负例归 SEC-08/12。 |
| C15 | PASS，P 级历史重传及 E3/E4 的原生历史 Ack。撤销后的独立对账另列。 |
| C16 | BLOCKED，P 级可信失败路径已有。缺真实供应商失败。 |
| C17 | PASS，P 级策略漂移拒绝；E5 补同类原生拒绝样本。 |
| C18 | PASS，P 级多 Run 交错。 |
| C19 | PASS，P 级长链中途失败。 |
| C20 | PASS，原 P 级双进程竞争及 E2 真实双会话竞争。 |
| C21 | 同环境重开 PASS（P）。跨 Node／OS 搬移同一物理库 BLOCKED，属于增强项。发布支持的升级另在 M6 核对。 |
| C22 | BLOCKED，E1/E6 补独立身份。缺实际入口模型自报权限、伪审批及跨租户负例。 |
| C23 | BLOCKED，E2/E3/E4 补真实竞争和崩溃恢复。缺真实拒绝、非法输出重试耗尽和供应商失败的组合证据。 |
| C24 | BLOCKED，Windows/Linux × Node 22/24、包／CLI／类型和文档消费者 CI 已通过。完整原生证据、发布支持的升级与独立复审仍待完成。 |

| 冻结条款或计划项 | 后续证据对 G01 的更新 |
|---|---|
| T03、S02、T29 | E2–E4 补真实 Host 进程退出、同 Run 与原回执恢复。T29 的适用切点及 S02 的完整裁决仍待复审。 |
| T05、S05 | E5 补实际策略不符拒绝，E7 提供文件入口 P 级错请求／会话拒绝。真实入口的完整身份负例随 SEC-05/08 保持 BLOCKED。 |
| T06、T09、S04、R11 | E2/E3/E4 补同 Pending 并发、CAS 后丢 Ack 恢复及旧 Ack 样本。SQLite 已有后续多阶段丢响应的 P 级回归，外部 Store 仍须证明其声明的强一致和原子语义。 |
| T07、S06 | E5 补实公钥集合变更时的策略不匹配拒绝。支持的 SDK、Checkpoint 和 Store 升级组合仍待逐一裁决。 |
| T08、S07、T34 | E1/E7 补真实大文件引用、字节固定与路径负例的分层证据。生产资源上限、异常输出分类与全路径最小披露仍为 BLOCKED。 |
| T11、T27、S13 | E1–E5 补 Codex 真实 JS 调用与独立来源链。完整 C12／NAT 尚未签收。ChatGPT 产品专项和 Grok 原生项继续 BLOCKED。 |
| S12-A | 管理终止专用审计和 SQLite V2 迁移有 P 级正反例。生产升级与恢复演练待发行候选。 |
| T12、T28、T33、S14、A-M6-01–03 | 包导出、类型、CLI、Standard 和现有 Interactive 适用回归已在四矩阵通过。T28 的 Checkpoint 契约差异及正式复审仍开放。T33 按 P0-A 支持节点裁决。 |
| R03、A-M6-04 | 异步接缝有缺持久证据时返回 `FK_I_STORE_UNCERTAIN` 的回归。E2–E4 增补原生重启证据。外部 Store 的陈旧读、强一致及部署恢复边界以实际适配器取证。 |
| R12、A-M6-06 | P 级 300 Agent 两档预算完成 5,104／2,102 次 CAS，重开可查询全部回执并返回最早 Ack。保留已测的序列化与 WAL 样本范围。 |

- **G07–G08。** Codex 候选入口、签前绑定、双账户闭环和 Outbox 崩溃恢复样本已有实测。生产有界保留和候选入口完整负例为 BLOCKED。
- **G09–G11。** 签名接纳、唯一 CAS 与恢复已有双平台实测。完整安全矩阵、C12／S13／T27、C23 和 N 级裁决为 BLOCKED。
- **G12／M6。** 见 [冻结追踪表](../p0a-g01-20261112/traceability.md)、[兼容实现](../p0a-compat-codex-20261113/README.md) 和 [管理终止](../p0a-admin-codex-20261113/README.md)。待核对同一发行候选上的适用 T／R／S 和计划条款、Checkpoint 契约裁决、支持的升级与回滚、发布 Host 的生产验收及独立复审。P0-B／P1／P2 条款按原计划阶段判定 N/A。
- **G17。** 在 G12 收口后冻结发行范围与候选，验证发行包和安装，再按独立授权办理合并、Tag、发布和部署。

## 四项待确认契约

### 1. Checkpoint 格式

**推荐 P0-A 登记现有持久结构为明确的兼容例外。** 当前异步五操作承载现有 P0-A `RunCheckpointV1`，与 R5 §5 的嵌套 `program`、`policyIdentity`、`execution` 等字段有实质差异。发布契约应写清支持的 payload 及兼容矩阵，现有库和历史 Run 可继续使用。代价是接入方不能按 R5 全量结构直接互操作，差异需记入发行说明并留待独立复审。

**备选是本次发行前完成版本化对齐。** 冻结新的格式版本，明确旧读写方、双版本读取或离线迁移、历史回执与 Journal 的处理，再演练备份、升级和回滚。优点是发布契约与 R5 一致，代价是扩大 Store、类型和恢复回归范围。此项需要对格式及版本路径单独授权。 [当前类型声明](../../../types/interactive.d.ts) · [兼容实现范围](../p0a-compat-codex-20261113/README.md)

### 2. 旧钥撤销后的历史 Ack

**推荐撤销使旧钥停止签发和接纳，历史 Ack 走独立受权的只读对账。** 按 namespace、Run、request、node、attempt 和规范回执摘要精确匹配持久接纳记录，仅返回原接纳信息。找不到或不匹配时拒绝。发行验收须覆盖跨租户、摘要错配、未接纳旧回执、重复查询及零 CAS／Journal／Checkpoint 写入。代价是新增 Host 权限和审计面，收益是能在关闭旧信任后恢复丢失的 Ack。

**备选仅保留运维对账。** 由受权人员通过 Host 私有 Store 核对原接纳记录，接口面较小，调用方需要人工介入。E4 只证明旧钥仍受信时的过期重放。E5 证明移除旧钥后原接纳入口拒绝且账本仍在。 [当前撤销与对账记录](../p0a-codex-isolated-20261113/revocation-retention.md)

### 3. 既有 Run 信任策略迁移

**推荐正常轮换让旧 Run 按原批准策略完成，新 Run 使用新策略。** 紧急撤销时停用仍允许旧钥的 Host，既有 Run 保持阻断并交受权人员对账。优点是已冻结的策略身份和历史可完整保留。代价是紧急撤销时在途 Run 可能无法继续。

**备选是本次发行支持受控原地续跑。** 先单独确认带版本、管理授权和审计的原子迁移协议，定义 Pending 重绑、旧签名处置、新钥签发、竞态、故障恢复及旧写入方拒绝。收益是保留同一 Run 的业务连续性。代价是跨策略的恢复和签名校验更复杂，需要重新审查不变量。 [Host 轮换设计](../../interactive-trusted-host-security-v2-design.md#63-错误和恢复) · [E5 现有行为](../p0a-codex-isolated-20261113/revocation-retention.md)

### 4. Outbox 保留与容量

**推荐由 Host 部署配置设定审计期限和容量上限。** 保留待投递的 `SIGNED`、未对账的 `OBSERVED`／`BLOCKED`／`CONFLICT`、受合规保留或有效引用的快照，以及 Store 接纳索引。终态且已对账的数据过审计窗口后才清理可回收正文和快照。达到容量上限时停止接收需要落盘的新工作并告警。具体天数与字节上限按目标部署的合规、吞吐和磁盘预算确认，随后实测容量、清理崩溃恢复和历史对账。

**备选由受权人员在同一保留约束下执行清理。** 可减少首版后台清理逻辑，增加值守成本与容量告警响应时间。当前只验证记录留存及过期引用的局部行为。 [Outbox 设计 §6.4](../../interactive-trusted-host-security-v2-design.md#64-host-only-观察证据与签名回执-outbox关闭-dr-13) · [保留实测](../p0a-codex-isolated-20261113/revocation-retention.md)
