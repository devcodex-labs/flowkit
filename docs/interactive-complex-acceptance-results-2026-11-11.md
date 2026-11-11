# FlowKit Interactive P0-A 复杂验收 C01–C12 — 实测结果与缺口

**日期：2026-11-11。仓库：devcodex-labs/flowkit。**  
**被测试分支：test/interactive-complex-c01-c12-acceptance。**  
**测试基线 main：ea2bb10893a9be2e5de3561fc9a660a6977ae15c。**  
**代码+真实 ChatGPT 结果 HEAD：abe592e888a4ea77357e31bd5d26ab14b4dac1dd。**

**结论：复杂 P0-A 自动化回归通过，真实 ChatGPT 4 Agent / 5 回合的非原生工具桥接通过，Grok Build 等原生宿主 C12/S13 仍 BLOCKED。不是“C01–C12 全部完成”。**

## 1. 精确提交 / CI 证据

- [GitHub Actions 42963110678](https://github.com/devcodex-labs/flowkit/actions/runs/42963110678)：7/7 jobs completed / success，Windows 2025 与 Ubuntu 24.04 × Node 22.13.0 / 24.22.1 四组合各 **364 tests / 364 pass / 0 fail / 0 skip**，并且四个组合均输出了 C01_LIVE_CHATGPT_COMPLETED 及 C01/C02/C03/C04/C10/C11 的 FLOWKIT_COMPLEX_ACCEPTANCE 结构化记录。
- CI 同时覆盖打包、类型、Standard Regression、文档消费、网站构建以及两项 Linux Host 跨 UID 权限隔离。
- 完成前的多轮 GitHub Actions 因 PR 新提交被取消，**不能**把它们作为精确最终 HEAD 的 7/7 通过证据；每个模型回合的原始 Pending / SHA 仍可在对应 Job 日志核查。
- Program 代码来源：真正的 FlowKit Analyzer/Interactive Lowerer/Emitter，运行时使用实际生成的 JavaScript Program、默认 SQLite Store 与 Ed25519 Trusted Host；除真实模型桥接外，Agent 回答由脚本确定性提供，**模型调用数为零**。

## 2. 每项单独裁决

| ID | 协议/脚本验收 | 当前 ChatGPT 桥接 | 原生 Grok Build/Codex Host | 主要证据与限制 |
|---|---|---|---|---|
| C01 串行 4 Agent + 2 Conditions | **PASS** | **PASS（5 次真实模型输出）** | BLOCKED | 脚本 4 个签名回执、35 Journal；真实桥接 4 个不同 Agent / 5 回合，39 Journal，正常 succeeded |
| C02 动态条件与缺失值 | **PASS** | **PARTIAL** | BLOCKED | 脚本分别覆盖 ready=false 直接 declined、ready 缺失 FK_R002、reviewApproved=false 走 declined；真实桥接只覆盖 ready=true + reviewApproved=true |
| C03 Schema 拒绝与修复 | **PASS** | **PASS（受控故障注入）** | BLOCKED | 第一次 reviewApproved 为字符串，被校验拒绝；新 requestId、attempt=2、reasons 中出现类型错误；第二次真正布尔 true 成功，未污染已确认 State |
| C04 重试耗尽 | **PASS** | BLOCKED | BLOCKED | 两次错误结构导致 FK_R004；真实模型只执行了一次拒绝然后修正，没有执行真实持续失败 |
| C05 Host SIGKILL 恢复 | **PASS（既有真子进程）** | PARTIAL | BLOCKED | main tests/interactive/crash.test.mjs 覆盖 Pending 发布、接纳、校验、State 提交前后 SIGKILL；真实 ChatGPT 只在单次 CI 内重新打开 SQLite，并非模型执行中途 SIGKILL |
| C06 并发与重复回执 | **PASS（既有真子进程）** | PARTIAL | BLOCKED | main crash.test.mjs 双进程 CAS 竞争及 coordinator.test.mjs 丢响应恢复；真实 ChatGPT 连续提交不是并发模型会话 |
| C07 Program/Skill/Policy 漂移 | **PARTIAL** | BLOCKED | BLOCKED | main Stage2 policyHash 版本漂移、M5 Program 字节/策略篡改拒绝均已测试；源/Skill/Program 综合漂移还在 M6 Draft PR #7 的脚本 Host 用例，不能称已经合并到 main |
| C08 签名、隔离与泄漏 | **PASS（已有指定边界）** | PARTIAL | BLOCKED | main TrustedHost 错签、错租户、输入披露白名单与 Linux 跨 UID 密钥/SQLite 读取拒绝；未证明 Windows ACL 或原生 Grok Build 模型进程隔离 |
| C09 Checkpoint 容量 | **PASS（脚本）** | BLOCKED | BLOCKED | main s07-capacity / host-oversize：2 MiB hard、1.75 MiB active、可接受的 256 KiB 结果、不可接纳的合法回执原子退出；未认证 >2 MiB 拒绝；无真实模型大输出事件 |
| C10 36 Agent 长链 | **PASS（脚本）** | 非必需 | BLOCKED | SQLite Journal 255 条，近期回执缓存 16，全部 36 个 acceptedRevision 可恢复查询，最早回执重放 Ack 不变 |
| C11 budget=1 与 128 | **PASS（脚本）** | 非必需 | BLOCKED | 最终 State 哈希 sha256:e69d3bc210a864cab2801e1c479c5cbc6db7bf492e65256078bafc53be1f7c25，两个预算 Journal 分别 85 与 35 条，符合阶段预算造成不同迁移记录的预期 |
| C12 原生真实模型宿主 | **不适合脚本替代** | ChatGPT GitHub 桥接 PASS，但不满足此项 | **BLOCKED** | 缺 Grok Build / Codex 原生单会话模型→JS 工具→Pending→真实模型→Host 原生工具日志、独立来源认证与宿主隔离证据 |

**判定用语说明**：PASS 只适用于该列所声明的执行类型，PARTIAL 为只覆盖部分冻结预期，BLOCKED 为缺真实环境或证据。不存在“364/364 = 364 个复杂真实模型用例”的推断。

## 3. 真实 ChatGPT 多节点工具桥接的确切边界

使用 [C01 真实工作流定义](../examples/interactive/c01-live-chatgpt.workflow.js)，生成的不可变 Program 哈希：

sha256:339425694337fdd24ff005b2d8eab3109d4026ce6bc176f7a8c130421a7cabb5

本次当前 ChatGPT 模型**按顺序**从 GitHub Actions 的 C01_LIVE_CHATGPT_PENDING 日志读取公开任务，提交到 tests/fixtures/c01-live-chatgpt-turns.json 的五次模型结果：

| 回合 | 模型实际操作 | 提交 SHA | 条件/结果 |
|---|---|---|---|
| 1 | Requirements Analysis，写 requirementSummary | 1d515fe0fe9530e1a866a566e0bc122e6b834690 | 真实 Pending #1；成功 |
| 2 | Architecture Design，使用公开 requirementSummary 写 designSummary | 031eb4337a292eebcacafcf3cef27e48c2757e12 | 真实 Pending #2；成功 |
| 3 | Implementation Plan，使用公开 designSummary 写 executionPlan | f0fd5700d1856e05d437e54184b324f5c9d89286 | 真实 Pending #3；成功 |
| 4 | Independent Review，故意给错误类型的 reviewApproved | 7363bd1742fc94a99e05d7140d2e545d57145e04 | **受控错误注入**；校验拒绝，仅接纳回执身份，不写入业务 State，产生 attempt=2 |
| 5 | Independent Review，根据新的 reasons 修正 reviewApproved 布尔值 | abe592e888a4ea77357e31bd5d26ab14b4dac1dd | 新 requestId，成功，Condition 决定 succeeded/done |

最终结构化日志字段：C01_LIVE_CHATGPT_COMPLETED，realModelTurns=5，status=succeeded，journalRevisions=39，retriesObserved=1，terminal node=done，模型公开任务未泄露 Host 私有 canary。每个 CI Job 在各回执间确实关闭/重开了自己的 SQLite 数据库，证明同一 Job 内物理数据库恢复及 Host 重建。

**必须防止三种误称：**

1. 首轮 Actions 发布公开任务 → ChatGPT 通过 GitHub 工具提交 → 下一轮 CI **重新创建相同逻辑 Run**。两个 Actions 运行**没有**共用一个数据库，也不是单个原生模型 Agent Runtime 自主调用下一次模型。该模型输出只是从真实公开 Pending 派生，GH 提交身份不能代替模型原生会话证明。
2. 第 4 回合是为了验证校验/重试特意注入错误类型，**不是**证明模型在自然任务中会稳定自行纠错。
3. 四个 OS/Node 组合都运行同一份已保存的模型回答，不等于真实模型发起了 20 次独立调用。模型真实回答数是 **5**，CI 重放总次数另行统计。

## 4. 原有复用的代码证据

- C05：main [tests/interactive/crash.test.mjs](https://github.com/devcodex-labs/flowkit/blob/ea2bb10893a9be2e5de3561fc9a660a6977ae15c/tests/interactive/crash.test.mjs)。
- C06：同一 crash.test.mjs 与 [coordinator.test.mjs](https://github.com/devcodex-labs/flowkit/blob/ea2bb10893a9be2e5de3561fc9a660a6977ae15c/tests/interactive/coordinator.test.mjs)。
- C07：main Stage2 / M5 tests，及未合并的 [M6 PR #7](https://github.com/devcodex-labs/flowkit/pull/7) 的综合漂移脚本测试。
- C08：main trusted-host.test.mjs + .github/workflows/ci.yml Linux Host OS-user isolation。
- C09：main s07-capacity.test.mjs 与 host-oversize.test.mjs。
- C01–C04/C10/C11：本 PR 的 [complex-c01-c12.test.mjs](../tests/interactive/complex-c01-c12.test.mjs) 与 CI JSON 事件。

## 5. 独立验收裁决与下一步

**代码结果：** 尚未发现新的 P0-A Core 语义故障。C01–C04/C10/C11 新增协议脚本测试和真实 ChatGPT 五回合完整通过，且未提前实现未授权的 P0-B/P1/P2。

**不足：** C07 的综合漂移整合尚在 M6 Draft；C02 的真实模型 false 分支、C04 真实持续失败、C05 中途实际 SIGKILL + 模型、C06 并发模型会话以及 C08–C09 原生模型场景尚未覆盖。**C12/S13 必须继续 BLOCKED。**

**建议：**将此验收分支继续保持 Draft 作为完整证据，不把固定五回合 fixture 作为可永久依赖的生产回归测试。下一步使用用户可授权的 Dot/Grok Build 原生宿主，在真实模型会话和明确 OS 可信边界下优先复验 C01/C03/C05/C08/C12（尤其原生模型来源证明）；不因本次 CI 绿灯合并 M6 PR #7、发布软件或转入 P0-B。

完整的冻结验收目标详见 [C01–C12 矩阵](./interactive-complex-acceptance-c01-c12.md)。
