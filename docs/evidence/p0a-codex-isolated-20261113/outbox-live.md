# Codex 双会话竞争与 Outbox 重启恢复

在 Host 普通系统账户、已登录的独立 Model 账户下运行下列验收。证据目录必须是 Host 私有的全新目录，启动器沿用[双账户布置](./README.md)。测试使用合成 Pending 和受限的动态工具。

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated
```

- 双会话测试启动两个独立 App Server 和 Host 子进程，对同一 Pending 提交不同的合法答案。监督器核对两个原生工具回调、不同的 thread/turn/call 和两个已持久签名的回执，再放行竞争。验收要求唯一 `ACKED`、另一条 `CONFLICT`，Store 只有一个接纳索引。
- 强杀测试在实际模型回调已持久写入 `SIGNED`、Store 仍为 waiting 且尚无接纳索引时，由独立监督进程终止 Host 子进程。Windows 使用 Node 的强制进程终止，Linux 使用 SIGKILL。监督器确认子进程退出后重开数据库并独立验签，检查签名、回执摘要和 Store revision 均未变化。
- 新 Host 从持久 Outbox 自动恢复，使用原签名和相同回执，通过既有 Host 验签和 CAS。恢复子进程只读取公钥，且不启动 App Server。复跑扫描没有可重放项。未接纳且已过期的回执进入 `BLOCKED`，历史同内容回执仍通过原 Ack 规则对账。

Outbox 是 Host 示例适配器的独立 SQLite WAL/FULL 数据库。Core、ABI、Store schema 和 Receipt V1 沿用既有契约。此验收使用小内联答案。文件回退引用的崩溃恢复、签名前及 CAS 后强杀、签名轮换、生产保留策略和完整 NAT-14/15、C12/S13 仍待专项证据。实验目录含一次性私钥，导出时只取协议日志、Host 观察、监督器日志和公钥。
