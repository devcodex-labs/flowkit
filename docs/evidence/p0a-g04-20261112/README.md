# G04 批次交付与契约裁决

Draft PR #22 的 G04 基线是 `d17a7da7a0efbd6b0ab4e468586d132f648b2e23`。已完成当前可做的 CF-08 和 CF-05 终态读取部分。三份确认原件、版本和哈希在 [G01 审查](../p0a-g01-20261112/README.md)。

| 条目 | 改动与证据 |
|---|---|
| CF-08 | 修复异步编译在 lowering 阶段读取原始可变选项的问题。定向回归修复前失败、修复后通过。提交 `6989190412817d3ee8740531cf48c3297b619934`。见 [CF-08 记录](../p0a-g04-cf08-20261112/README.md)。 |
| CF-05 | R5 §§4–5 和计划 A-M5-01。可信 Host 增加 `getPublicTerminalFrame` 和 `readTrustedTerminalResult`。`run:read` 返回状态、Checkpoint 引用和版本化结果引用，`result:read` 独立控制完整 State。两条路径从受信 Store 读取同 namespace 的终态，再核对 revision。缺少授权回调时两条路径均拒绝。 |
| 兼容范围 | 现有 factory 的执行帧保留供可信 Host 调用方使用。新公开终态帧与完整结果是分开的类型。通用 PublicFrame 及旧入口迁移由下表 CF-02/05 决定。现有 Agent 任务继续走已授权的 `getPublicAgentTask`。 |
| 证据边界 | 验证为 Windows / Node 24.22.2 的真实 JS、SQLite 和打包消费者测试，属于 P 级证据。原生宿主 G07 及 NAT-14 保持 BLOCKED。 |

CF-05 定向命令为 `node --test --test-name-pattern=CF-05 tests/interactive/trusted-host.test.mjs`。最初加入权限回归时因缺失方法而失败，最终两个用例通过。覆盖双向权限分离、跨租户、旧 revision、无授权回调、活跃 Run 拒绝和错误终态脱敏。测试比较 SQLite Checkpoint 和 Journal 前后字节。打包 ESM 消费者验证两条路径，声明测试验证公开终态没有 State。全量 `npm run verify` 通过 398 项，0 失败、0 跳过。最终的类型兼容调整另跑 `npm run build`、`npm run test:types` 和 `npm run check:package`，均退出 0。

## 需要用户决定的冻结契约

| 项目 | 决策与影响 |
|---|---|
| CF-01 管理终止 | R5 §§3.6/4/5/9 的 `cancelled` 与独立管理审计超出现有 Store 的可读写集合。选择按 R5 做兼容迁移，或批准现有 Journal 内保存等价管理审计。两种方案都需先处理旧版读取 `cancelled` 的行为，并验证旧 Program 缺失、业务终态竞争和迟到回执。 |
| CF-02 / CF-05 SDK 与公开帧 | 选择新增 R5 顶层 `start/complete/resume` 与通用安全帧并保留现有 factory 为可信 Host 兼容入口，或安排旧调用方迁移后移除原执行帧的 State。第一种允许已安装消费者逐步迁移。当前已交付终态的分权读取。 |
| CF-06 Store | 选择并行提供 R5 五操作异步 Store 与独立 Registry 接缝并兼容现有同步 factory，或对公共 Store 入口做统一的版本迁移。两种都需要证明原子 CAS、历史查询和丢 ACK 后的线性化判断。 |
| ABI-01 转移身份 | 旧 Journal 使用现行 transition ID 公式，R5 公式还绑定事件、Program 与提案摘要。选择为新 Run 启用版本化公式并保留旧 Run 的公式，或先批准历史迁移及历史 Ack 对账策略。 |

G04 的本批可执行改动已交付。冻结裁决仍开放。第二批 G05–G06 的 OS 隔离准备和验证可以独立进行。原始命令、输出、增量 diff、确切提交 SHA 与文件 SHA-256 随本地证据保存。
