# G04 · CF-08 编译选项快照

基线为 [`d17a7da7a0efbd6b0ab4e468586d132f648b2e23`](https://github.com/devcodex-labs/flowkit/commit/d17a7da7a0efbd6b0ab4e468586d132f648b2e23)，交付仍在 [Draft PR #22](https://github.com/devcodex-labs/flowkit/pull/22)。本次由 Codex 直接实施。三份冻结原件的字节身份已记录在 [G01](../p0a-g01-20261112/README.md)。

R5 §4 要求编译器按经校验的静态阶段编译，§15.2 的 R04 记录同类异步输入突变。G01 的 CF-08 定位到 `compileInteractive()` 在校验后又从调用方对象读取 `featureStage`。现在 lowering 使用编译入口已经校验的 `snapshotOptions.featureStage`。实际修复是 `src/interactive/compile.mjs:44` 的一次读取替换。

回归用同一份合法 DSL 比较稳定调用和立即修改原选项的调用。修复前，第二次调用错误返回 `FK_I_UNSUPPORTED_GRAPH`。修复后，两个调用的诊断、Program 标识和 JS 完全一致。原有 P0-B 拒绝用例随全量验证一起运行。

| Windows / Node 24.22.2 | 命令 | 结果 |
|---|---|---|
| 只加入回归测试 | `node --test --test-name-pattern=CF-08 tests/interactive/stage2-integration.test.mjs` | 退出 1，1 项失败，见 `before.stdout` |
| 加入修复 | 同上 | 退出 0，1 项通过，见 `after.stdout` |
| 加入修复 | `npm run verify` | 退出 0，396 项通过，0 失败、0 跳过，见 `verify.stdout` |

上述是本地 P 级证据。日志原始字节、测试单独 diff、增量 diff、基线与修复提交身份和新提交的 CI 结果在本地证据包。

## G04 其余裁决

| 项目 | 已核对的约束与下一步 |
|---|---|
| CF-01 管理终止 | R5 §§3.6、4、5、9 要求独立管理权限、无需加载 Program、原子墓碑和审计。当前 Store `sqlite-store.mjs:8/44/340` 拒绝 `cancelled` Checkpoint，现有 SQL 也没有管理事件。需要裁决部署中的 Checkpoint 兼容方式、管理审计的存储位置，以及旧读取方如何处理新终态。验收须覆盖旧 Program 缺失、迟到回执和与业务终态的 CAS 竞争。 |
| CF-05 结果投影 | R5 §§4–5 要求公开 Frame 只给 `resultRef`，完整结果由 Host 的 `result:read` 独立授权。现有 `InteractiveRunFrame` 与打包消费者明确读取终态 `state`（`types/interactive.d.ts:83/258`、`tests/package/consumer.mjs:55/98`）。需裁决旧 factory 是否作为仅限 Host 的兼容入口保留，以及版本化 PublicFrame 的接入方式。现有 `getPublicAgentTask` 的字段限制继续是当前模型通道的证据。 |
| CF-02 / CF-06 | 顶层 SDK 和五操作异步 Store 差异见 G01。需要先裁决对当前消费者及自定义 Store 的兼容承诺，再评审接口或适配器。 |
| G07 / NAT-14 | G03 的完整入参独立绑定条件仍未满足。此次 G04 的验证对象为编译器，证据等级为 P。 |

CF-08 是本提交的已验证修复。G04 其余发现及依赖步骤按各自裁决和复审条件保留。
