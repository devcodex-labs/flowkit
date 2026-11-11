# FlowKit Interactive P0-A — 复杂验收矩阵 C01–C12（冻结版）

**范围与判断标准**：此矩阵只测试 P0-A 的 `Condition / Agent / Terminal` 和可信 Host 的 CAS、回执、恢复、安全。不得把 Standard 的 Human/Action/Verification/Loop/Parallel 实现或脚本 Worker 的结果当作 Interactive 已支持或真实模型验证。不得把 GitHub CI 的测试数量当成真实模型会话次数。

**证据必须分层**：
- **Protocol / Scripted（自动化）**：实际 FlowKit Compiler → JavaScript Program → SQLite Store / Trusted Host 执行，但 Agent 结果由脚本提供。证实协议，不证实模型遵循指令。
- **Live Model（真实模型）**：真实 ChatGPT/Grok 逐次读取已生成的 Pending 后生成答案；每次的 requestId、taskDigest、输出、工具操作必须有独立证据。ChatGPT → GitHub Actions 桥接只能证明真实参与和受控处理，不代表原生宿主/会话来源认证。
- **Native Host（S13）**：单个受控 Grok Build / Codex 原生会话模型→JS 工具→Host→回执，原生工具日志及 Host 独立验证的会话/来源证据；不能用脚本模拟、GitHub 上传身份替代。

## 场景、可观测预期和证据

| ID | 场景 | 冻结验收要求 | 自动化证据范围 | 真实模型门禁 |
|---|---|---|---|---|
| C01 | 4 个串行 Agent + 2 个 Condition | 原生 Program 顺序、后续节点只接收合法上游状态，未跳过/重复执行；最终 State 包含各节点输出 | 新增复杂链+Host 签名测试 | **待实测**：至少四次真实模型回合 |
| C02 | 动态路线与异常条件 | ready=true/false、审查通过/拒绝、缺失 when 输入分别进入正确路径；未选 Agent 不调度 | 新增多路径正反测试 | **待实测**：至少两条真实分支 |
| C03 | Schema 拒绝与修复 | 第一次输出无效不污染 State；下一 Pending requestId/attempt 更新，合法结果可以成功 | 新增接纳/重试负例 | **待实测**：真实模型两次输出 |
| C04 | 失败/重试耗尽 | retries+1 限制，最后 `FK_R004`，State 不含未认可结果 | 新增失败序列 | 至少一个可信 Host 失败路径（真实模型待实测） |
| C05 | Host 崩溃恢复 | Pending 发布、接纳前、校验及提交各切点 SIGKILL；请求 identity/State/Journal 一致 | 已有 `tests/interactive/crash.test.mjs` 三项真子进程测试；M6 PR #7 另外有 Host+脚本 Worker | 与真实模型耦合的 kill/resume **待实测** |
| C06 | 双进程竞争、丢响应、重复回执 | CAS 只接纳一次；后续始终返回原始 `acceptedRevision`；不声明外部 Provider 恰好执行一次 | 已有 `crash.test.mjs` + `coordinator.test.mjs` | 原生模型多会话竞争待实测 |
| C07 | Program / Skill / Policy 漂移 | 变更后未发生额外调度/CAS；旧依赖恢复不误放行 | main M5 policy 测试；M6 PR #7 真实 Host 脚本式 source/Skill/Program drift | 原生 Host/模型待实测 |
| C08 | 权限、签名与泄漏 | 错租户/伪签/敏感字段/UID 隔离 fail closed；模型不能直接操作私有 Store | main M5 `trusted-host` + Linux 2 项 OS 用户隔离任务 | 原生 Grok Build 私钥/SQLite 不可达待实测 |
| C09 | 容量与超限 | 2MiB hard，1.75MiB active 预留；有界结果可成功；错误原子退出；未认证超大回执不能杀 Run | main S07 `s07-capacity` + `host-oversize` | 真实模型大输出路径待实测 |
| C10 | 长链与账本 | 至少 30 个串行 Agent，Checkpoint 近期摘要 ≤16，SQLite 全量历史回执可查；Journal 连续，恢复历史 Ack | 新增长链与 SQLite 回执索引测试（现有 21 节点基础） | 不要求 30 次模型计费；脚本覆盖为准 |
| C11 | 阶段预算一致性 | `maxStagesPerCall=1` 与 128 在相同 Program/结果序列下最终 State **字节相等**，Journal 合法；不要求 revision 一致 | 新增复杂链跨预算用例，M6 PR #7 还有脚本 Worker 验收 | 模型侧不同调度路径待实测 |
| C12 | 原生真实模型宿主 | Grok Build 等原生 JS 工具调用原始日志、真实会话身份、Host 独立来源认证、隔离、终态 | **不能用脚本或 GitHub ChatGPT 桥接替代** | **BLOCKED**：需 Dot/Grok Build 实际宿主权限与真实日志 |

## 每个可执行测试的最小证据格式

```json
{
  "scenarioId": "C01",
  "execution": "SCRIPTED_HOST",
  "programHash": "sha256:...",
  "runId": "...",
  "nodeTrace": ["requirements", "design", "plan", "review"],
  "checkpointStatus": "succeeded",
  "journalRevisions": 0,
  "assertions": ["..."],
  "result": "PASS"
}
```

测试完成后补充**精确提交/CI URL、各环境完成状态、实际模型回合次数、失败/未覆盖限制**。即使自动化 7/7 通过，C01–C05 只应在「协议层」标记 PASS；真实模型层未取得证据必须为 PARTIAL/BLOCKED。

## 阶段门禁

1. 只开发测试与验证报告，发现真实缺陷才另外起小范围修复 PR；不擅自重构 FlowKit Core。
2. 不因绿灯合并 M6 PR #7，不因 ChatGPT 工具桥接宣称 Grok/Codex 原生模型来源验收通过。
3. 在复杂矩阵中允许使用脚本结果注入来做 30 Agent、并发、容量、安全负例，但必须标明执行类型和模型调用次数（脚本为零）。
4. M6 所需的冻结需求 V0.3 / 技术 V0.6-R5 合规审查仍独立存在，不能被此矩阵替代。
5. 本轮不引入 P0-B、P1、P2、Context、通用业务产物存储或 GC。
