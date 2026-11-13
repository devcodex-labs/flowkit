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
| E8 | `d3674bca09d305f88828a77b1d3653937fc5da5e`、`5efa127cf8a26081985e454b9719619a39fdc4b2` | R5 恢复基线、validate 阶段恢复、撤销后原 Ack、两个独立 Store 分别撤销、Outbox 满额和清理。[平台裁决、命令、原始日志与 SHA-256](../p0a-codex-isolated-20261113/r5-release-live.md) |
| E9 | `e0df84b23ec78b49fd8beb8e800076ce27102c74` | Windows／Linux 双账户均通过文件快照清理两处强杀、两 Store 撤销协调演练、磁盘采样和本机容量告警，各 10 个真实会话。[命令、磁盘样本、归档 SHA-256 和参数建议](../p0a-codex-isolated-20261113/ops-r5-live.md) |
| E10 | `0d1da06bb3f8e56ebc54a2d32619c83d3cadea34` | Windows／Linux 双账户各 18 个真实模型回合。4 Agent＋2 Conditions 多阶段续跑、受权终态读取、早拒与缺值零派发、错请求和扣留观察拒绝。[分平台结果、命令和原始归档 SHA-256](../p0a-codex-isolated-20261113/branch-r5-live.md) |
| E11 | `60b745e1708f2e7c10b88254912fa074b9489d3e` | Windows／Linux 各 7 个真实 Codex 回合，测试主体／租户绑定、同 startKey 和 RunId 隔离、观察失配／超时／迟到与两笔合法接纳。[分平台实测、原始命令与归档 SHA-256](../p0a-codex-isolated-20261113/entry-r5-live.md) |
| E12 | `2f6a6738c5ffc12459bb271823d2468c3b2731cf` | 真实普通 OS 身份预绑定，两租户 stdio 和文件入口并发，拒绝错配及独立审计权限。[分平台实测、原始命令与归档 SHA-256](../p0a-codex-isolated-20261113/os-r5-live.md) |
| E13 | `3fd1d2f9fb8a59abf74fca86136cb0bed3eef806` | 已暂存、未消费的有效文件引用跨租户拒绝，以及 Host stdio 授权撤销后旧会话失效。[分平台实测、命令与归档 SHA-256](../p0a-codex-isolated-20261113/session-r5-live.md) |
| E14 | `9ba894ce702d84e20d9a51a57d015e225774b851` | 独立普通 OS 对端进程的创建和审计命令、会话撤权、新连接恢复。[OS 会话实测与证据](../p0a-codex-isolated-20261113/g12-os-sessions.md) |
| E15 | `eb52a6f516d54488167481b00f2c6811fca79afb` | 三测试 Store 撤销、96 次接纳与本机 HTTP 告警、Genesis 强杀、真实 Codex 无效结果和重试。[故障与运维实测](../p0a-codex-isolated-20261113/g12-ops-r5.md) |
| E16 | `8324e0c9006793cd89eb7c9f2df0db9f9cb9a6c9`、`3847277e5d6339a06e31f20fef576985e3bd1933` | Windows／Linux 隔离实验室联合预演。双平台普通审计员进程收件、受控 App Server EOF 和 R5 成对备份。三库撤销联动与独立进程持久化告警通过 Windows 实测和 Ubuntu CI。[命令、场景边界和归档哈希](../p0a-codex-isolated-20261113/staging-joint-r5.md) |
| E17 | `a43ff75377ebe0938d8933074450feb62aba4c67` | Windows／Linux 隔离环境中主动取消正在运行的 Codex 模型回合，以及含 256 KiB 私有文件快照的三库恢复。[实测与首发环境缺口](../p0a-codex-isolated-20261113/g12-first-release-readiness.md) |
| E18 | `cfe47768194fb8bbaf7e817ee0efddb0e493116b` | 恢复后按 Run ID 自动发现已签回执，真实模型回合等待工具时传输骤断，以及首发等价配置预演。[实测、命令和首发输入](../p0a-codex-isolated-20261113/g12-recovery-transport-loss.md) |
| E19 | `c338cd46261757e598ae63b2738c9f9d03f08be8` | 核对现有双平台证据、R5 提案字段与阶段校验、Genesis 前后强停、G17 本地包预检。[同批裁决](./release-candidate-review.md) |
| E20 | `90e20554ef5ae443fd56a662cea616723c956170`、`f391fd07ff777a72360726ba7fd091f9aad623f5` | Windows／Linux 首发受控 stdio 的原生租户绑定与回执复核，以及 12 个恢复切点的逐点持久化断言。[首发 P0 验收](./selected-stdio-p0.md) |
| E21 | `d6bd8d839fe33d344748ee5d889f4bd901cb958f` | 选定 stdio 的观察拒绝与回合绑定回归，以及常规原生回合复验。[分平台结果、复审与归档](./stdio-observation-recovery.md) |
| E22 | `2594511d058da47f8cad43e57de48c23db8abf0e` | 共享观察派发与真实 SQLite 的 P 级恢复回归，拒绝后零签名、零 CAS，原 Pending 可由下一模拟回合接纳。[实测与剩余缺口](./stdio-pending-recovery.md) |

## SEC · 生产配置与候选入口

| 条款 | 当前裁决 | 证据和仍需验证的内容 |
|---|---|---|
| SEC-01 | PASS，双平台测试配置 | E1 记录实际普通 Host 和 Model 的不同 SID 或 UID/GID，以及真实 App Server 身份。生产部署按最终选定配置复核。 |
| SEC-02 | BLOCKED，完整原生负例 | E6 两端保护密钥、配置和 Program 清单的路径访问，Host 签名成功。E1 有标准流继承限制。尚缺生产启动链下实际 Model 进程对密钥及可继承句柄的拒绝证据。 |
| SEC-03 | BLOCKED，完整原生负例 | E6 两端拒绝数据库、WAL、SHM、备份的路径访问和修改，完整性通过。补实际 Model 进程句柄或映射和实际配置下的保护证据。 |
| SEC-04 | BLOCKED，最终启动链 | E6 Linux 进程访问、Windows 进程和 Token 权限请求拒绝。补生产启动顺序下的进程权限负例和实际启用的服务控制。 |
| SEC-05 | BLOCKED，启用入口完整授权 | E10–E13 覆盖真实错请求、缺观察、主体与文件引用错配。E14/E16 补普通 OS 客户端与审计收件，E20 在选定 stdio 验证实际模型身份及回调授权。操作员创建、同一 Run 的真实 Model 回执及审计客户端交付仍需联证。 |
| SEC-06 | BLOCKED，真实入口拒绝 | 补独立 Model 账户用普通进程重放同一提交的拒绝结果，核对没有 Host 签名、接纳索引或状态推进。 |
| SEC-07 | N/A，当前配置无 TLS/mTLS IPC | 实测为受控 stdio，回环 SSH 负责启动。实际输入路径按 SEC-05 验收。 |
| SEC-08 | BLOCKED，原生身份和正文负例 | E7 有替换、截断、错 Pending 与会话的定向回归，E5 有真实策略不匹配拒绝。补实际候选入口逐项变更 Run、request、attempt、node、Program、policy 和正文，核对无写入及错误脱敏。 |
| SEC-09 | BLOCKED，真实自报身份拒绝 | E1/E2 从受保护通道取得调用 ID，由 Host 分配证明。补实际 Model 自报 proof／session 或审批字段的拒绝日志。 |
| SEC-10 | BLOCKED，选定宿主完整切点 | E2/E3/E4 的签名前、签后 CAS 前和 CAS 后强杀恢复通过，E8 覆盖真实接纳后校验恢复。E19/E20 补 Genesis 前后与 12 个 SQLite 切点逐点验证。选定宿主上的组合证据随 T29 裁决。 |
| SEC-11 | BLOCKED，完整披露矩阵 | E1/E10 覆盖任务、工具回复、终态投影，E20 复核 E10 原始 Model 协议无 Host 私有标记。完整日志可见性与授权审计的同链覆盖仍缺。 |
| SEC-12 | BLOCKED，真实资源边界 | E1 文件入口两个大小通过。E7 内联 64 KiB 通过，两档更大内联无工具调用。补实际入口异常正文、限流／超时及内联回执上限分类。 |
| SEC-13 | BLOCKED，完整替换负例 | E7 的文件替换、硬链接、符号链接或目录联接点有 P 级证据。E5 的旧策略拒绝有双平台原生结果。补实际启动链下 Program 和所有已启用配置入口的替换负例。 |
| SEC-14 | BLOCKED，生产轮换与撤销 | E4/E5/E8/E9 覆盖正常轮换、原 Ack 和分别撤销。E15/E16 补三个测试 Store 的部分撤销、测试入口阻断及逐库确认后的恢复。生产全量清单、入口暂停、实际权限变更及适用的证书／KMS 操作待测。 |
| SEC-15 | PASS，已选 Windows／Linux 受控 stdio | E20 两个经 OS 核验的主体与租户使用同 startKey、同 RunId 并发接纳，独立回执和 Journal，错租户拒绝且状态不变。完整同链授权与审计交付归 SEC-05／11。 |
| SEC-16 | N/A，当前 Windows 配置无 Named Pipe 候选入口 | 当前使用标准流。若发行选择 Named Pipe，按原矩阵重新裁决。 |
| SEC-17 | BLOCKED，Linux 实际 CLI 拒绝 | E6 有 47 项受限进程拒绝。E21 复核实际 Model 身份、零能力和 `no_new_privs=1`。既有双账户容器的命令沙箱无法创建用户命名空间，描述符类型观察受限。E22 在另一托管执行器核对普通账户能启动本地沙箱，仍缺同一双账户目标证据。Windows 不适用。 |
| SEC-18 | PASS，双平台 Outbox 样本 | E2/E3/E4 覆盖签名前、签后 CAS 前及 CAS 后 `ACKED` 前的真实强杀、原字节验签与对账、未接纳过期拒绝和仍受信的历史 Ack。E8 增补 R5 已接纳回执在 validate 阶段强杀后的恢复。 |
| SEC-19 | BLOCKED，生产有界保留 | E8/E9 覆盖真实工具满额、清理回滚、快照清理强杀和分配块采样。E16 补 128 次接纳、八轮满额与清理、独立回环进程持久化告警。E17/E18 补三库联合恢复、按 Run 自动发现及二次扫描幂等。生产保留期限、持续容量、值班端送达及实际备份系统和启动编排仍待取证。 |

## NAT · Codex 等价验收

以下裁决适用于已确认的 Codex App Server 候选。原生 Grok 的完整验收沿用 [G03 的 PARTIAL／BLOCKED](../p0a-g03-20261112/README.md)。ChatGPT 产品专项仍按 T27 独立取证。

| 条款 | 当前裁决 | 证据和仍需验证的内容 |
|---|---|---|
| NAT-01 | BLOCKED，未授权启动负例 | E1 的真实 `flowkit_start` 使用 Host 预配置 nonce、Program 和任务。补错误 nonce、未授权 Program 或 Run 的真实拒绝和零写入。 |
| NAT-02 | PASS，样本 Public Task | E1 真实工具取得当前 Pending，日志关联 request、任务摘要和 Program。全路径披露按 SEC-11 验收。 |
| NAT-03 | PASS，小内联模型结果 | E1 普通闭环中模型真实生成并提交答案。两档大文件正文由受信合成生产者提供，模型真实提交引用。 |
| NAT-04 | PASS，小内联与已批准文件引用样本 | E1 签前核对开始和回调的 thread／turn／call、规范参数；E2/E3 导出原签名。完整大内联、缺开始事件和失配负例分别随 NAT-10、NAT-14 和 SEC-08 裁决。 |
| NAT-05 | PASS，双平台 Codex 实测样本 | E10 同一 Run 依次读取四个合法 Pending，公开终态无私有 State。探针在 Host 私有进程验证普通权限拒绝及受权完整读取。发布启动链和实际审计主体仍待 G12 确认。 |
| NAT-06 | BLOCKED，普通进程重放 | 对应 SEC-06。补绕过实际 Codex 通道时的拒绝、零签名、零 CAS。 |
| NAT-07 | BLOCKED，自报来源 | 对应 SEC-09。补伪造来源字段无法替代独立观察的真实入口负例。 |
| NAT-08 | PASS，强杀恢复与新会话重试样本 | E4 签名前强杀后原 `OBSERVED` 不自动接纳，新会话使用新 call ID 对同一 Pending 成功重试。E2 单独验证使用原证明的自动恢复。 |
| NAT-09 | PASS，两个真实会话争同一 Pending | E2 两个独立原生回调、不同签名，唯一 `ACKED`、另一条 `CONFLICT`，Store 只有一个接纳索引。 |
| NAT-10 | BLOCKED，真实失败与传输边界 | E7 的大内联未发出工具调用，E1 已通过文件回退。E15 补业务非法值和重试耗尽，E16 补回合前受控 EOF，E17 补主动取消，E18 补真实模型回合等待工具时的本地传输骤断。两种回合中断均保留同一 Pending。仍需验证实际部署链路上的断开和重连、供应商失败、异常协议正文及有界退出。 |
| NAT-11 | BLOCKED，真实模型权限负例 | E6 有跨账户 P 级拒绝。补真实模型会话的密钥、数据库、全量 State 及伪审批负例，再走合法提交。 |
| NAT-12 | BLOCKED，真实会话和版本换绑 | E5 证明改变公钥集合后的拒绝。补切换会话、模型版本或工作区后的旧调用拒绝及显式重新授权。 |
| NAT-13 | BLOCKED，V 级 | 已有 Host Ed25519 验签证据。缺供应商可验证的规范、可信公钥和实际签名。按原定义单独裁决。 |
| NAT-14 | BLOCKED，选定入口的原生异常时序 | E20 验证选定入口正常原生签前事件匹配。E11 验证独立回调路径的异常拒绝。E21 补选定探针的即时拒绝与回合绑定。E22 验证共享派发拒绝后零签名、零 CAS 及原 Pending 后续接纳，证据为 P。所选 App Server 实际异常后的有界结束和同一 Pending 续跑仍缺原生证据。 |
| NAT-15 | PASS，双平台 Codex 实测样本 | E2 用原签名、回执和同一 Run 恢复签后 CAS 前切点。E3 增补文件引用与 CAS 后 Ack 修复，E4 增补真实过期拒绝。完整 N 级随 C12／S13 的组合证据复审。 |

## C01–C24 与阶段收口

[原 G11 矩阵](./matrix.md) 记录各项 P 级测试。本表回填后续真实 Codex 证据，按原条款适用范围给出当前发布裁决。

| 条款 | 当前裁决与证据 |
|---|---|
| C01 | PASS，E10 双平台 4 Agent＋2 Conditions 的真实工具续跑，逐次核对声明输入、四份接纳和终态 State。 |
| C02 | PASS，E10 双平台真实工具提交审查拒绝后终态 `failed`，初始 false 及缺值均为零 Agent 派发。模型按用例指定的分支值提交。 |
| C03 | PASS，E15 的真实 Codex 业务校验样本。在同一 Run 用新 requestId 重试成功，非法值未合并。异常协议正文归 NAT-10。 |
| C04 | PASS，E15 的真实 Codex 业务校验样本。两次无效结果进入 `FK_R004`，无非法状态合并，保留原始工具日志。 |
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
| C15 | PASS，P 级历史重传、E3/E4 原生历史 Ack。E8 增补真实回执撤销后及清理后的受权历史对账样本。E9 文件快照清理强杀恢复后仍返回原 Ack。 |
| C16 | PASS，按冻结场景的 P 级断言。可信 Host 签名失败回执、重试、原 Ack 和第二次响应成功已有回归。真实供应商失败另归 NAT-10。 |
| C17 | PASS，P 级策略漂移拒绝；E5 补同类原生拒绝样本。 |
| C18 | PASS，P 级多 Run 交错。 |
| C19 | PASS，P 级长链中途失败。 |
| C20 | PASS，原 P 级双进程竞争及 E2 真实双会话竞争。 |
| C21 | 同环境重开 PASS（P）。跨 Node／OS 搬移同一物理库 BLOCKED，属于增强项。发布支持的升级另在 M6 核对。 |
| C22 | BLOCKED，E1/E6 补 OS 身份，E11 补测试主体及租户错配。实际发布主体、模型自报权限、伪审批仍待取证。 |
| C23 | BLOCKED，完整 N 级。真实拒绝分支 E10、重试耗尽 E15、强停恢复 E2–E4/E8、双会话竞争 E2 均有分项实测。完整原生故障与来源链按 C12 和 NAT 裁决。 |
| C24 | BLOCKED，Windows/Linux × Node 22/24、包／CLI／类型和文档消费者 CI 已通过。完整原生证据、发布支持的升级与独立复审仍待完成。 |

| 冻结条款或计划项 | 后续证据对 G01 的更新 |
|---|---|
| T03、S02、T29 | E2–E4/E8 补真实 Host 进程退出、同 Run、原回执和已接纳候选续跑。E19 与既有切点测试记录 F01–F05、F07–F10 的程序级实测。实际选定宿主的组合验证与完整断言仍待裁决。 |
| T05、S05 | E5 补实际策略不符拒绝，E7 提供文件入口 P 级错请求／会话拒绝。真实入口的完整身份负例随 SEC-05/08 保持 BLOCKED。 |
| T06、T09、S04、R11 | E2/E3/E4 补同 Pending 并发、CAS 后丢 Ack 恢复及旧 Ack 样本。SQLite 已有后续多阶段丢响应的 P 级回归，外部 Store 仍须证明其声明的强一致和原子语义。 |
| T07、S06 | E5 补实公钥集合变更时的策略不匹配拒绝。支持的 SDK、Checkpoint 和 Store 升级组合仍待逐一裁决。 |
| T08、S07、T34 | E1/E7 补真实大文件引用、字节固定与路径负例的分层证据。生产资源上限、异常输出分类与全路径最小披露仍为 BLOCKED。 |
| T11、T27、S13 | E1–E5 补 Codex 真实 JS 调用与独立来源链。完整 C12／NAT 尚未签收。ChatGPT 产品专项和 Grok 原生项继续 BLOCKED。 |
| S12-A | 首发新建 R5 库，管理终止和专用审计的 P 级正反例通过。历史 V2 迁移只用于对应实验。部署备份恢复仍待验证。 |
| T12、T28、T33、S14、A-M6-01–03 | 包导出、类型、CLI、Standard 和现有 Interactive 适用回归已在四矩阵通过。T28 的 Checkpoint 契约差异及正式复审仍开放。T33 按 P0-A 支持节点裁决。 |
| R03、A-M6-04 | 异步接缝有缺持久证据时返回 `FK_I_STORE_UNCERTAIN` 的回归。E2–E4 增补原生重启证据。外部 Store 的陈旧读、强一致及部署恢复边界以实际适配器取证。 |
| R12、A-M6-06 | P 级 300 Agent 两档预算完成 5,104／2,102 次 CAS，重开可查询全部回执并返回最早 Ack。保留已测的序列化与 WAL 样本范围。 |

- **G07–G08。** Codex 候选入口、签前绑定、双账户闭环和 Outbox 崩溃恢复样本已有实测。生产有界保留和候选入口完整负例为 BLOCKED。
- **G09–G11。** 签名接纳、唯一 CAS 与恢复已有双平台实测。完整安全矩阵、C12／S13／T27、C23 和 N 级裁决为 BLOCKED。
- **G12／M6。** 独立审查角色已给出 **BLOCKED** 裁决，详见 [G12 独立审查](./g12-review.md)。P0-B／P1／P2 条款按原计划阶段判定 N/A。 [冻结追踪表](../p0a-g01-20261112/traceability.md) · [历史兼容实验](../p0a-compat-codex-20261113/README.md) · [管理终止历史实验](../p0a-admin-codex-20261113/README.md)
- **G17。** 在 G12 收口后冻结发行范围与候选，验证发行包和安装，再按独立授权办理合并、Tag、发布和部署。

## 四项已确认的首发契约

首发测试库按 R5 结构重建，开发期归档保留用于证据复核。后续真实 Codex 双账户结果和原始日志索引见 [R5 首发候选复验](../p0a-codex-isolated-20261113/r5-release-live.md)。生产运维演练及正式裁决仍为 BLOCKED。

### 1. Checkpoint 格式

首发直接采用 R5 §5 的 `RunCheckpointV1`，包括异步 Store 契约及 SQLite 持久化内容。首发测试库重建。验证新建、暂停和跨进程恢复、首次接纳与历史 Ack、终态及专用管理审计。 [类型声明](../../../types/interactive.d.ts)

### 2. 旧钥撤销后的历史 Ack

撤销使旧钥停止签发和接纳。历史 Ack 走独立受权的 Host 私有只读对账，按 namespace、Run、request、node、attempt 和规范回执摘要精确匹配持久接纳记录，仅返回原接纳信息。验证跨租户、摘要错配、未接纳旧回执、重复查询和零 CAS／Journal／Checkpoint 写入。 [撤销实测基线](../p0a-codex-isolated-20261113/revocation-retention.md)

### 3. 既有 Run 信任策略迁移

正常轮换让旧 Run 按原批准策略完成，新 Run 使用新策略。紧急撤销时停用仍允许旧钥的 Host，既有 Run 保持阻断并交受权人员对账。原地换策略续跑留待后续专项设计。生产验收覆盖所有启用 Host 对撤销的生效。 [Host 轮换设计](../../interactive-trusted-host-security-v2-design.md#63-错误和恢复)

### 4. Outbox 保留与容量

Host 部署配置保留期限和容量上限。保留待投递及未对账的记录、受合规保留或有效引用的快照和 Store 接纳索引。终态且已对账的数据过保留窗口后，由受权运维触发清理。达到容量上限时停止接收需落盘的新工作并告警。生产参数等待压测和确认。 [Outbox 设计 §6.4](../../interactive-trusted-host-security-v2-design.md#64-host-only-观察证据与签名回执-outbox关闭-dr-13) · [参数建议与实测占用](../p0a-codex-isolated-20261113/ops-r5-live.md)

| 首发回归 | 可复核的 P 级覆盖 | 仍为 BLOCKED |
|---|---|---|
| R5 Checkpoint | SQLite 原字节与异步 Store 回读一致、首次接纳、管理审计和包消费者。[版本化 SDK 回归](../../../tests/interactive/versioned.test.mjs) · E8 记录真实强杀恢复。 | [G12 裁决](./g12-review.md) 的完整原生故障矩阵与发布恢复验证。 |
| Ack、轮换与撤销 | 两条 SQLite 连接验证旧策略停止新建及撤销边界。[Host 回归](../../../tests/interactive/trusted-host.test.mjs) · E8 记录独立 Store 分别撤销及受权历史查询。E9 记录部分失败、补撤销和逐库确认。 | 生产所有 Host／Store 的协调、撤销后签发停止及轮换演练。 |
| Outbox 容量和清理 | [Outbox 回归](../../../tests/interactive/codex-outbox.test.mjs) 覆盖文件快照回收中断重试。E8 验证真实工具满额、清理回滚及恢复。E9 增补快照清理两处强杀、分配块采样和本机告警。 | 生产容量和保留窗口、集中告警送达及持续负载下的磁盘占用。配额计入活动记录和待清理引用的逻辑字节，数据库页、WAL、文件快照和审计另计。 |
