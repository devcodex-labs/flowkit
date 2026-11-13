# G12 故障与运维验收

代码候选 `eb52a6f516d54488167481b00f2c6811fca79afb`。测试使用临时数据库、合成输入和同一测试进程内的 HTTP 回环接收器。

## 可重复的程序级演练

```text
node --test tests/interactive/p0a-ops.test.mjs
```

Windows Node 24.22.2 三项通过。

| 样本 | 结果 |
|---|---|
| 三个测试 Store 的撤销协调 | 首轮 `store-b` 未授权，测试协调逻辑将它保留在待确认清单。补授权后，三个 Store 分别确认撤销。各 Store 拒绝一份旧签名的未接纳回执，原始 Checkpoint、Journal 和接纳索引保持一致，三个历史 Ack 可读取，新策略可创建 Run。 |
| 有界持续负载与告警 | 六轮各接纳 16 个 Run，共 96 次。每轮达到 16 条测试容量上限时拒绝新增回执并收到本机 HTTP `202`，原 Pending、Journal 和接纳索引未变。受权清理后本轮 16 条 Outbox 记录全部回收，再进入下一轮。 |
| Genesis 已提交、响应前强杀 | Node 子进程报告 Genesis 已提交后立即终止。新进程两次提交相同 startKey 均复用同一个 Run 和 Pending，revision 3、四行 Journal、零接纳回执。 |

Windows 有界测试运行约 3.23 秒。每轮逻辑保留量 81,948 B。SQLite、WAL、SHM 文件长度总和在末轮满额时为 8,776,744 B，清理后采样为 8,813,824 B。生产需要按部署文件系统、压测峰值和恢复余量另行确认磁盘预算。此测试以文件长度计量，包含 Store 和 Outbox，保留 Journal 增长。

## Windows 双账户真实 Codex App Server

```text
node tests/security/p0a-ops-codex.mjs <Codex> <Model工作目录> <全新Host私有证据目录>
```

`p0a-ops-20261113173715` 退出码 0。四次真实工具提交经受信通道独立核对开始事件、线程、回合、调用及参数。Host 用真实 SQLite 和 Outbox 签收，并记录完整 Journal。

| 样本 | 结果 |
|---|---|
| 无效业务结果后重试恢复 | 第一次提交被业务校验拒绝，Run 保持同一 ID，产生新的 requestId，非法结果未合并。第二次合法提交成功，终态 revision 13、Journal 14 行、两份可查 Ack。 |
| 无效业务结果用尽重试 | 两次真实提交均未通过业务校验，终态 `errored`、`FK_R004`，无非法状态合并。终态 revision 9、Journal 10 行、两份可查 Ack。 |

独立离线复核将四份签名字节、四个 App Server 原始工具回调和接纳 revision 对齐。回环监听已收回。Windows 归档 `FlowKit-Windows-G12-Ops-R5-20261113.zip` 的 SHA-256 为 `1e33cd8aef6802dcdb8c44f924449679705e53f17b708768338b92523c72c617`，18 个归档成员的哈希已逐项复核。

## Linux

FlowKit 快进拉取 `eb52a6f`，相同程序级命令 3/3 通过。96 次接纳与 6 次回环 HTTP `202`，末轮满额时数据库、WAL、SHM 文件长度合计 8,768,552 B，清理后采样 8,805,632 B。Genesis 后进程退出信号为 `SIGKILL`。

真实 Codex 四回合首次通过，约 29 秒。两组接纳 revision 均为 4、8；分别在 revision 13 成功和 revision 9 以 `FK_R004` 终止。独立复核四份签名、两条共 24 行 Journal，Outbox 均为 `ACKED`。`FlowKit-Linux-P0A-Ops-20261113.zip` 的 SHA-256 为 `0097b047fef610ce32ece8addd3a4cde423d2594db679ee25fac7132c1841a96`，156 份文件已逐项复核。精确命令、原始日志和归档由 [FlowKit 任务](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable) 保管。

## 证据边界

三个 Store 是完整的测试清单。清单的待确认状态由测试协调逻辑记录，本轮没有外部入口流量联锁。生产入口的暂停联动、生产 Store 全量清单、集中告警到达值班方、生产持续负载与备份恢复仍为 BLOCKED。`202` 来自同进程 HTTP 回环接收器。测试配额及保留时间未写入产品默认值。模型按用例提交结构有效、业务值无效的结果，真实供应商故障、非法协议正文及完整原生强杀矩阵仍待验证。

证据回填后的 Windows Node 22 CI 曾在回环告警样本中报 `fetch failed`。后续提交只调整测试发送端，使用显式的回环 HTTP 请求、每次独立连接和 15 秒上限，继续核对真实 `202` 和原有数据库断言。真实 Codex 探针及已归档的运行保持原提交身份。 [首次失败的 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43404514044)
