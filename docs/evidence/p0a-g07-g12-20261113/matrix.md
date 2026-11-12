# G11 · C01–C24 验收矩阵

源场景见 [C01–C12](../../interactive-complex-acceptance-c01-c12.md) 和 [C13–C24](../../interactive-complex-acceptance-extension-c13-c24.md)。本批每行实时模型调用数均为 **0**。P 指实际执行生成 JS、Host/Store 或指定 OS 测试。历史 ChatGPT 结果重放单独列出。未实测的原生证据均保持 BLOCKED。

测试文件缩写：`complex` 为 `tests/interactive/complex-c01-c12.test.mjs`，`crash` 为 `tests/interactive/crash.test.mjs`，`m6` 为 `tests/integration/m6-e2e.test.mjs`。本地证据包的 `matrix.tap` 记录原始测试名、输出和数值，`verify.stdout` 记录包与类型消费者，GitHub Actions 保存 Windows/Linux OS 子项及本批 CI。

| 场景 | 本批实际 P 证据 | M / T / N 及再入条件 |
|---|---|---|
| C01 串行 4 Agent + 2 Conditions | PASS，complex C01。4 签名收据，35 Journal。 | 历史五条 ChatGPT 结果重放 PASS，原生会话和受保护来源仍 BLOCKED。 |
| C02 条件 false、缺输入和拒绝分支 | PASS，complex C02 和 m6 false 条件，未到达 Agent 没有派发。 | BLOCKED，真实模型拒绝分支。 |
| C03 不合格输出和恢复 | PASS，complex C03，attempt 1/2，候选不污染 State。 | 历史受控无效输出及后续结果重放 PASS，原生来源 BLOCKED。 |
| C04 重试耗尽 | PASS，complex C04，最后 FK_R004。 | BLOCKED，真实持续失败和完整工具日志。 |
| C05 Host 强制退出和恢复 | PASS，crash 真实子进程切点，m6 发布后和 Worker 返回后两条恢复。 | BLOCKED，真实宿主会话中途 kill/restart。 |
| C06 双进程、丢响应和重复回执 | PASS，crash 真实双进程与本批 R11，首次 revision 6、最新 34。 | BLOCKED，真实双模型会话竞争。 |
| C07 Program、Skill、Policy 漂移 | PASS，m6 S06、stage2-integration 绑定漂移、trusted-host。 | BLOCKED，宿主/模型升级重新授权和恢复。 |
| C08 权限、签名、泄漏 | PASS，trusted-host 的错租户、伪签、白名单及 CF-05。G05–G06 有两个独立 OS 账户的测试配置。 | BLOCKED，实际候选通道和原生会话、生产启动链。 |
| C09 Checkpoint 容量 | PASS，s07-capacity、host-oversize、m6-ledger-boundary。 | BLOCKED，真实模型的大输出和传输事件。 |
| C10 长链和持久回执 | PASS，36 Agent 全量历史查询，R12 另验证 300 Agent。 | 此场景以 P 为验收范围，宿主接入另见 C12。 |
| C11 阶段预算 1 与 128 | PASS，complex C11、m6、R12 比较终态 State。 | 此场景以 P 为验收范围。 |
| C12 原生工具闭环 | 原生验收适用 G10。脚本 Host 只记录支持证据。 | BLOCKED，真实原生会话、独立工具开始事件和签名/Store 闭环。 |
| C13 分支 × 预算 | PASS，complex C13 复跑。 | P 场景。 |
| C14 链中错误或超限回执 | PASS，complex C14，五类拒绝，Checkpoint/Journal 保持相同。 | 原生入口同类拒绝在 G09/G10 待测。 |
| C15 旧 Ack 重传 | PASS，complex C15，R11 增补提交后丢响应与后续推进。 | 原生 Outbox 恢复见 G08/G10。 |
| C16 可信 Provider 失败回执 | PASS，complex C16 的本地签名失败回执及有界重试。 | 真实 Provider 失败 BLOCKED。 |
| C17 链中 policy drift | PASS，complex C17，三个拒绝入口。 | P 场景，宿主实际升级待 G10。 |
| C18 多 Run 交错 | PASS，complex C18，重复 startKey 幂等、冲突拒绝。 | P 场景，多模型会话见 C23。 |
| C19 36 Agent 第 18 步失败 | PASS，complex C19，未分发后 18 步。 | P 场景。 |
| C20 两个不同有效签名提交 | PASS，complex C20 原测试加两个独立 Node PID 和一条 receipt CAS。 | 真实模型会话竞争 BLOCKED。 |
| C21 崩溃和跨版本恢复 | PARTIAL，crash 同环境重开 PASS。 | 跨 Node/OS 同物理文件转移未执行，按原定义保留为增强项。 |
| C22 模型自报权限 | PASS，trusted-host 授权/披露和错租户，G05–G06 测试账号隔离。 | BLOCKED，真实模型、实际候选通道及实际原生启动链。 |
| C23 真实模型异常组合 | C02/C04/C05/C06/C20 的 P 子项可分别重现。 | BLOCKED，真实失败/重试、强杀恢复和竞争提交的联合证据。 |
| C24 兼容和验收门禁 | 本地 verify、实际 tarball/CLI/最低版本 TS 和 docs 消费记录，跨平台状态见本提交 CI。 | BLOCKED，原生 C12/S13 与正式 P0-A 审查。 |
