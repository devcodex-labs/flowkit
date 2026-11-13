# Codex 双会话竞争与 Outbox 重启恢复

在 Host 普通系统账户、已登录的独立 Model 账户下运行下列验收。证据目录必须是 Host 私有的全新目录，启动器沿用[双账户布置](./README.md)。测试使用合成 Pending 和受限的动态工具。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated
```

- 双会话测试启动两个独立 App Server 和 Host 子进程，对同一 Pending 提交不同的合法答案。监督器核对两个原生工具回调、不同的 thread/turn/call 和两个已持久签名的回执，再放行竞争。验收要求唯一 `ACKED`、另一条 `CONFLICT`，Store 只有一个接纳索引。
- 强杀测试在实际模型回调已持久写入 `SIGNED`、Store 仍为 waiting 且尚无接纳索引时，由独立监督进程终止 Host 子进程。Windows 使用 Node 的强制进程终止，Linux 使用 SIGKILL。监督器确认子进程退出后重开数据库并独立验签，检查签名、回执摘要和 Store revision 均未变化。
- 新 Host 从持久 Outbox 自动恢复，使用原签名和相同回执，通过既有 Host 验签和 CAS。恢复子进程只读取公钥，且不启动 App Server。复跑扫描没有可重放项。未接纳且已过期的回执进入 `BLOCKED`，历史同内容回执仍通过原 Ack 规则对账。

Outbox 是 Host 示例适配器的独立 SQLite WAL/FULL 数据库。Core、ABI、Store schema 和 Receipt V1 沿用既有契约。此验收使用小内联答案。文件回退引用的崩溃恢复、签名前及 CAS 后强杀、签名轮换、生产保留策略和完整 NAT-14/15、C12/S13 仍待专项证据。实验目录含一次性私钥，导出时只取协议日志、Host 观察、监督器日志和公钥。

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

| 归档 | SHA-256 |
|---|---|
| Windows `flowkit-windows-outbox-live.zip` | `a66e85c0b746538af2f3f93c8a978e963bcc2434af76af9ba50a8fc4d1a2b7a9` |
| Linux `FlowKit-Linux-Outbox-Live-20261113.zip` | `00ab2b37629076f3ca9eb97b1e3cdd471ebece832274864bc5d14ee3bda3257e` |

归档另含验签所需的声明、签名和回执原始字节，私钥和登录缓存留在各自环境内。过期未接纳回执只做了本地定向回归。完整 G08 的其他故障窗口与 NAT-14/15、C12/S13 仍为 BLOCKED。
