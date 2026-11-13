# Codex 双会话竞争与 Outbox 重启恢复

在 Host 普通系统账户、已登录的独立 Model 账户下运行下列验收。证据目录必须是 Host 私有的全新目录，启动器沿用[双账户布置](./README.md)。测试使用合成 Pending 和受限的动态工具。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated
```

- 双会话测试启动两个独立 App Server 和 Host 子进程，对同一 Pending 提交不同的合法答案。监督器核对两个原生工具回调、不同的 thread/turn/call 和两个已持久签名的回执，再放行竞争。验收要求唯一 `ACKED`、另一条 `CONFLICT`，Store 只有一个接纳索引。
- 强杀测试在实际模型回调已持久写入 `SIGNED`、Store 仍为 waiting 且尚无接纳索引时，由独立监督进程终止 Host 子进程。Windows 使用 Node 的强制进程终止，Linux 使用 SIGKILL。监督器确认子进程退出后重开数据库并独立验签，检查签名、回执摘要和 Store revision 均未变化。
- 新 Host 从持久 Outbox 自动恢复，使用原签名和相同回执，通过既有 Host 验签和 CAS。恢复子进程只读取公钥，且不启动 App Server。复跑扫描没有可重放项。未接纳且已过期的回执进入 `BLOCKED`，历史同内容回执仍通过原 Ack 规则对账。

Outbox 是 Host 示例适配器的独立 SQLite WAL/FULL 数据库。Core、ABI、Store schema 和 Receipt V1 沿用既有契约。初始验收使用小内联答案。实验目录含一次性私钥，证据包排除私钥和登录缓存。

## 实测结果

Windows 与 Linux 均验证实现提交 `81a4c6e4400f95ca5dc0b771342411d0f587a464`。Windows 使用当前机器的两个普通账户和回环启动入口。Linux 由 FlowKit 云任务先拉取同一提交，再用 UID/GID 41001 和 41002 运行。

| 场景 | Windows | Linux |
|---|---|---|
| 两个真实会话争同一 Pending | PASS，两个不同回执先落盘，唯一 `ACKED`，另一条 `CONFLICT` | PASS，两个不同回执先落盘，唯一 `ACKED`，另一条 `CONFLICT` |
| 持久签名后、CAS 前强杀 | PASS，独立监督器强制终止 Host，重启后重放原签名 | PASS，独立监督器 SIGKILL Host，重启后重放原签名 |

两个平台在强杀前后均为 waiting revision 3，接纳索引为空，回执、声明和签名摘要一致。新进程使用公钥和原有 Outbox 恢复，revision 4 接纳，revision 9 达到 `succeeded`，Journal 10 条。竞争场景同样只产生一次接纳。每个平台导出的三份原始签名均通过独立验签。证据覆盖指定样本的程序、真实模型和原生 Host 观察（P/M/T）。

## CAS 后强杀和文件引用恢复

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated followup
```

- CAS 后强杀由监督器等待 Store 接纳索引已可读、Outbox 仍为 `SIGNED` 后触发。恢复用原回执走历史 Ack，仅补记 `ACKED`，并核对 Checkpoint、Journal 摘要、条数和接纳索引完全相同。
- 256 KiB 和近 2 MiB 的真实动态工具调用将文件引用绑定当前 Pending、thread、turn 和 call。入口原件在签名前已删除。监督器在私有快照为 `claimed`、Outbox 为 `SIGNED`、Store 尚未接纳时强杀。恢复先核对原快照、引用、绑定及 SHA-256，使用原签名完成 CAS，最后将快照和 Outbox 分别记为 `acked`、`ACKED`。再次恢复无待投递项。若已写快照 Ack 而尚未写 Outbox Ack，允许用相同 call 和 revision 补记。

两端在实现提交 `f01f2b5c008bc3f9dba32ed72d8a5ddca7b01115` 上使用不同系统账户实测了以下三个样本。

| 样本 | Windows | Linux | 持久结果 |
|---|---|---|---|
| CAS 后、Outbox Ack 前强杀 | PASS | PASS | 接纳 revision 4，终态 revision 9。重启仅补 `ACKED`，Checkpoint、Journal 与接纳索引保持一致 |
| 262,144 字节文件引用，签后 CAS 前强杀 | PASS | PASS | 原快照 SHA-256 `a89ec2764412be3284c3b2334a8ba4a484bfb7f6df2a8e274acc782a4e3231bb`，用原签名恢复至 `succeeded` |
| 2,093,056 字节文件引用，签后 CAS 前强杀 | PASS | PASS | 原快照 SHA-256 `716f7d91c27f9e89e87fa13d2e2d47ba3b4dba942cb42f371610eac0ed83fd87`，用原签名恢复至 `succeeded` |

两端各三份原签名离线验签通过。Linux 另在容器外核验两份快照原字节和三条 Journal 哈希链。Windows 归档 SHA-256 为 `2cd77acf9c571be7d4a0d3f431d4efddac8aae136930ea5e044dd68cb2a1548c`，Linux 为 `779ee3113930cb85fc28dff44d64ca912f53b11a8cbf2b6628e2bdeee71d83eb`。该批产生指定样本的 P/M/T 证据。

| 归档 | SHA-256 |
|---|---|
| Windows `flowkit-windows-outbox-live.zip` | `a66e85c0b746538af2f3f93c8a978e963bcc2434af76af9ba50a8fc4d1a2b7a9` |
| Linux `FlowKit-Linux-Outbox-Live-20261113.zip` | `00ab2b37629076f3ca9eb97b1e3cdd471ebece832274864bc5d14ee3bda3257e` |

归档另含验签所需的声明、签名和回执原始字节，私钥和登录缓存留在各自环境内。快照字节损坏、快照 Ack 后但 Outbox Ack 前的对账有定向回归。生产保留策略以及完整 NAT-14/15、C12/S13 仍为 BLOCKED。

## 签名前强杀、过期和轮换

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated signing
```

- 签名前强杀在真实工具事件和候选字节已写入 `OBSERVED` 后触发。重启扫描保留原观察，不签署或接纳该记录。另一个真实会话对同一 Pending 重新提交，产生自己的观察和签名。
- 过期拒绝使用独立测试 Run 的 3 秒证明有效期和真实系统时钟。监督器在 CAS 前强杀，等到期限和 Host 默认时钟容差都过去才重启。Outbox 记录 `BLOCKED`，Store、Journal、接纳索引保持原状。
- 轮换用两个预先批准的公钥保持 Run 的固定信任策略。旧钥完成一个真实 Run 后，新的真实 Run 由新钥签名。随后用原始已过期的旧签名重放，要求返回原 Ack，两个 Run 的持久状态都保持原样。撤销旧公钥及迁移既有 Run 的策略哈希属于独立场景。

Windows 与 Linux 均在 `ddf8c688abaa6450c615b81e3bd0daaceaed53b8` 使用独立 Host/Model 账户实测，三项各通过一次。

| 场景 | 两端结果 |
|---|---|
| 签名前强杀 | 原记录停在 `OBSERVED`，声明和签名均为空，重启后仍是 waiting revision 3。新会话用新的 thread、turn、call 和 proof ID 重试，在 revision 4 接纳，revision 9 成功终结。 |
| 未接纳回执过期 | 实际时钟超过期限及 5 秒容差后转为 `BLOCKED`，无接纳索引，Checkpoint 和 Journal 保持不变。 |
| 签名轮换和旧 Ack | 旧钥与新钥分别签署并接纳各自的真实 Run。旧签名过期后重放返回原接纳 revision 4，两个 Run 的 Checkpoint、Journal 和接纳索引均保持不变。 |

两端保存实际工具事件、监督与重启日志，以及用于独立复核的原始签名和公钥。证据为指定样本的 P/M/T。[移除旧公钥后的拒绝与 Outbox 保留基线](./revocation-retention.md) 已单独验证。生产撤销和保留策略，以及完整 NAT-14/15、C12/S13 和供应商可验证证明仍缺对应证据。

| 原始证据归档 | SHA-256 |
|---|---|
| Windows `flowkit-windows-outbox-signing.zip` | `9e4767867b338c26f3656cd42aa8e077b34bfc506b4b39affd19c6dd46cc6e72` |
| Linux `FlowKit-Linux-Signing-Lifecycle-20261113.zip` | `5d24066d7af6cd868afe1ea53b218651ebd908b827db7f5e148cf4cfef6eb9df` |
