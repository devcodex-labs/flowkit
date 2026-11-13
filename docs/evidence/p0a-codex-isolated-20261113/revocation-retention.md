# 旧公钥撤销与 Outbox 保留基线

当前 Run 的 `policyHash` 包含已批准公钥的指纹。改变公钥集合会改变 Host 策略摘要。既有 Run 的加载、恢复与回执接纳均核对原摘要。当前 Store 也将 `policyHash` 视为 Run 不可变字段。

在现有隔离环境中运行：

```text
node tests/security/codex-outbox-live.mjs <Codex绝对路径> <Model工作目录> <全新Host私有证据目录> isolated revocation
```

先用同一批准清单创建两个 Run。旧钥签名后，一个 Run 完成接纳，另一个停在 CAS 前。用只包含新公钥的 Host 重启，在未接纳证明仍有效时尝试读取、恢复和接纳。测试核对拒绝码以及 Checkpoint、Journal、接纳索引和 Outbox 记录不变。另用只批准新公钥的 Host 创建全新 Run 并走真实工具闭环。

随后用真实签名前强杀与过期用例记录当前保留行为。重启扫描保留未签名的 `OBSERVED` 行；过期未接纳的签名进入 `BLOCKED`，原始签名和回执仍在 Outbox。已接纳行维持 `ACKED`。当前 Outbox 没有自动清理任务，文件入口的 `purgeExpired()` 仅清理已过期且仍为 `staged` 的文件行。

## 实测结果

验收候选为 `ab931afe0699ca89d9f5f29aea8263caf1031cba`，本机 `npm run verify` 412/412 通过，[候选 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43369908354) 8/8 通过。Windows 使用当前机器的两个普通系统账户和受保护的回环启动器。Linux 由 FlowKit 任务拉取同一提交，在 UID/GID 41001 与 41002 下运行。每端完整运行分别使用六个真实 App Server 会话。

| 场景 | Windows 与 Linux 结果 |
|---|---|
| 移除旧公钥后尝试接纳旧回执 | 未过期且尚未接纳的旧证明，以及已接纳的原字节重放，均返回 `FK_I_PROVENANCE_REJECTED`。 |
| 既有 Run 在新策略下加载与恢复 | 两个旧 Run 均返回 `FK_I_HOST_DENIED`。历史接纳索引仍是 revision 4。在途 Run 仍是 waiting revision 3，接纳索引为空。两个 Run 的 Checkpoint、Journal 和 Outbox 记录在尝试前后相同。 |
| 新策略创建 Run | 仅批准新公钥，使用新钥签署真实工具回执，在 revision 4 接纳并成功终结。 |
| Outbox 当前保留 | 原 `OBSERVED` 在重启与成功重试后仍在。过期未接纳的原字节转 `BLOCKED` 并保留。撤销场景中未接纳的 `SIGNED` 与原 `ACKED` 都保留。 |

每端三组通过，各五份签名使用对应公钥独立验签。Linux 另核对了五条 Journal 哈希链，首轮完成。Windows 首轮的撤销和签名前场景通过，过期场景的 App Server 初始化 SQLite 运行状态失败。用全新 Run 和证据目录重跑后三组均通过。Windows 归档含两次运行的相关原始日志。

| 原始证据归档 | SHA-256 |
|---|---|
| Windows `flowkit-windows-outbox-revocation.zip` | `ac39fb3a50ba1f24ea3227bfadf81d2c8952c6232786a5114dac72147373be6a` |
| Linux `FlowKit-Linux-Revocation-Retention-20261113.zip` | `27717a224c154132a7c8f0b8470c59873641ce7469d7bf3f59457a8731f9c7df` |

证据覆盖指定样本的 P/M/T。两端均验证新 Host 配置移除旧公钥后，对不匹配的 Run 策略拒绝执行。生产撤销对所有 Host 的生效机制、既有 Run 迁移、撤销后历史 Ack 对账接口和有界保留策略均为 BLOCKED。完整 N/V 级及发布结论仍待独立复审。

## 待确认的发布契约

- **撤销后历史 Ack。** 建议紧急撤销后停用仍批准旧钥的生产 Host，确保旧钥停止签发与接纳。历史 Ack 由独立受权的只读对账路径从 Store 账本返回，核对 namespace、Run、Request、节点、attempt 与规范回执摘要。该路径只读原 Ack，无 CAS 或状态推进。
- **既有 Run 迁移。** 建议正常轮换沿用已冻结策略直到旧 Run 结束，新 Run 使用新策略。紧急撤销后，旧 Run 保持阻断，由受权操作员对账。若发布要求原地继续既有 Run，应另审带版本、事务与审计的迁移协议，并规定在途 Pending、历史签名和 Journal 的处理方式。
- **保留窗口。** 建议由部署配置规定审计期限和容量上限。待投递的 `SIGNED` 和未解决的 `OBSERVED`、`BLOCKED`、`CONFLICT` 保留到对账或审计释放，容量不足时停止接收新的可落盘工作并告警。终态且对账完毕的 Run 在审计窗口后才清理 Outbox 正文与可回收快照。仍被有效结果引用的快照、合规保留标记和 Store 接纳索引继续保留。

上述发布行为待确认。当前验收只覆盖现有契约下的拒绝、账本保留和新策略下新 Run 的运行。
