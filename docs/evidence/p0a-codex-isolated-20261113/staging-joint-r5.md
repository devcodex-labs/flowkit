# G12 联合预演与证据

本轮使用现有隔离实验环境。基线为 `00f840029d82e069f844aec68732d0989a3d0f6e`。操作员、审计员、App Server 及成对备份探针对应 `8324e0c9006793cd89eb7c9f2df0db9f9cb9a6c9`。测试入口撤销联动与告警探针对应 `3847277e5d6339a06e31f20fef576985e3bd1933`。两个候选之间仅增补后两项测试。增量代码 diff SHA-256 为 `d32eccf4dcf7b2bc7db0260cb2332b3cf356fb93b6585f14b6ba3b376a549305`。本轮复核三份冻结原件及附属文件的字节数和 SHA-256，与 [G01 登记](../p0a-g01-20261112/verified-inputs.txt) 一致。 [代码候选 CI 8/8](https://github.com/devcodex-labs/flowkit/actions/runs/43406489736)

## Windows 实测

| 场景 | 结果与证据等级 |
| --- | --- |
| 客户端收件与撤权 | P。Host、操作员 A/B、审计员以普通账户实际启动。操作员创建各自租户的同 RunId，审计员进程通过其输入管道收到本租户私有状态。跨租户拒绝。撤权后旧会话拒绝，恢复授权也无法复用旧连接。新普通进程重连成功，拒绝前后 Store 观测值一致。 |
| App Server 传输关闭 | P/T。两个普通账户经现有固定启动链启动真实 App Server，初始化并创建临时 thread。客户端在 `turn/start` 前关闭标准输入，观察到进程以 0 退出。Checkpoint、Journal 和 Outbox 观测值不变，恢复同一 Pending，零新回执。收尾时测试监听数为 0。 |
| R5 成对备份 | P。停止写入后，对 Store 与 Outbox 分别执行 SQLite `VACUUM INTO`，检查完整性并计算各自 SHA-256。副本在新路径恢复，原 Ack 和已签名未接纳回执均在 revision 4 得到对应 Ack，保留原签名，源库观测值不变。使用测试签名和有效期内的固定时钟。 |
| 三库撤销联动 | P。部分撤销未确认时，测试入口拒绝三次接纳。全部确认后，三个 Store 均拒绝旧签名待接纳回执，并允许新策略接纳。拒绝前后 Checkpoint、Journal 与回执索引一致。 |
| 满额和告警 | P。Windows Node 22.13.0 和 24.22.2 分别完成 128 次接纳及 8 轮清理。独立回环 HTTP 进程先把 8 份告警持久化，再分别返回 202。Node 22 样本耗时约 7.19 秒，最后满额时 SQLite/WAL/SHM 文件合计 10,236,104 B，清理后 10,273,184 B。该值为短时样本的文件长度。 |

实际启动与协议参数收录在归档脚本和原始记录。Windows 先用管理员 PowerShell 启动实验监督器，业务 Host 和各对端保持普通身份。

```powershell
git -c core.autocrlf=false -c core.eol=lf archive --format=tar --output=<证据目录>/source.tar 8324e0c9006793cd89eb7c9f2df0db9f9cb9a6c9
powershell.exe -NoProfile -File <证据目录>/windows-os-session.ps1 -Output <证据目录>
powershell.exe -NoProfile -File <证据目录>/windows-deploy-and-run.ps1 -Output <证据目录>
node --test tests/interactive/p0a-staging-backup.test.mjs
node --test tests/interactive/p0a-staging-ops.test.mjs
```

`FlowKit-Windows-Staging-Joint-R5.zip` SHA-256 为 `5eccd71886d1e4c2681666a4978b93fc50841cce6df14ca21e25a90e8d3f9f88`，18 项逐项核对。包含候选 SHA、启动脚本、OS 进程交付记录、App Server 原始请求和响应、监听收尾及定向测试日志。`WINDOWS-SHA256SUMS.txt` 自身 SHA-256 为 `55cf0816904b90af793cb6d74ecf8f4b048c995baa70fb748180eabedb87afd2`。

## Linux

独立普通 OS 账户实测证据待收。GitHub Actions 中的程序测试与双账户 Codex 实测分别登记。

## 发布待验

- 在实际入口核对身份、租户、审计客户端与真实 Model 回执的同链联动，并验证实际 Host／Store 清单上的跨 Host 撤权和暂停接纳。
- 使用生产等价告警通道，核对值班端收件、容量和保留窗口。备份恢复使用实际备份系统、密钥配置和纳入文件回退的备份集。维护窗口与容量参数待确认。
- 补正在执行的模型回合中的连接中断、实际供应商失败及剩余适用原生安全与故障切点。受控 EOF 在任何模型回合开始前执行，证据等级为 P/T。
