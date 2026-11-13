# P0-A 管理终止和 Codex 实测

> 此页记录首发方案确认前的 V2 迁移实验。当前首发初始化全新 R5 数据库，参考入口只接收 `namespace` 选项。部署和验收以 [Interactive 接入](../../interactive.md) 和 [当前发布矩阵](../p0a-g07-g12-20261113/release-matrix.md) 为准。

Draft [#22](https://github.com/devcodex-labs/flowkit/pull/22) 的实施基线为 `e1cd5c7c4f89397fbdee50e1a430074c4c610e9d`，基线 [CI](https://github.com/devcodex-labs/flowkit/actions/runs/43331776187) 8/8 通过。

## R5 管理终止

SQLite 使用显式 V2 迁移。维护窗口内先停写入方，再由可信 Host 调用：

```js
const persistence = createSqliteInteractivePersistence(file, {
  namespace, migrationBackupPath: newProtectedBackupFile,
});
```

备份路径必须是可安全新建的 Host 私有文件。SQLite 生成一致性备份，并执行完整性检查。事务锁定写入后重新核对 schema 和 data version，再创建专用审计表、安装写入保护并提交 V2。新 writer 可在迁移后正常写入，已部署旧二进制不含 V2 writer 函数，旧 SQL 写入会被触发器拒绝。该保护针对旧软件兼容性，私有数据库的 OS 访问仍依赖 Host 账户隔离。需要回滚时，在停写窗口将原备份恢复到独立位置并校验 Run/Journal。切换到迁移前快照会丢掉迁移之后的写入，需要先对账。

管理控制器仅接受由可信 Host 在进程内创建的独立管理能力，核对 namespace、管理主体和 `run:admin-terminate`。在一个 SQLite 事务写入 `cancelled` Checkpoint、转移账本及 `fk_i_admin_events`，审计只保存操作主体、reason code、时间和转移身份。管理操作无需加载 Program。原状态已终结时直接返回其终态，审计写入失败回滚整个事务。重复操作不会追加审计，迟到回执拒绝，已持久接纳记录仍可从 Store 读出。管理操作与 P0-B 业务撤销分开。

本地 Windows / Node 24.22.2 的 `npm run verify` 通过 405 项及打包消费者。S12-A 新增测试验证迁移、备份重开、旧写入方拒绝、跨租户与假能力拒绝、专用审计回滚、Program 字节不可用、重复终止、迟到回执，以及两个 SQLite 连接上的管理终止和业务终态竞争。现有生产数据库没有执行迁移。

## Codex App Server 实际执行

Codex CLI 0.145.0 通过 stdio 启动 App Server，使用账号模型目录默认项 `gpt-5.6-sol`。同一 Windows SID 下真实生成一个 Agent 结果。FlowKit 实际编译、发布 Pending、观察原生动态工具开始和回调、校验同一调用 ID 及规范参数摘要，再签名接纳。Run 返回 succeeded，接纳 revision 4，终态 revision 9，Journal 10 条。所有工具的响应都是实际程序输出。

| 样本 | 结果 | 证据限制 |
|---|---|---|
| 65,536 B 完整内联 JSON | PASS | 开始事件、工具回调及预期规范字节完全相同，回合成功完成。 |
| 262,144 B 完整内联 JSON | BLOCKED | 模型结束回合，未发出该动态工具调用。 |
| 2,093,056 B 完整内联 JSON | BLOCKED | 模型结束回合，未发出该动态工具调用。 |

三档都使用确定性 ASCII 样本，大小计算包含完整探针 JSON 对象。64 KiB 属实际传输实测。另两档只能证明当前模型和提示没有交付所需调用，无法推断底层硬上限或 2 MiB FlowKit 内联回执已通过。未启用文件回退。

**Windows/Linux 双账户等价验收 BLOCKED。** Windows 本机非提升账户，WSL 在有界探测中未启动。仓库没有配置凭据或注册自托管 runner。此前的双账户 CI 使用受限脚本并已实测 OS 权限，仍缺当前版本 Codex App Server 在独立身份下的模型调用、进程和句柄证据。探针可接收环境提供的受信隔离启动器。Linux 包含同 PID 的 exec 身份检查。Windows 需要受信启动器从实际非管理员 Host/Model Token 记录两个 SID，并只传递指定 stdio。启动器和真实环境还需联合验证。等价验收、真实多会话、签后崩溃恢复以及 NAT-14/15 保持 BLOCKED。

## 文件回退候选，待确认

建议对超过已验证内联范围的结果采用由 Host 固定的不可变内容。模型工具提交的仅是当前 Pending 的有界引用，Host 从预设的隔离入口获取内容，把同一份读取快照写入 Host 私有存储，再校验长度、UTF-8、JSON、schema 和 SHA-256。摘要、长度、命名空间、Run、Request、Attempt、thread/turn/call 及过期时间与当前受保护的动态调用绑定。模型自报路径或摘要只用于定位或比对，授权与摘要以 Host 的实际观测为准。

验收要求：256 KiB 和接近上限可由 Host 固定并复核。内容变化、超限、截断、过期、错 Run/tenant、重复消费以及未绑定调用均拒绝且无签名或 CAS。外部业务产物和完整内联回执按各自限额处理。成本是增加私有临时存储、清理和对账流程，收益是完整字节可以独立验证。等待用户确认后才实施。
