# 旧公钥撤销与 Outbox 保留基线

当前 Run 的 `policyHash` 包含已批准公钥的指纹。改变公钥集合会改变 Host 策略摘要。既有 Run 的加载、恢复与回执接纳均核对原摘要。当前 Store 也将 `policyHash` 视为 Run 不可变字段。

在现有隔离环境中运行：

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated revocation
```

先用同一批准清单创建两个 Run。旧钥签名后，一个 Run 完成接纳，另一个停在 CAS 前。用只包含新公钥的 Host 重启，在未接纳证明仍有效时尝试读取、恢复和接纳。测试核对拒绝码以及 Checkpoint、Journal、接纳索引和 Outbox 记录不变。另用只批准新公钥的 Host 创建全新 Run 并走真实工具闭环。

随后用真实签名前强杀与过期用例记录当前保留行为。重启扫描保留未签名的 `OBSERVED` 行；过期未接纳的签名进入 `BLOCKED`，原始签名和回执仍在 Outbox。已接纳行维持 `ACKED`。当前 Outbox 没有自动清理任务，文件入口的 `purgeExpired()` 仅清理已过期且仍为 `staged` 的文件行。

## 待确认的发布契约

- **撤销后历史 Ack。** 建议将撤销视为停止新接纳。历史 Ack 由独立受权的只读对账路径从 Store 账本返回，核对 namespace、Run、Request、节点、attempt 与规范回执摘要。撤销旧钥后，旧签名仍走现有接纳路径的拒绝行为。
- **既有 Run 迁移。** 建议正常轮换沿用已冻结策略直到旧 Run 结束，新 Run 使用新策略。紧急撤销后，旧 Run 保持阻断，由受权操作员对账。若需要原地继续既有 Run，应另审带版本、事务与审计的迁移协议，并规定在途 Pending、历史签名和 Journal 的处理方式。
- **保留窗口。** 建议由部署配置规定期限与容量。待投递的 `SIGNED` 和未解决的 `OBSERVED`、`BLOCKED`、`CONFLICT` 保留到对账或审计释放。终态且对账完毕的 Run 在审计窗口后才清理 Outbox 正文与可回收快照。仍被有效结果引用的快照、合法保留标记和 Store 接纳索引继续保留。

上述发布行为待确认。当前验收只覆盖现有契约下的拒绝、账本保留和新策略下新 Run 的运行。
