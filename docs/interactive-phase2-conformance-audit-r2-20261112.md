# FlowKit Interactive — Phase 2 正式契约符合性审查 R2 / 源码定向复核

> **状态：审查工作记录，NOT FINAL / NOT CONFORMANCE PASS。** 本文补充 [R1](./interactive-phase2-conformance-audit-r1-20261112.md)，**不替代、不修改**已确认 Requirements V0.3、Technical Design V0.6-R5、P0-A Implementation Plan V0.1 或 PR #14 Trusted Host V2。只记录已核验代码事实、契约差异、待决事项和后续验证路径；没有修改生产代码、测试、类型或 Schema，也不授权发布、Phase 3/4 越级实施。

## 1. 本轮基线及证据等级

- 当前 main（2026-11-12 检查）：`13d573c5ddc4a0ed3502401589c581799c96c5d2`；[main commit](https://github.com/devcodex-labs/flowkit/commit/13d573c5ddc4a0ed3502401589c581799c96c5d2)。
- R1 使用的旧 main：`ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`；对 `src/interactive/coordinator.mjs`、`trusted-host.mjs`、`sqlite-store.mjs`、`compile.mjs`、`types/interactive.d.ts` 逐一读取两版 GitHub 文件并比较 **Git blob SHA 五项完全一致**。因此 R1 的相关代码事实不因 PR #15 文档合并而失效；其他未比较文件不能套用这一结论。
- 已直接读取正式 V0.3 `FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed(1).md`（§§1–7、15–19 与关键段落）；其历史登记身份为 56,883 bytes / SHA-256 `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e`。
- 正式 V0.6-R5 的身份为 114,621 bytes / SHA-256 `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba`，由 [正式原件登记](./interactive-phase2-formal-source-register.md) 及 PR #15 的历史 9/9 校验支持。**本轮当前会话无法直接读取 Library 中该 Markdown 原始正文（原始文件读取接口返回不可访问），因此涉及 §4/§5/§8/§16 的精确规范措辞，仍引用 R1 已抽取的条款并列为独立复核门禁；不能声称本轮已独立全文复读 V0.6-R5。** 不应因此推翻此前原件已找回的事实，也无需重写原件。
- 证据等级：`SOURCE-CONFIRMED` = 已直接读取具体源码及类型；`SOURCE-INFERRED` = 源码顺序推断、尚未运行反例；`CONTRACT-CONFIRMED-V03` = 已直接读取正式 V0.3；`V06-R1-EXTRACT` = 对应 V0.6 原文由 R1 转录、待独立原文复核；`RUN-BLOCKED` = 未取得该执行场景的原始运行证明。**以上不是测试 PASS 等级。**

### 1.1 当前关键源码身份

| 文件 | main 上 Git blob SHA | 相关代码 |
|---|---|---|
| `src/interactive/coordinator.mjs` | `1ce6460d58c20a38580a30c2966ba8187f1382b7` | 终态帧 L144–151、Store 使用 L221–255、start L534–552、公开返回 L648–657 |
| `src/interactive/trusted-host.mjs` | `315e22662e80c4f1561c2ab8d717a168251c1ed5` | Host start/load L147–168、Agent 公共任务 L170–221、Host 回执 L221–283 |
| `src/interactive/sqlite-store.mjs` | `0f2db54c145649525bcd77b0c501f083dfeb54ee` | 同步 createRun/load/CAS L290–396 |
| `src/interactive/compile.mjs` | `43f6dfa86908a486446dc5193c7a4d2895926617` | compile options snapshot / await / lowering |
| `types/interactive.d.ts` | `a178b2adbff6b18345a7e1b63e3370269ac2425f` | Frame L81–92、Store L106–141、SDK L161–188、Trusted Host L254–288 |

## 2. 发现及复核裁决

### CF-01 — P1 / P0-A 管理终止缺口

- **证据：SOURCE-CONFIRMED + V06-R1-EXTRACT。** [公开导出](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/index.mjs)、[Coordinator 返回 API](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/coordinator.mjs#L648-L657)、[Trusted Host 返回 API](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/trusted-host.mjs#L279-L283) 均无 `adminTerminate`；TS 声明中同样不存在。
- R1 已将正式 V0.6-R5 §4/§16 和已确认实施计划 `A-M5-02` 映射到 P0-A 受权管理终止、独立 admin controller、tombstone 与竞态语义。
- **裁决：代码层高置信 GAP-P0-A；S12-A 不可宣称 PASS。** 业务 `cancel` 属 P0-B，不能充当 P0-A 管理终止。未验证完整 Host Admin 外部程序是否存在于本仓库以外部署，因此不宣称系统级事实超出审查范围。
- **最小验证/修复前置：** 明确受信管理身份与权限、不接受模型自报 admin；设计 admin-only API、CP+Journal CAS 的墓碑、终态与当前结果并发竞争、旧 Program 不可用时的恢复/管理出口及历史回执拒绝。正式语义调整需要单独确认；不能只补方法名。

### CF-02 — P1 候选 / 公共 SDK 形态

- **证据：CONTRACT-CONFIRMED-V03 + SOURCE-CONFIRMED；V06 仍需核验。** V0.3 §7.1 示范 `compileInteractive/start/complete/resume/cancel` 独立导入，§19 将这些能力列为确认内容；**同一节也明确“签名例子仅用于说明”，6.2 的 Store API 亦明示技术设计可微调签名**。当前 [子路径入口](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/index.mjs) 导出 factory，而 [Coordinator 类型](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/types/interactive.d.ts#L161-L188) 的实例提供 `start/complete/resume` 功能。
- **裁决：API 形态差异属实；“缺少这三个能力”不成立。** 是否属于 P1 契约违背，取决于 V0.6-R5 §4 是否冻结了顶层具名导出，以及后续获批的 API 决策；不得仅凭 V0.3 的 proposed 导入例子直接要求新增兼容层。
- **验收：** 原始 V0.6 §4 与实施批准记录复核、实际 package exports 与 JS/TS consumer 对照。若签名调整已经被确认，记 APPROVED DEVIATION；否则提出明确兼容方案等待裁决。

### CF-05 — P1 候选 / 终态 State 投影边界

- **证据：SOURCE-CONFIRMED + V06-R1-EXTRACT。** [Coordinator.asPublicFrame](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/coordinator.mjs#L144-L151) 在终态携带 `state:cp.state`；`InteractiveRunFrame.state?` 在 [类型 L83–92](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/types/interactive.d.ts#L83-L92) 公开声明。[Trusted Host 的 start/resume/load](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/trusted-host.mjs#L147-L168) 转发 Coordinator 帧。[现有单元测试](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/tests/interactive/coordinator.test.mjs#L75-L88) **明确断言终态返回 `result.state`**，这不是偶发实现细节。
- V0.3 §6.3 要求模型只接收最小 Pending，完整 CP 不默认入聊天；R1 记录 V0.6-R5 §4/§5 的 Public Frame 不含完整 State、受权 `readTrustedTerminalResult` 分离。
- **裁决：公共/可信帧角色未清晰拆分，存在误转发风险；不等同已发生真实模型泄漏。** 当前 `getPublicAgentTask` 仍有 allowlist 和授权门禁；必须核对 Host adapter 是否把 terminal frame 误送模型。
- **验收：** 给出 public frame / trusted result 两种明确类型与能力；模型通道做强制最小披露测试；仅授权 Host 可读业务结果；旧测试重新定义为“Host 可信读取”而非“公共可读”。修改类型和 API 须先检查冻结技术契约。

### CF-06 — P1 候选 / 异步 Store 规范与同步实现

- **证据：SOURCE-CONFIRMED + CONTRACT-CONFIRMED-V03 + V06-R1-EXTRACT。** V0.3 §6.2 以 Promise 签名示例描述 Store，并允许技术设计阶段微调名字/结构，但不得减弱可靠 CAS/持久化和 Host 选择 Store 的能力。R1 引述 V0.6-R5 §5/§8 具体五操作异步 `CheckpointStoreV1`；当前 [TS Store 接口](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/types/interactive.d.ts#L106-L141) 为同步 `putArtifact/getArtifact/createRun/load/compareAndSwap` 等；[Coordinator](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/coordinator.mjs#L221-L255) 与 [SQLite Store](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/sqlite-store.mjs#L290-L396) 都同步消费 Store 结果。
- **裁决：无法直接注入一个仅实现冻结“五个 Promise 操作”的异步 Host Store；不代表当前同步 SQLite CAS 已失效，也不代表所有自定义同步 Store 被禁止。**
- **验收/设计门禁：** 对照 V0.6 原文和已批准 M3/M4 调整；最小兼容方案应保护 Program bytes 先验证、创建幂等、原子 CAS+Receipt/Journal、掉响应后的线性化重读，不把任意远程数据库的弱 CAS 冒充满足契约。若需要改变冻结五操作规范，须由用户独立批准。

### CF-07 — P1 候选 / 新增：start() 在首次 await 之后才快照初始 State 与意图

- **证据：SOURCE-INFERRED / 未独立执行完整仓库测试。** [Coordinator.start L534–552](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/coordinator.mjs#L534-L552) 先复制 `programBytes/programIdentity`，然后 `await loadInteractiveProgram`（L542），之后才在 `initialCheckpoint(...,state)`（L548）执行 `copy(state)`，在 L549 才 `copy(startIntent)`。即使 loader Promise 已经 resolved，JS `await` 仍会异步让出执行；调用方可以先改动所持有的两个对象。现有 [测试 L273–281](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/tests/interactive/coordinator.test.mjs#L273-L281) 只检查 `await api.start()` **之后**修改输入；未覆盖首次 await 边界。
- R1 的 V0.6-R5 R04 明示 SDK 输入在 await 期间被突变应继续使用同一份提前克隆的规范字节；V0.3 §5 的阶段输入/提交身份稳定性与这一要求一致。
- **风险：** 同一个调用的 startIntentHash、初始 State 可能受外部对象竞争写入影响，造成不可预期创建/幂等判定。没有证据表明已造成真实越权或线上数据损坏。
- **建议精确复现（测试在该仓库的 `runAgentFixture` 上构造）**：
  ```js
  const state={existing:'before'};
  const startIntent={correlation:'before'};
  const pendingStart=api.start({...source,startKey:'pre-await-mutation',state,startIntent});
  state.existing='after'; startIntent.correlation='after';
  const frame=await pendingStart;
  const saved=store.load(frame.runId);
  assert.equal(saved.state.existing,'before');
  // 同时断言 startIntent 的规范身份来自调用瞬间的 before 值，
  // 可通过对同一 startKey/原始意图重试与不同意图冲突来核验。
  ```
- **最小修订候选：** 在第一个 `await` 前对 `state` 与 `startIntent` 做有界、严格、同一份 JSON 快照，之后所有 Checkpoint/Hash/Store 操作仅使用此快照；校验失败应发生于副作用之前。先复现、再单独 Core 修复 PR，不能把本文件当作测试 PASS。

### CF-08 — P2 候选 / 新增：compileInteractive() 编译选项快照不一致

- **证据：SOURCE-INFERRED。** [compile.mjs](https://github.com/devcodex-labs/flowkit/blob/13d573c5ddc4a0ed3502401589c581799c96c5d2/src/interactive/compile.mjs) 已先建立 `snapshotOptions` 并检查 `snapshotOptions.featureStage==='P0-A'`，但在两次 `await`（readFile/analyzeSource）之后，又通过原始 `options.featureStage` 传入 `lowerInteractive`。
- 调用者在编译等待中把 `options.featureStage` 从 `P0-A` 改为 `P0-B` 时，后续门禁会拒绝，导致原本合法的调用非确定性失败。**当前 `gateInteractiveFeatures` 仍会拒绝 P0-B/P1，不能据此断言有越权启用新阶段的漏洞。**
- **建议：** 新增带可控异步交错的编译选项变更回归，确认从头到尾使用 `snapshotOptions.featureStage`（以及确有需要的深层配置快照）。P2 预防性修复候选，不与 CF-07 混同优先级。

### CF-03、CF-04 — 维持 R1 边界

- CF-03：真实 Grok Build native tool event 绑定、C12/S13/T27、Windows MODEL_USER/HOST_USER ACL/句柄保护继续 `BLOCKED`；M6 scripted e2e 和真实 Grok 文件 Harness 的证据层不能互换。
- CF-04：Action/Human/Loop/Parallel 是已批准的 P0-B/P1/P2 延期范围；P0-A 管理终止与 P0-B 业务取消绝不可混淆。

## 3. 对 R1 的校准及实施顺序

| 工作 | 本轮裁决 | 下一步门禁 |
|---|---|---|
| R1 源码基线较旧 | **已核对五个关键 Blob 与当前 main 相同** | R2 以 13d573 为新基线；审查其他文件仍需逐项检查 |
| CF-01 | 真实 P0-A 缺口，P1 | 复核原始 §4/§16 + 已批准 M5；管理身份/tombstone/竞态负例 |
| CF-02 | 能力存在于 factory，顶层签名争议 | V0.6 §4 原文 + 批准决策；不抢先扩张 public surface |
| CF-05 | 源码/TS 的终态 State 暴露属实 | 设计可信读取与公开投影分离，核对 model-facing adapter |
| CF-06 | 同步 Store 与 R1 转录的异步五操作不一致 | 复核 V0.6 §5/§8、批准变更与最小适配；无旁路弱 CAS |
| CF-07 | 新源码竞态，R04 需测试 | 新增失败复现测试；获准后最小修复 + 跨 Node/OS 回归 |
| CF-08 | 新编译选项竞态，当前无绕过证据 | 补异步交错回归，评估 P2 修复 |
| C12/S13/OS | `BLOCKED`（非全红、非全绿） | 保留 Phase 3/4 独立验收门禁，先工具能力 PoC、后原生 N 层 |

**不自动进入生产 Core 变更或合并。** 正式契约原文对照、失败复现、最小修复方案与用户已确认计划之间仍有待决门禁。先用此 R2 对照原始 V0.6-R5 和既有实施批准记录开展独立复审；在没有第二审查者、真实运行证据、PR HEAD CI 时，不得将 Phase 2/M6/P0-A 宣布完成。R1 的 T01–T34、R01–R22、S01–S14 逐项台账仍有效，任何一项缺少运行证据继续 PARTIAL/BLOCKED，不因本文件的源码核对而改为 PASS。

## 4. 变更记录

- **R1**：原件和条款索引、首次实现证据矩阵（旧 main `ae5fc5a`）。
- **R2（本文件）**：对五个关键源码 Blob 重新固定 main `13d573c`；重审 CF-01/02/05/06 的裁决边界；新增 CF-07/08 及复现计划；保持所有冻结契约不变。


## 5. CF-07 独立测试证据关联（R2 补充索引）

- 测试分支：`test/r04-start-input-snapshot-20261112`；[PR #17](https://github.com/devcodex-labs/flowkit/pull/17)。
- 2026-11-12 的独立测试提交：`ada01c933553206948ffcf2f944dfc5604e44da2`。两个不同用例分别锁定 `state`（包括嵌套引用）与 `startIntent` 在首次 await 前的快照要求。
- 这仅是**预期失败的源码复现测试**，尚无成功启动 runner 的正式测试证据；CI `queued` 与测试 `FAIL` 不可混同。
- 此处只增加证据链接，不改变任何需求、实现判定、生产 Core、SDK、Program ABI 或 SQLite Schema。
