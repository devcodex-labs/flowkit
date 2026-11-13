# R5 首发候选的双账户复验

实现基线为 `d3674bca09d305f88828a77b1d3653937fc5da5e`。新增实测入口候选为 `5efa127cf8a26081985e454b9719619a39fdc4b2`，相对实现基线仅改两个验收探针。每次使用全新 Host 私有目录和 R5 SQLite 库。Host 与 Codex App Server 分属两个普通 OS 账户，Model 工具仅接触当前公开任务和提交入口。复验采用真实模型回合及合成业务任务。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有目录> isolated followup
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <另一全新Host私有目录> isolated release-r5
```

## Windows 与 Linux 实测结果

两端在 `d3674bc` 的 `followup` 各使用三个真实会话，在 `5efa127` 的 `release-r5` 各使用七个真实会话。Windows 使用本机两个普通账户和受保护回环启动器。Linux 由 FlowKit 任务先快进拉取对应提交，在专用容器中用普通 Host UID/GID 41001、独立 Model UID/GID 41002 运行，并核对了 64 个部署文件的 SHA-256。

| 场景 | 两端结果 |
|---|---|
| 基线恢复 | `followup` 三项 PASS。CAS 后、Outbox 补 Ack 前强杀只补记 `ACKED`。262,144 B 和 2,093,056 B 文件引用从私有快照按原签名恢复。 |
| R5 已接纳回执恢复 | PASS。真实模型回执进入 revision 4 后，纯校验器阻塞在第一个调用点。原 SQLite JSON 为 R5 `execution.phase=validate`，`receivedSubmission` 与接纳索引同在，`pending=[]`。强杀后原 Checkpoint 完全相同。新 Host 不启动模型，复用原回执恢复至 revision 9、`finished`，接纳索引仍为 revision 4。 |
| 撤销后原 Ack | PASS。Store A 撤销旧钥后，旧策略拒绝加载、恢复和旧回执重放。独立授权的历史查询返回原 revision 4，错租户和错摘要拒绝，Checkpoint 和 Journal 不变。 |
| 跨 Store 撤销 | PASS。每个平台各用两个独立 SQLite Store 和同一测试公钥指纹。仅撤销 A 时 B 仍可加载，随后对 B 显式执行同一撤销，B 拒绝其尚未过期的原签名投递，仍停在 waiting revision 3。撤销在各自 Store 生效。 |
| Outbox 满额与清理 | PASS。真实工具提交分别触发一条记录上限和一字节逻辑配额负例，记录告警且 Pending、Journal 和接纳索引不变。未授权清理被拒，保留标记保住原行，注入 SQLite 审计写入失败后清理回滚。独立 Host 进程重试清理，原 Ack 仍可对账，释放的容量允许新模型会话完成同一 Pending。 |

Windows 原始证据归档 `flowkit-windows-r5-live.zip` SHA-256 为 `cf93b1c5c7b6973223423ce25250dfd71656e588a23f25c2514e48d89d307992`。归档含进程监督、App Server 协议、Host 观察、公开验证钥和逐文件哈希。对留存的七份签名独立复核通过。容量样本清理过的正文和签名已按规则删除，归档保留该提交的事件与摘要。

Linux 原始归档由 FlowKit 任务保管，压缩包及逐文件哈希均已复核。

| 归档 | SHA-256 |
|---|---|
| `FlowKit-Linux-R5-Followup-20261113.zip` | `34b43b87b0134ee05ba9bf4bcf29e93e5b1a74b2779e8901bbddac8c8e2bcc89` |
| `FlowKit-Linux-Release-R5-20261113.zip` | `31f75ac0d73ec01840ffdad3dcae9cd464fbc7b53a4768c12b3c78edfda5be73` |

Linux 的 `release-r5` 独立核对了五份签名（含清理前留存的一份）和五条 Run 的 Journal 链。观察器有两次 SQLite 锁冲突跳读，正式断言所需快照均已取得。[实测候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43379312101) 八项通过。

## 证据边界

这些样本覆盖 P/M/T。跨 Store 结果适用于分别对两个 Store 执行撤销的运维方式。生产部署的所有 Store 撤销协调、真实磁盘预算、生产保留窗口和实际告警仍为 BLOCKED。清理中断样本使用真实 SQLite 事务的审计写入失败注入。文件快照清理中断重试已有程序回归，真实双账户文件样本本轮验证强杀后的快照恢复。完整 SEC／NAT、C12／S13／T27、N/V 级及 G12 独立复审仍待完成。
