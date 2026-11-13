# G12 首发环境核查与补充实测

起始候选 `fc7fd69fb4951ff35206b1825302fed49341107f` 的 CI 8/8 通过。补充实测候选为 `a43ff75377ebe0938d8933074450feb62aba4c67`。代码增量限于三个测试文件，diff SHA-256 为 `b980cd0b251eca8330cec11d232790352d0b4ab61f389a3a4e26a199b3eb353a`。三份冻结原件及其附属文件的字节数和 SHA-256 与 [G01 登记](../p0a-g01-20261112/verified-inputs.txt) 一致。 [起始 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43407985499) · [实测候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43412068455)

## Windows 实测

- **正在运行的模型回合主动中断，P/M/T。** 独立普通 Host 与 Model 由本机固定启动链启动。真实模型调用只读探针 `probe_hold`，Host 核对同一 thread、turn 和 call 的开始事件与回调，在工具等待期间发送 `turn/interrupt`。同一回合报告 `interrupted`，随后 App Server 收到 EOF 并退出 0。Checkpoint、Journal 和 Outbox 保持一致，恢复得到相同 Pending，零回执。回环监听在测试后关闭。首次 Windows PowerShell 脚本启动被本机默认执行策略拒绝，在启动本次已核对的本地脚本时使用进程级 RemoteSigned 后通过。
- **含文件快照的 R5 恢复，P。** Windows Node 22.13.0 与 24.22.2 各 2/2。停写后分别以 `VACUUM INTO` 备份 Store、Outbox、文件交接库，逐库校验完整性与 SHA-256，在新路径重开。两份 262,144 B 合成文件的入口原件在暂存后已删除。原 Ack 保持 revision 4。显式按 proof ID 重新投递已签待接纳的文件回执，原签名和私有快照字节保持一致，目标快照从 claimed 转为 acked，源库保持原状。测试用同一密钥和有效期内的固定时钟。

Windows 归档 `FlowKit-Windows-G12-Interrupt-Backup.zip` SHA-256 为 `4a50c9744e7525a67a37559144257ff3d0ffdc3fa1fd7193968cee566bfd5883`，21 项逐一核对。含双账户启动脚本、失败启动记录、完整协议请求和响应、Node 22／24 原始日志、启动后监听状态及只读环境清点。

```powershell
volta run --node 22.13.0 node --test tests/interactive/p0a-staging-backup.test.mjs
node --test tests/interactive/p0a-staging-backup.test.mjs
# 由归档中的 windows-run-ops.ps1 以普通 Host 身份启动
node tests/security/p0a-ops-codex.mjs <codex> <Model工作目录> <新Host私有目录> interrupt
```

## Linux

FlowKit 快进拉取并核对同一候选。独立普通 Host／Model 在固定启动链下首次通过主动取消，耗时约 5.13 秒。原始协议中 `probe_hold({})`、中断请求与完成事件对应同一回合，状态为 `interrupted`。独立 SQL 观察无读取错误，零签名、零回执，恢复同一 revision 3 Pending。证据等级 P/M/T。

三库停写备份和恢复首次 2/2 通过。私有快照 262,144 B，原 Ack 及恢复 Ack 均为 revision 4，复用原签名，源库保持原状。另核对代码候选的 Ubuntu Node 22.13.0 与 24.22.1 原始 CI 日志，两项备份回归均通过。证据等级 P。

```sh
git pull --ff-only origin feat/p0a-interactive-20261112
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-interrupt-backup-controller.mjs local attempt-1
docker --host=unix:///var/run/docker.sock exec --user 0:0 flowkit-linux-20261113 /usr/local/bin/node /run/flowkit/run-interrupt-backup-controller.mjs codex attempt-1
```

`FlowKit-Linux-AppServer-Interrupt-Backup-20261113.zip` SHA-256 为 `c259575c3911b1f4750234cea84c0cc010d2b401a609a30a2ac0cc4fc414afbc`。Linux 端核对了 ZIP 完整性、160 个载荷文件的哈希及敏感内容扫描结果。归档含精确命令与退出码、原始协议、快照、进程观察和离线校验。 [Linux 执行记录与归档](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

## 首发环境缺口

Windows 只读清点检查了 FlowKit 专用实验目录、公开配置文件名、计划任务和 FlowKit 服务。可用配置是隔离实验室的 `host-config.json` 与 `FlowKit-Isolated-SSH`。Linux 快进拉取起始候选后，确认既有专用容器和普通账号可用，现场只有测试身份映射。仓库和两端检查范围内均未找到本次可用的实际首发配置。以下验收保持 **BLOCKED**。 [Linux 核查记录](thread://6af5c6d6-410c-8191-be10-a7ad14d2702a?hostId=durable)

| 验收项 | 需要的环境、授权或证据 |
| --- | --- |
| 认证入口和结果交付 | 首发入口或生产等价实例、身份源配置、两个测试主体及其租户绑定、审计客户端。验证真实 Model 回执与操作员／审计员授权处于同一部署链。 |
| 跨 Store 撤权 | 首发 Host／Store 全量清单、入口暂停控制及测试钥撤销权限。在批准的测试窗口逐库确认，检查暂停期间的拒绝与全量确认后的恢复。 |
| 值班告警和长时容量 | 批准的测试值班接收端及收件确认，目标负载曲线、持续时间、容量和保留预算。现有本机回环告警和短时容量样本见 E16。 |
| 完整备份恢复 | 目标备份系统、保留范围、恢复到隔离位置的窗口及恢复时间和数据损失目标，包含文件快照、部署密钥和策略。核对停写边界、完整性、原 Ack 和待对账记录。 |
| 连接与供应商故障 | 进行中回合的意外传输中断，以及供应商的真实故障事件或经批准的供应商故障验证方式和原始来源证据。主动取消样本适用于 `turn/interrupt`。 |

实际首发配置到位后集中完成联合验收。G12 放行后进入 G17，冻结候选并验证发行包与安装，合并、Tag、发布和部署按原授权边界办理。
