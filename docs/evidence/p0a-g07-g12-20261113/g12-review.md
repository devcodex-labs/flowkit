# G12 独立审查裁决

**裁决为 BLOCKED，P0-A 发布门禁未通过。** 独立 G12 审查角色核对代码候选 `eb52a6f516d54488167481b00f2c6811fca79afb`、真实命令和原始证据，并复核了 Requirements V0.3、Technical Design V0.6-R5 和 P0-A Plan V0.1 的原始文件 SHA-256。三份均与 [G01 登记](../p0a-g01-20261112/verified-inputs.txt) 一致。代码候选的 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43402857273) 8/8。审查由独立角色只读执行。

| 核对项 | 裁决与依据 |
|---|---|
| 冻结原件和范围 | PASS，三份原件字节与登记一致。P0-B／P1／P2 继续按首发范围判为不适用。R5 首发使用新建 SQLite 库。 |
| 代码和基础构建／消费者验证 | PASS，代码候选四矩阵、类型、包消费者、文档和 OS 隔离检查通过。独立角色复跑运维和会话回归 5/5。 |
| OS 授权样本 | 双平台样本 PASS，真实普通 OS 进程发出创建和审计命令，经受信监督器转发后检查权限、旧会话失效和新连接恢复。Windows 比较 Run revision 和 Journal 行数，Linux 比较完整 SQLite 快照。生产 OS 接入、审计结果送达实际客户端、同一发布链上的 Model 回执，以及跨 Host 撤权仍为 BLOCKED。 [实测证据](../p0a-codex-isolated-20261113/g12-os-sessions.md) |
| Codex 结果校验与恢复 | 双平台样本 PASS，真实 Codex 回调提交结构合法但业务值无效的结果，分别验证重试恢复和 `FK_R004`。真实断线、供应商失败及异常协议正文仍为 BLOCKED。 [实测证据](../p0a-codex-isolated-20261113/g12-ops-r5.md) |
| 故障与运维 | 样本 PASS，新增程序级 Genesis 已提交后强杀。既有程序级切点继续有效。完整发布环境的原生切点、生产全 Store 清单及暂停入口联动、集中告警送达、长期容量和备份恢复仍为 BLOCKED。 |
| 完整来源与部署证据 | BLOCKED，适用 SEC／NAT、C12／S13／T27 和 T29 尚未满足。NAT-13 的供应商级证据单列，按其原能力探测条款裁决。 |

审查纠正了两处证据表述。OS 对端命令来自实际普通进程，审计结果由监督器核验；测试清单的待确认状态和同进程 HTTP `202` 用于验证协调与告警样本。历史 V2 迁移及兼容报告已标明适用提交，当前部署说明指向首发 R5 新库。

剩余发布门禁统一登记在 [发布矩阵](./release-matrix.md)。实际部署验收至少需要已认证的入口与客户端、实际 Host／Store 清单、告警接收端及备份恢复窗口。G17 依赖 G12 放行及用户的发布授权。

## 联合预演复审

**裁决维持 BLOCKED。** 独立角色核对 `3847277e5d6339a06e31f20fef576985e3bd1933` 的五个测试文件和 Windows 原始记录，复跑备份及运维测试 3/3 通过。另核对 Linux `8324e0c9006793cd89eb7c9f2df0db9f9cb9a6c9` 的 11 次真实普通客户端收件、R5 成对备份恢复和受控 EOF。两个平台的 App Server EOF 均发生于创建 thread 后、启动模型回合前。Linux 首次启动前的 SQLite error 14 已归档。仅调整观察包装后复测通过，根因未完全确认。三库入口联动和独立回环告警已通过 Windows 实测及 Ubuntu CI。 [实测证据与范围](../p0a-codex-isolated-20261113/staging-joint-r5.md)

待验范围包括实际发布入口的身份及租户绑定和同链 Model 回执、适用 SEC／NAT／T29 的剩余原生证据、进行中模型回合断线与供应商故障、实际全清单撤权联动、值班告警收件、长时容量及包含文件快照的实际备份恢复。G17 继续等待 G12 放行。

## 首发环境核查复审

**G12 维持 BLOCKED。** 独立角色审查 `a43ff75377ebe0938d8933074450feb62aba4c67` 的三个测试文件、Windows 原始日志和已部署探针哈希，并核对 Linux 的原始协议、普通进程身份、离线复核和归档结果，未发现阻断性问题。双平台实测了正在等待只读工具的真实回合被主动取消，以及停写备份恢复后按 proof ID 用原签名和 256 KiB 文件快照重新投递。启动时自动发现、非预期传输断开及真实供应商故障各自待验。实际首发入口、完整清单、值班接收端、负载及备份窗口仍缺。 [本轮实测与待验条件](../p0a-codex-isolated-20261113/g12-first-release-readiness.md)

## 恢复扫描与传输骤断复审

**G12 维持 BLOCKED。** 独立角色核对 `cfe47768194fb8bbaf7e817ee0efddb0e493116b` 的两个测试文件及 Windows／Linux 原始证据。已恢复库按已知 Run ID 发现一份待投递回执并复用原签名，复扫为空。真实模型工具回调已到达且尚未应答时，本地传输突然终止。Host 核对同一 Pending 和零新增回执。Linux 另核对 Model 进程退出码和 SQLite 旁读锁错误记录。实际首发的启动编排、身份与跨 Store 联动、外部值班、长时容量与备份系统，以及部署链路断线重连和供应商故障仍待验。 [本批证据与四项待提供输入](../p0a-codex-isolated-20261113/g12-recovery-transport-loss.md)

## 首发候选联合裁决

**G12 维持 BLOCKED。** 独立角色复核 `c338cd46261757e598ae63b2738c9f9d03f08be8`，确认本批已修复提案字段白名单、分支阶段约束和 Agent 初始帧绑定，补了 Genesis 提交前的实测及提交后的 Program 引用断言。尚缺的门禁限于适用 P0 与冻结计划的未齐证据。供应商签名、可选 IPC 和额外运维能力按各自原条款及启用范围裁决。 [首发候选联合验收与 G17 预检](./release-candidate-review.md)

## 首发受控 stdio P0 复审

**G12 维持 BLOCKED。** 已按用户选定的 Windows／Linux 受控 stdio 配置审查。独立角色核对 `90e20554ef5ae443fd56a662cea616723c956170` 的双平台原生回调、签名、两租户并发及拒绝记录，SEC-15 通过。复核 `f391fd07ff777a72360726ba7fd091f9aad623f5` 的 T29 测试增量，确认接纳前后按同一请求核对持久状态。实际 Model 完整权限、同链入口授权和披露、原生异常时序及供应商故障仍待取证。 [实测、原始归档与剩余 P0](./selected-stdio-p0.md)

## 受控 stdio 观察回归复审

**G12 维持 BLOCKED。** 独立角色确认 `d6bd8d839fe33d344748ee5d889f4bd901cb958f` 已同步绑定匹配响应的回合 ID，后续完成事件按线程和回合匹配。缺失、失配和迟到观察的拒绝条件有定向单测。现有探针在异常拒绝后仍可能让当次验收失败，同一 Pending 在同一 App Server 中恢复尚无证据。Linux Model 进程隔离和实际命令沙箱分开裁决。 [本批复审、实测与剩余缺口](./stdio-observation-recovery.md)

## 受控 stdio Pending 恢复回归复审

**G12 维持 BLOCKED。** 独立角色复核共享观察派发及 SQLite 回归，确认异常观察在签名和 CAS 前被拒绝，原 Pending 保留并可由下一模拟回合接纳。该结果计为 P。实际 App Server 的异常后续跑与 Linux Model 命令沙箱仍单列。 [本批范围、命令和证据](./stdio-pending-recovery.md)
