# G12 恢复扫描与回合中传输骤断

起始候选 `0a2b5fca993d615048c517cbe0a9e3fc527f7650` 的 [CI 8/8 通过](https://github.com/devcodex-labs/flowkit/actions/runs/43413583007)。实测候选为 `cfe47768194fb8bbaf7e817ee0efddb0e493116b`，其 [CI 8/8 通过](https://github.com/devcodex-labs/flowkit/actions/runs/43418066780)。两份测试文件的增量 diff SHA-256 为 `cad8aa949cd86dc4e474efad9a90f6f1878174434583077324d43718ae557d98`。复核三份冻结原件及附属文件的字节数与 SHA-256，均与 [G01 登记](../p0a-g01-20261112/verified-inputs.txt) 一致。

## Windows 实测

- **恢复后按 Run 发现已签回执，P。** 停写后备份并重开 Store、Outbox 和启用时的文件交接库。只传 Run ID 给 `outbox.recover(runId)`，原已确认 Run 无待投递记录，目标 Run 恰好发现一份已签回执。恢复后为 `ACKED`，复用原签名，文件变体保留 262,144 B 私有快照，原 Ack 和恢复 Ack 均为 revision 4。再次扫描返回空，Checkpoint、Journal、接纳索引及源库保持原状。扫描由测试显式调用，发布服务的启动编排和全 Run 清单待验。
- **进行中真实回合的本地传输骤断，P/M/T。** 专用普通 Host、Model 以固定回环 SSH 启动真实 App Server。收到同一 thread/turn/call 的 `probe_hold({})` 开始事件和工具回调后，在工具仍未应答、回合终态尚未到达时强停探针自己的 SSH 子进程，退出信号为 `SIGKILL`。协议未发送取消请求，未收到回合完成事件。恢复仍是原 Pending，零签名、零新增回执，Checkpoint、Journal、Outbox 与回执索引保持一致。收尾时 Model 和传输 PID 已不在，测试监听数为零。
- **首发等价配置预演，P。** 复用既有固定启动器、两个测试租户和普通操作员／审计员。6 次进程启动及退出通过，11 个回复由对端实际收到，撤权后旧连接拒绝，新连接可用。Node 22.13.0 与 24.22.2 各通过备份和运维测试 4/4，包含三测试 Store 的撤权联动，以及独立回环进程收件的 8 轮容量告警和清理。测试参数为 16 条硬上限、128 次接纳，作为短时预演。

```powershell
volta run --node 22.13.0 node --test tests/interactive/p0a-staging-backup.test.mjs tests/interactive/p0a-staging-ops.test.mjs
node --test tests/interactive/p0a-staging-backup.test.mjs tests/interactive/p0a-staging-ops.test.mjs
# 由归档中的 windows-run-ops.ps1 以普通 Host 启动
node tests/security/p0a-ops-codex.mjs <codex> <Model工作目录> <新Host私有目录> transport-loss
```

`FlowKit-Windows-G12-Recovery-Transport-Loss.zip` SHA-256 为 `5b8a42a15254f405b0a38d0ac6cb3f7153f56d5246a3c7c8a722962c54cc9cd5`。23 项逐一核对，含命令与退出、完整协议、回合及收尾观察、配置范围、普通对端收件和原始测试日志。

## Linux

FlowKit 快进拉取并核对同一候选，复用固定启动器、普通 Host／Model 和测试环境。按 Run 恢复测试首次 2/2 通过，首次扫描一份，复扫为空。实际回合等待只读工具期间，探针以 SIGKILL 停止 Host UID 41001 持有的字节转发进程，固定启动器哈希不变。未发送取消 RPC，未收到回合终态，Checkpoint、Journal、Outbox、接纳索引与 Pending 保持一致。独立进程回收记录确认 Model App Server 随后退出 0。SQL 旁读保留瞬时 `database is locked` 日志，四份最终快照与离线校验通过。备份为 P 级，真实回合与传输为 P/M/T 级。

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-transport-loss-controller.mjs local attempt-1
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-transport-loss-controller.mjs codex attempt-1
```

同一候选的 Ubuntu CI 在 Node 22.13.0 和 24.22.1 分别通过备份与运维测试 4/4。CI 日志含恢复扫描、三 Store 联动和回环接收端落盘。`FlowKit-Linux-Transport-Loss-Autorecover-20261113.zip` 的 SHA-256 为 `da9dbf6c061c5c3c34428d4689717934638c4f3446eb217672d27ff4980f7d61`，173 个载荷文件的哈希、归档完整性与敏感内容扫描由 Linux 端核对。 [Linux 原始执行记录与归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

## 可复用的首发预演配置

| 项目 | 已准备的隔离配置 | 交接检查 |
| --- | --- | --- |
| 认证入口 | 固定 stdio 启动、两个普通操作员、普通审计员、两个测试租户 | 先核对 OS 身份映射，再核对客户端收件、跨租户拒绝和撤权后新会话。 |
| 撤权联动 | 三个可丢弃 SQLite Store 和测试签名钥 | 停止接纳，模拟部分确认，核对三库均拒绝，全部确认后恢复。 |
| 告警与负载 | 单独回环接收进程，16 条硬上限，8 轮采样 | 保存接收端落盘凭证、满额前后数据库文件长度和清理结果。 |
| 恢复与传输 | 停写快照、全新的恢复目录、固定普通 Host／Model 启动器 | 恢复后传 Run ID 扫描；本地断流只切断本次探针创建的传输进程。 |

## 实际首发仍需的四项输入

| 项目 | 需提供或授权 |
| --- | --- |
| 身份与入口 | 生产等价首发入口和受信身份源的配置位置，两个可用测试主体及各自租户绑定，审计客户端与对应测试权限。 |
| 撤权联动 | 实际 Host／Store 全量清单、暂停与恢复接纳的入口控制，以及在批准窗口撤销测试钥和核对逐库确认的权限。 |
| 告警、容量和恢复 | 测试值班接收端和收件确认人，允许发送测试告警的范围，负载曲线、时长、磁盘与保留目标，以及备份系统、隔离恢复位置和窗口。 |
| 供应商与部署传输故障 | 真实供应商故障的原始事件或供应商提供的批准测试方式，以及在实际发布链路上验证断线和重连的测试窗口。当前隔离样本覆盖等待工具回复时的本地传输骤断。 |

以上条款保持 **BLOCKED**。首发预演使用专用本机回环与容器网络，测试租户、测试 Store 和告警接收端可复用。实际部署的恢复启动编排、剩余 SEC／NAT／T29 证据随同一批验收。G12 放行后才能进入 G17。
