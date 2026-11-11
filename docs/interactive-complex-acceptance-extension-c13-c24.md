# FlowKit Interactive P0-A — 复杂验收补充 C13–C24

> 2026-11-11。追加于[冻结 C01–C12](./interactive-complex-acceptance-c01-c12.md)，不修改原冻结用例和通过条件。只针对 P0-A 的 Condition / Agent / Terminal、JavaScript Program / SQLite / Trusted Host。C12/S13 原生模型宿主门禁独立有效。

## 0. 范围与证据等级

- **P — protocol/scripted**：真实编译器、生成 JS Program、SQLite WAL/FULL、Host 回执/签名/CAS、脚本 Agent 回答；证实程序约束，不证实模型行为。
- **M — live model**：实际模型读取真实 Pending 后生成回答，有独立 requestId + taskDigest + tool trace；不等于原生宿主来源认证。
- **N — native host**：Grok Build/Codex 等原生受控宿主，会话/工具原始日志、受信传输的独立来源证明和模型进程隔离。只有这一级可放行 C12/S13。
- **X — out of scope**：Human、Action、Verification、Loop、Parallel、P0-B/P1/P2、Context、通用产物存储、Provider 恰好执行一次。不得用本矩阵引入未批准的功能。

## 1. 追加用例和可观察不变式

| ID | 组合场景 | 正反例和核心断言 | 执行入口 | 验收层 |
|---|---|---|---|---|
| **C13** | 分支真值表 × 阶段预算 | ready=false 不分发 Agent；ready 缺失 FK_R002；reviewApproved=false 去 declined；true 去 done。预算 1/128 的终态 State Hash 一致、Journal 合法 | complex-c01-c12.test.mjs C13 | P |
| **C14** | 第 2 个 Agent 等待时恶意回执 | 错 body、attempt、requestId、伪签、超过 2MiB 的未认证大回执全部拒绝；Checkpoint 字节、Journal、Ack 无变化；合法回执后继续成功 | 同文件 C14 | P |
| **C15** | 下游运行时旧回执重传 | Host 对象重建与终态后重传均返回原始 acceptedRevision，无额外 Journal、无状态重写 | 同文件 C15，交叉 C06/C10 | P |
| **C16** | 最后 Agent 可信 Provider 报错 | 只有签名的 Host call-failed 能触发重试；新 requestId，原状态不污染；旧失败回执仅返回旧 Ack；合法第二次响应路由成功 | 同文件 C16 | P |
| **C17** | 多 Agent 链中途策略漂移 | 修改绑定版本后 load/resume/getPublicAgentTask 均拒绝；Checkpoint/Journal 字节不变；旧 Host 可续接 | 同文件 C17 | P |
| **C18** | 两个 Run 交错与重复启动 | 同 startKey+intent 幂等，变更 State 报冲突；不同 Run 的分支、State、Journal 不串 | 同文件 C18 | P |
| **C19** | 36 Agent 链第 18 步失败 | 无效结果触发 FK_R004；余下 18 个 Agent 不再调度，State 不出现未验证字段，终态 resume 幂等 | 同文件 C19 | P |
| **C20** | 两个独立有效签名但冲突的结果 | 同一 Pending 同时提交两个不同结果，恰好一个 CAS 成功，另一个 FK_I_RECEIPT_CONFLICT；后续仍可正常完成 | 同文件 C20；真 OS 多进程由 crash.test.mjs 另验 | P |
| **C21** | SIGKILL 与跨版本恢复 | Pending、校验、接纳、Commit 切点的真正杀进程恢复；同物理 SQLite 文件在不同 Node 版本/OS 重新打开仍能保留身份、账本 | main crash.test.mjs 已有同环境 SIGKILL；跨 Node/OS 文件转移未验证 | P：部分；跨版本增强项 |
| **C22** | Prompt injection / 模型声称拥有权限 | 未签名的模型输出绝不成为 Host 命令；公开 Task 只包含白名单输入；模型无法获取私钥/私有 SQLite；真实模型中仍需攻击实测 | M5 trusted-host 与 Linux 跨 UID；原生模型进程未验证 | P PASS；N BLOCKED |
| **C23** | 真实模型异常组合 | 真实拒绝分支、真实重试耗尽、实际中途 SIGKILL+恢复、两个真实模型会话竞争都有独立原生执行记录；不能复用脚本 fixture | 原 C02/C04/C05/C06 的 M/N 缺口 | M/N BLOCKED |
| **C24** | 安装兼容、证据与发布门禁 | Program ABI、SDK exports/types、CLI、Node 22/24 × Windows/Linux、docs/site/package、宿主原始工具调用来源；只有全部适用硬门禁通过才可宣称 M6 成功 | CI 7 jobs + C12/S13 | CI P 已历史通过；N BLOCKED |

**裁决**：C13–C20 全部通过只代表复杂协议层 PASS，不等于 24 个真实模型场景全部通过。C21 跨版本迁移是增强项，不擅自升格为 P0-A 原硬门禁；C22–C24 的 N 缺口仍属于原 M6 S13 门禁。

## 2. 端到端风险族覆盖索引

| 风险族 | 关键验收 | 测试位置 | 判定要点 |
|---|---|---|---|
| 编译/SDK | 真正 Analyzer、TS/JS、固定 Stage/Graph、Program ABI、hash、打包/types/docs | compiler-front, ir, emitter, stage2-integration, stage2-program-cache, test:package, test:types, docs:examples | 不得将非法图降级通过，不能以模型代码冒充受信 Program |
| 条件与数据流 | 公开字段、Condition 真/假/缺失、串行 Agent、长链早停、预算等价 | C01/C02/C10/C11/C13/C19 + coordinator | 比较 State/Trace，不只比较 terminal status |
| 失败/重试 | Schema 错误、validator throw、Provider failure、retries+1、容量失败退出 | C03/C04/C09/C16/C19 + coordinator, host-oversize, s07-capacity | 无假 Ack、无无限 waiting、无错误数据合并 |
| 身份/幂等 | runId/requestId/attempt/startKey、重复/冲突回执、并发 | C06/C10/C15/C18/C20 + crash, store | State commit 至多一次，不保证外部模型执行恰好一次 |
| 原子性/恢复 | WAL/FULL、真 SIGKILL、Journal hash 链、回执索引、2 MiB hard、active 余量 | C05/C09/C10/C19/C21 + store, crash, s07-capacity | 崩溃可恢复、损坏 fail-closed |
| 安全/漂移 | Program/Skill/Policy hash、签名与租户、秘密披露、跨 UID | C07/C08/C14/C17/C22 + trusted-host, stage2, host-isolation | Host-only 密钥/DB、不可泄漏、不可被 Prompt 自报权限 |
| 模型/宿主 | 多回合、真实异常路径、原生来源及会话日志 | C01–C06/C12/C22/C23/C24 | P/M/N 分层，禁止用 CI 重放充当模型调用 |

## 3. 判停和证据

每个测试必须记录场景编号、执行类别、模型调用次数、实际 Program 身份、Run/Request 身份（有时）、终态、Revision、Journal/Checkpoint 不变式和断言。敏感值、Host 私钥、数据库内容不得写入公开任务或日志。

测试通过标准：Ubuntu 24.04 / Windows 2025 × Node 22.13.0 / 24.22.1 的精确 HEAD 回归，另有 Ubuntu Node 22/24 OS 用户隔离、网站、打包、类型与 docs 消费。新提交取消的旧 CI 不得作为新 HEAD 证据。

阻断（不得合并 M6）：伪造或越权 Ack、双 CAS 成功、State/Journal 不一致、未披露字段泄漏、合法输入无限 waiting、真实宿主来源证明缺失。故障属于 Core 时另开最小修复 PR，不得在验收分支悄然改动生产逻辑。

历史 C01–C12 结果：[2026-11-11 原报告](./interactive-complex-acceptance-results-2026-11-11.md)。M6 独立整体门禁：[Draft PR #7](https://github.com/devcodex-labs/flowkit/pull/7)。C13–C20 精确结果以本分支最新 GitHub Actions 为准，不继承 364/364 的历史测试计数。
