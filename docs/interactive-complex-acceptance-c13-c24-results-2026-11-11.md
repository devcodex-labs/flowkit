# FlowKit Interactive — C13–C24 补充复杂验收结果（2026-11-11）

## 结论

**P0-A 复杂协议补充用例 C13–C20：8/8 PASS（脚本可信 Host）；原 C01–C12 测试继续通过。原生模型宿主 C12/S13 仍 BLOCKED，不能据此合并 M6 / 发布。**

- 仓库：devcodex-labs/flowkit（private）
- PR：[Draft #12](https://github.com/devcodex-labs/flowkit/pull/12)，基于 main，不修改生产 Core
- 验证测试提交：**09e14e82b72277ef58b656bf129c9c4bc0b4b779**
- 完成的 CI：[42968295106 — 7/7 SUCCESS](https://github.com/devcodex-labs/flowkit/actions/runs/42968295106)
- 关联矩阵：[C01–C12 原矩阵](./interactive-complex-acceptance-c01-c12.md)、[C13–C24 增量矩阵](./interactive-complex-acceptance-extension-c13-c24.md)
- 执行类型：**SCRIPTED_TRUSTED_HOST**，本次新增用例模型调用次数 **0**；不能计入真实模型调用次数

### 精确跨平台测试清单

| GitHub Actions Job | Test | Pass | Fail | Skip | Job |
|---|---:|---:|---:|---:|---|
| Ubuntu 24.04 / Node 22.13.0 | 372 | 372 | 0 | 0 | SUCCESS |
| Ubuntu 24.04 / Node 24.22.1 | 372 | 372 | 0 | 0 | SUCCESS |
| Windows 2025 / Node 22.13.0 | 372 | 372 | 0 | 0 | SUCCESS |
| Windows 2025 / Node 24.22.1 | 372 | 372 | 0 | 0 | SUCCESS |
| Host OS-user isolation / Node 22.13.0 | — | — | — | — | SUCCESS |
| Host OS-user isolation / Node 24.22.1 | — | — | — | — | SUCCESS |
| Website/docs | — | — | — | — | SUCCESS |

以上从 GitHub Actions 的实际 job 日志/结论核验，非 PR 描述中的主观声称。372 是每一个环境内的全部测试数量，包含现有回归；新增复杂测试函数为 8 个，不能解释成 372 个真实 Agent 回合。

## C13–C24 逐项裁决

| ID | 协议层 P | 真实模型 M / 原生宿主 N | 可观测证据 / 缺口 |
|---|---|---|---|
| C13 分支×阶段预算 | **PASS** | M 未单独测 | 预算 1/128 下四个分支结果相同，已核对两个终态 State Hash |
| C14 链中伪造/超限回执 | **PASS** | N 模型对抗攻击待测 | 5 个不同类型的未认证/错误回执被拒且 Checkpoint 和 Journal 字节保持一致 |
| C15 Host 重建后旧 Ack | **PASS** | N 未测 | 下游等待态及 Terminal 后重放历史 receipt，不额外提交 State，Ack 原 acceptedRevision |
| C16 Provider 可信失败回执 | **PASS** | N 真 Provider 失败待测 | signed agent-call-failed 使末端 Agent 重试一次，旧回执重复 Ack，合法第二回合成功 |
| C17 链中 Host policy drift | **PASS** | N 实际宿主升级待测 | 3 条不同入口拒绝政策漂移并证明无 CAS 写入，旧 Host 继续成功 |
| C18 多 Run 交错、重复启动 | **PASS** | N 多模型 Session 未测 | 两 Run 状态隔离；重复 startKey 幂等，同 key 不同 State 冲突 |
| C19 36 Agent 中段失败 | **PASS** | 不要求 36 次模型计费 | 第 18 个脚本结果无效，终态 FK_R004，余下 18 个未分发，State 无非法字段 |
| C20 双有效签名并发竞争 | **PASS（同进程 Host 对象）** | N 真进程/多模型竞争待测 | 两个不同签名内容仅一个 CAS 成功、另一个 FK_I_RECEIPT_CONFLICT；真正双进程测试已在 C06/M4 另验 |
| C21 崩溃/跨版本恢复 | **PARTIAL** | N 未测 | M4 有真 SIGKILL 与同环境恢复；同一物理 DB 跨 OS/Node 迁移未执行，是增强项不是原 P0-A 硬门禁 |
| C22 Prompt 注入/宿主权限 | **PASS（既有 M5 + OS UID）** | **N BLOCKED** | 白名单、拒签、跨 UID 隔离已有证据；Grok Build 原生模型权限分离无证据 |
| C23 真实模型异常组合 | 不可用脚本替代 | **M/N BLOCKED** | 真实 false 分支、持续错误、与 SIGKILL 耦合恢复及多模型竞争未完成 |
| C24 兼容/发行/原生来源门禁 | **PASS（CI 部分）** | **N BLOCKED** | 7 job 全绿不意味着 C12/S13 原生认证已通过 |

## 首轮失败与复审记录

新增 C13–C20 首次提交 5be1abb（CI 42967554504）曾 370 PASS / 2 FAIL，失败集中在 **C16 和 C20 的测试断言**：在状态为 waiting 时，测试错误地读取了公开 Frame 中被隐藏的 State。FlowKit 此时不公开私有 State 是预期安全设计。第二次提交 ac49e3e（CI 42968021802）修复了 C20，留下 C16 一处相同的测试问题（371 PASS / 1 FAIL）。最终测试提交 09e14e8 将 C16 内部断言改为从受信 SQLite Store 读取，四环境 372/372 PASS。

这两轮失败**不是 FlowKit Core 缺陷的证据**；本轮修复未修改生产源码、签名器、Coordinator、SQLite Schema 或 Program ABI。PR #12 changed-files 范围仅 docs、tests、fixtures、示例工作流。

## 仍不得放行的明确缺口

1. **C12/S13：原生 Grok Build/Codex 工具调用、原生 Session/Provider 来源认证、Host 独立可信证明和模型进程权限隔离**。GitHub Actions + ChatGPT 五回合桥接不满足该条件。
2. **真实模型负例**：C02 的 false 分支、C04 持续错误、C05 实际模型执行中 SIGKILL/恢复、C06 多原生会话竞争、C08/C09 原生输出与权限攻击。
3. **C07 综合漂移**：原 Draft PR #7 已关闭且未合并；其适用的 source/Program/Skill drift 测试已由 PR #13 纳入当前 main 的 tests/integration/m6-e2e.test.mjs S06。该证据仍是脚本 Host 协议层，不是实时模型或原生 Host 漂移验收。
4. 未证明的 Provider exactly-once、模型遵循任意 Skill 指令、同 UID 混合进程隔离不能假定成立；这些必须通过宿主信任设计而非脚本测试补足。

**裁决：C13–C20 协议 PASS，C01–C12 原先已验证结果继续有效；整体 M6 最终验收仍 BLOCKED。PR #12 保持 Draft 待更新/复审；PR #7 已关闭且未合并。当前阶段不修改 main、不发布新版本。**
