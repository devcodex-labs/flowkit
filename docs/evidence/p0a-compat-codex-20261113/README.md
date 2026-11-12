# P0-A 兼容实现与 Codex 宿主候选

实施基线为 Draft [#22](https://github.com/devcodex-labs/flowkit/pull/22) 的 `70143668394fc5f4e4d1d26f62788c14a66e17e3`。[该提交 CI](https://github.com/devcodex-labs/flowkit/actions/runs/43327790322) 已完成，8/8 成功。

## 已批准的兼容实现

现有 Standard 根入口和同步 Interactive factory 继续供旧调用方使用。新版调用方可从 `@devcodex-labs/flowkit/interactive` 使用 `start`、`complete`、`resume`，获得版本化公开帧。公开 Pending 必须通过 Host 的独立披露判断。顶层执行入口要求 Host 在受信代码中创建的授权对象，JSON 拷贝不能充当该能力。新版授权对象的 `readTerminalResult` 单独检查 `result:read`、命名空间、策略和 revision。

新版调用方可接入 `CheckpointStoreV1` 的五个异步操作，以及独立的 `TrustedProgramRegistryV1`。SQLite 参考入口 `createSqliteInteractivePersistence` 返回两个接口，共用现有事务后端。Genesis、Program 引用、Checkpoint、Journal 和首次回执沿用原事务边界。CAS 结果不确定时，用持久化历史和线性化读取确认。缺证据返回 `FK_I_STORE_UNCERTAIN`。同步 Store 和现有四张 SQLite 表继续兼容，异步接口携带当前 P0-A Checkpoint 数据结构。

旧 Run 保留原转移 ID 和回执摘要。新版入口创建的 Run 固定 `transitionIdVersion:1`，对 R5 的 namespace、run、fromRevision、fromBlockId、事件、Program 和提案摘要计算 ID。Genesis 的前序 revision 和 Block 为 null。现有版本的旧 factory 拒绝推进新版 Run。部署应先升级所有可能打开同一数据库的写入方，再启用新版入口。旧二进制回滚及外部持久化格式迁移需单独安排。

范围保留：R5 嵌套 Checkpoint 全量 ABI、跨语言 JCS 互操作、P0-B 扩展绑定和生产宿主来源继续独立验收。外部 Store 实现必须自行证明强一致、原子创建和原子 CAS，参考 SQLite 的测试只覆盖本实现。

Windows / Node 24.22.2 的 `npm run verify` 通过 403 项及现有 TypeScript、包检查和实际 tarball 消费。新增回归覆盖旧 Run 续跑和历史 Ack、R5 Genesis/转移摘要、跨租户读取、独立结果授权、CAS 丢响应及缺持久证据时拒绝继续。打包消费者直接调用新版顶层入口。

## Codex App Server 实测

Windows 上的 Codex CLI `0.145.0` 可启动 stdio App Server。首次真实回合因默认模型不支持当前 ChatGPT 账号而失败。随后从 `model/list` 取得当前默认模型 `gpt-5.6-sol`，发起新的真实回合。合成动态工具取得原生 `item/started` 及 `item/tool/call`，两者的 thread、turn、call ID 和小内联参数匹配。客户端观察开始事件约 3 ms 后收到工具请求，核对参数后才回复，回合成功完成。证据目录保存调用摘要和原始 JSONL。探针运行在同一 Windows 主体，使用合成工具数据。真实 FlowKit Pending、跨 OS 主体、签名、CAS、原生大入参及故障恢复均待验证。G07–G10 和 NAT-14/15 仍为 BLOCKED。

官方说明描述了动态工具的开始、客户端调用、回复和完成事件。选择实验性动态工具接口作为接入候选时，应固定 App Server 版本和 schema，升级前重跑能力与时序测试。[Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)

## 请确认的三个方案

| 待决项 | 推荐方案 | 取舍 |
|---|---|---|
| 宿主和等价验收 | 批准 Codex App Server 为首个候选，走 Host 自己启动并持有的 stdio 通道。先验证真实 FlowKit start → PublicTask → 模型结果 → submit → continue → Terminal，同一 Run 绑定 thread/turn/call、Pending、tenant、Program/Policy 和签前规范入参。用 Windows/Linux 独立账户重复。 | 能直接观察客户端工具回调，减少另起 MCP Server 的需要。动态工具协议有版本成本。NAT-01–12、14–15 逐项映射到 Codex，验证非法提交无写入、双会话竞争、失配、断线、真实强杀、签后对账。NAT-13 仍单独检查供应商可验证签名，账号登录与工具事件本身不足以通过。Grok 目标在正式确认前保持原样。 |
| 大入参 | 优先从受保护 App Server 的动态调用取得完整 JSON，使用相同规范字节摘要串联开始、回调和回执。实测 64 KiB、256 KiB 和接近 **完整回执** 上限的向量，包括 Unicode、截断、超限和不回复超时。完整回执按 2 MiB 上限与 Checkpoint 余量分别判断。文件回退仅在内联受限且另获批准时启用。 | 内联协议简单，但受模型输出和 transport 上限约束。文件回退需 Host 复制到私有存储，校验实际捕获的字节，固定长度、摘要、生命周期和 Run/Pending 身份，拒绝变化、重复及过期引用。业务产物引用保留为独立数据协议，不能扩大 FlowKit 内联结果限额。 |
| CF-01 管理终止 | 按 R5 新增独立的管理能力与版本化迁移。由同一事务写入 `cancelled` tombstone、历史 transition 和专用管理审计记录。确认迁移前备份、版本读取策略和回滚演练。 | 专用审计更便于最小权限、审计索引和独立保留，但会增加一次迁移。Journal 内同事务记录是较轻备选，需要另批等价性。验收包括 Program 丢失、越权、跨租户、并发终态唯一赢家、迟到回执及旧 SDK 拒绝未知版本。 |

确认宿主方案后才能进入真实适配器和正式等价验收。确认管理方案后才能变更管理终态与持久化。
