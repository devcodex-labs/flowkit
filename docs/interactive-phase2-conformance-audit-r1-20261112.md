# FlowKit Interactive — 正式契约符合性审查 / R1 证据矩阵（阶段性）

> **阶段性审计，不是最终 PASS。** 基于当前 main 的已查源码和测试定义，结合已验证的正式原件自动提取 T01–T34、R01–R22、S01–S14。尚未逐项重跑每个反例/进行真实宿主安全验证；不得把存在测试文件或原型通过解释为完整验收。

## 0. 证据固定

- 当前审查代码基线：`ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`（PR #14 已合并，PR #15 当时尚为 Draft）。
- V0.3 原件：56,883 bytes / SHA-256 `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e`。
- V0.6-R5 原件：114,621 bytes / SHA-256 `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba`。
- V0.6-R5 §15 的「当前实现全部 NOT-EXECUTED」是 2026-11-10 的历史设计状态；不能直接当成当前 main 的状态。
- GitHub CI 证据：PR #14 合并后 main run [43132513659](https://github.com/devcodex-labs/flowkit/actions/runs/43132513659) 全 7 Jobs 成功；CI 是实际脚本/类型/包/文档回归，而不是原生 Grok 来源证明。

## 1. 高优先级初步发现（原文 ↔ 当前 main）

**CF-01 / P1 / P0-A adminTerminate 未发现实现。** V0.6-R5 §4（第 226–243 行）及 §16（第 1030–1035 行）明确将受权 `adminTerminate` 和独立 Host Admin Controller 放入 P0-A。2026-11-10 已确认实施计划 M5 的 `A-M5-02` 也要求 Admin tombstone/审计和竞态测试。当前 `src/interactive/index.mjs` 只公开 `compileInteractive/loadInteractiveProgram/createSqliteCheckpointStore/createInteractiveCoordinator/createTrustedInteractiveHost` 及 Host statement helper；`src/interactive/coordinator.mjs` 的闭包 API 仅包含 start/complete/resume/load；`types/interactive.d.ts` 未声明 adminTerminate。必须在不接收模型自报管理员 JSON 的前提下核验真实 admin channel、tombstone、已终态竞争和旧 Program 缺失管理出口。**结论：代码层高置信缺口；不能把 S12-A/M5 完成判为 PASS。**

**CF-02 / P1（待契约裁决） / P0-A 公开 SDK 形态不一致。** V0.3 §7.1（第 250–274 行）与 V0.6 §4（第 226–255 行）描述 `@devcodex-labs/flowkit/interactive` 公共 `start/complete/resume`；当前 `src/interactive/index.mjs` 导出的是 `createInteractiveCoordinator()` / `createTrustedInteractiveHost()` factory，调用签名和公开能力不同。当前 `package.json` 确实提供 `./interactive` 子路径但不是冻结示例中的命名函数。可能是后续获批的 Host-only 封装调整，尚无当前证据证明这种签名变更被正式批准；建议独立核验变更记录，若无批准则列为契约冲突候选，不直接改源码或改旧需求。

**CF-03 / BLOCKED / Host 真实来源与 OS 隔离。** 当前 M6 11 项 e2e 为真实 Node Host + scripted Worker，验证 P 等级协议；先前 Grok 文件 Harness 的真实模型参与为有限 M 证据，**都不能证明** C12/S13/T27 的原生工具调用、Windows 独立账户/ACL 与可信模型会话来源。PR #14 安全设计已经记录了 H3-01/H3-05/NAT-14 等后续门禁，仍需实测。

**CF-04 / 边界声明 / 依法延期范围。** V0.3 §15 与 V0.6 §16 明确 P0-B/P1/P2 阶段范围；Action/Human/Loop/Parallel 未实现 **不是** P0-A 失败。P2 any 赢家/迟到副作用尚未获专项确认，不得推测已批准语义。

## 2. V0.3 T01–T34 原文验收与实现证据

| ID | 原始阶段 | 正式需求（输入 / 必须结果，逐字提取） | V0.6 映射 | 当前审计判定 | 已观察到的代码/测试入口（需继续证明实测范围） |
|---|---|---|---|---|---|
| T01 | A | 纯 Condition/Terminal → 真实 JS 状态转移，一次启动到正确终点；每个已完成阶段被存储 | §3/§10.2 | P-PARTIAL | src/compiler/interactive/emit.mjs#L111; tests/interactive/coordinator.test.mjs#L75; tests/integration/m6-e2e.test.mjs#L293 |
| T02 | A | Agent/Skill/缺失输入 → Pending 的 instruction、Schema、missing、attempt 与存储中的任务一致 | §7/§10.1 | P-PARTIAL | src/interactive/coordinator.mjs#L534; tests/interactive/coordinator.test.mjs#L90; tests/interactive/compiler-front.test.mjs#L17 |
| T03 | A | 已持久等待后杀进程，再新进程 complete → 不从起点重跑已提交阶段；State/下一节点正确 | §3/§8 | P-PARTIAL | tests/interactive/crash.test.mjs#L89; tests/integration/m6-e2e.test.mjs#L201 |
| T04 | A | 非法 Schema 输出、必要验证器不存在 → 候选不污染 State；不能默认判通过 | §7/§10.1/§12 | P-PARTIAL | tests/interactive/coordinator.test.mjs#L170; tests/interactive/coordinator.test.mjs#L197 |
| T05 | A | 旧 requestId、错误节点/attempt/runId → 回执拒绝，最新 CP 不变 | §7/§8/§11 | P-PARTIAL | tests/interactive/coordinator.test.mjs#L151; tests/interactive/trusted-host.test.mjs#L357 |
| T06 | A | 相同请求同回执重复、同 ID 冲突回执 → 已提交结果幂等确认；不同内容冲突拒绝；不双推进 | §7/§8 | P-PARTIAL | tests/interactive/coordinator.test.mjs#L137; tests/interactive/store.test.mjs#L130 |
| T07 | A | 修改源/产物/编译器/策略身份 → 不兼容恢复拒绝；原 CP 保留 | §6 | P-PARTIAL | src/interactive/load.mjs#L54; tests/interactive/coordinator.test.mjs#L244; tests/integration/m6-e2e.test.mjs#L340 |
| T08 | A | JSON 非法值、循环/原型/超限 → 不丢字段、不污染 Store，不静默截断 | §11/§13 | P-PARTIAL | src/interactive/canonical.mjs#L34; tests/interactive/store.test.mjs#L50; tests/interactive/s07-capacity.test.mjs#L89 |
| T09 | A | 两进程 CAS 争抢同一 revision → 仅一个后继被 Store 接受；失败者读取最新状态 | §8 | P-PARTIAL | tests/interactive/store.test.mjs#L196; tests/interactive/crash.test.mjs#L152 |
| T10 | A | 不受支持的节点/Agent verify 配置 → 编译或启动预检明确拒绝；Standard 仍合法 | §2/§6 | P-PARTIAL | src/compiler/interactive/feature-gate.mjs#L21; tests/interactive/compiler-front.test.mjs#L38 |
| T11 | Host | 完全没有 JS 执行工具 → 宿主层明确报告不支持，不能模拟已运行 | §13 | HOST-BLOCKED | docs/interactive-host-security.md; no verified no-JS host tool scenario; not a Core-only test |
| T12 | A+B | 原 Standard 测试、AOT、TypeScript、固定 SDK/错误码 → 没有现有行为和包导出回归 | §1/§16 | P-PARTIAL | package.json; .github/workflows/ci.yml; tests/contracts.test.mjs; scripts/test-types.mjs |
| T13 | A+B | Agent `retries:2`，连续非法输出 → 依次 attempt 1/2/3，失败 reasons 正确、状态不污染 | §10.1 | P-PARTIAL | src/compiler/interactive/emit.mjs#L85; tests/interactive/coordinator.test.mjs#L170 |
| T14 | A+B | Agent 尝试耗尽、普通外部失败 → 保留 `FK_R004` 归因，不伪装 DSL failed | §10.1/§12 | P-PARTIAL | tests/interactive/coordinator.test.mjs#L170; tests/interactive/coordinator.test.mjs#L213 |
| T15 | B | `validateResult/checkStep/verify` 多阶段及候选态 → 顺序、严格返回值、阶段持久、成功一次合并 own keys | §10.1/§7 | DEFERRED-P0-B | src/compiler/interactive/feature-gate.mjs#L6; confirmed phase boundary |
| T16 | B | 外部 Action 成功与超范围 Patch → 合法 writes 一次写入；越权字段拒绝；操作不双发 | §10.3/§11 | DEFERRED-P0-B | src/compiler/interactive/feature-gate.mjs#L6; no Action support in P0-A |
| T17 | B | 已发 Action 外部成功但回执丢失 → 稳定 operationId，只进入 reconcile，不盲重发 | §8/§10.3 | DEFERRED-P0-B | V0.6-R5 §10.3; Action reconcile not yet implemented |
| T18 | B | Action 非控制异常直接连接普通 Verification → 保存 ctx.error 安全摘要并跳过 Verify，正确转失败路径 | §10.3/§14 | DEFERRED-P0-B | V0.6-R5 §10.3/§14; contextError not yet implemented |
| T19 | B | 普通/Loop Verification true/false/非法响应 → 严格布尔、跳转正确、状态无污染 | §10.4 | DEFERRED-P0-B | V0.6-R5 §10.4; independent Verification not yet implemented |
| T20 | B | Human 拒绝→修订→批准，包括前缀入口 → 审批来源可信、控制栈恢复、无多跑/漏跑 | §10.5/§11 | DEFERRED-P0-B | V0.6-R5 §10.5/§11; trusted Human channel pending |
| T21 | B | Loop 1/3 轮，最后失败 → 最后一轮失败后不修订，进入 onMaxExceeded | §10.6 | DEFERRED-P0-B | V0.6-R5 §10.6; Loop not yet implemented |
| T22 | B | Skill 变更、失败、恢复同一 pending → instruction 固定、版本校验、不重新加载出不同内容 | §6/§10.1 | DEFERRED-P0-B | tests/integration/m6-e2e.test.mjs#L340 covers P0-A drift only; P0-B scope remains |
| T23 | B | 显式取消、迟到结果、控制信号 → tombstone、迟到回执不恢复业务推进 | §3.6/§4/§10.8 | DEFERRED-P0-B | V0.6-R5 §3.6; business cancel deferred (adminTerminate P0-A is separate missing gap) |
| T24 | P1 | all_succeeded 多 Pending、失败和断进程 → Join 一致、剩余任务处置可见、不会无理由自动取消 | §10.7 | DEFERRED-P1 | V0.6-R5 §10.7; all_succeeded protocol pending design/implementation |
| T25 | P2 | any 获胜、迟到分支与下游读取 → **等待 P2 专项协议后确定预期**，不得以 V0.2 旧方案冒充通过 | §10.7（未裁决） | BLOCKED-P2-DECISION | V0.3 §15 explicitly does not freeze P2 any winner/late result semantics |
| T26 | P1 | 多 Pending 乱序、重复、CAS 和写集合冲突 → 状态一致、合法写入、拒绝冲突 | §10.7 | DEFERRED-P1 | V0.6-R5 §10.7; parallel shared-write conflict semantics pending |
| T27 | Host | 真实可用宿主（含 ChatGPT 专项） → 真正调用 JS、模型完成 Pending、再调用 JS，保存执行证据；无能力的平台记 BLOCKED | §13 | N-BLOCKED | tests/integration/m6-e2e.test.mjs#L171 only scripted worker; live Grok file-harness ≠ native JS tool loop |
| T28 | 全部 | 源码/生成 JS/包/类型/文档/测试交叉比对 → 版本一致、实际通过与未实现范围如实列明 | §16 | P-PARTIAL | package.json; .github/workflows/ci.yml; source/docs/type crosswalk not yet complete |
| T29 | A+B | 在每个 Agent 阶段前/后强制终止进程 → 从最近已提交阶段恢复，不跳过/多跑阶段 | §3/§8 | P-PARTIAL | tests/interactive/crash.test.mjs#L89,L118; tests/integration/m6-e2e.test.mjs#L201,L234 |
| T30 | A+B | 故意伪造 Cursor、历史收据或程序身份 → 可信范围内结构与一致性校验拒绝；不继续外部动作 | §8/§11 | P-PARTIAL | tests/integration/m6-e2e.test.mjs#L306; tests/interactive/store.test.mjs#L226; tests/interactive/trusted-host.test.mjs#L147 |
| T31 | A+B | 非纯验证器/双进程 complete 竞态 → 禁止重复进行未受控外部验证；CAS 确定唯一后继 | §10.1/§8 | P-PARTIAL | tests/interactive/coordinator.test.mjs#L197; tests/interactive/crash.test.mjs#L152; non-pure verifier remains P0-B |
| T32 | B | Action 成功但提交前崩溃且目标不支持幂等 → 保留未知状态、对账/人工介入，不承诺 exactly-once | §10.3 | DEFERRED-P0-B | V0.6-R5 §10.3, no Action external effect reconciliation in P0-A |
| T33 | A+B | 同一 DSL 的 Standard/Interactive Agent、Human、Loop、Action 路线 → 相同可信结果下可观察顺序/重试/终点对照；模式差异显式记录 | §14 | P-PARTIAL | tests/integration/m6-e2e.test.mjs#L171,L293; docs/interactive.md; P0-B Standard parity deferred |
| T34 | A+B | 超长运行、资源预算、隐私信息被误送模型 → `paused` 可恢复，限额拒绝不丢 CP，模型只能看最小 Pending | §11/§13 | P-PARTIAL | src/interactive/canonical.mjs#L7,L11; tests/interactive/s07-capacity.test.mjs; tests/interactive/trusted-host.test.mjs#L99 |

> **审计状态解释：** `P-PARTIAL` 表示已在当前源码/脚本中找到与条款相关的执行或测试入口，尚未独立完成所有正式断言；`DEFERRED` 是已批准的后续阶段；`N-BLOCKED` 缺原生可信宿主证据；`GAP-P0-A` 是在当前应交付范围内尚未找到实现；这些均不是 PASS。

## 3. V0.6-R5 R01–R22 历史反例追踪

| ID | 原始对抗场景 | 原始必须观察到的结果 | 映射 T | 当前审计判定 |
|---|---|---|---|---|
| R01 | Agent `complete` 成功 CAS 回执、验证前杀进程 | 新进程仅校验已保存 candidate；Agent 无二次派发 | T03/T06/T29 | P-PARTIAL |
| R02 | 回执已接纳、后续阶段已推进到 `revision+5` 后重发相同提交 | ack 保留 original acceptedRevision；Frame 是 latest；不会倒退 | T06/T09 | P-PARTIAL |
| R03 | Store `compareAndSwap` 成功但丢响应，load 读旧版本 | 该 Store 被判不符合线性化契约；不得盲派发 | T09/T29 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R04 | SDK 输入对象在 `await` 期间被外部突变 | 校验/Hash/CAS 使用同份克隆规范字节，不接受新输入 | T08/T30 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R05 | `validateResult` 返回 `undefined`、数字或抛异常 | 不判通过，也不作为业务校验失败直接消耗 attempt | T04/T31 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R06 | 纯验证器写文件或改外部状态 | 配置声明为纯违反契约；不能称其操作被 FlowKit 自动防重复 | T31/T32 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R07 | Action 错误直接接普通 Verification；`state.error` 原本不存在 | 原 Verification 被跳过、CP 记录 contextError、业务 State 无新 `error` 属性 | T18/T33 | DEFERRED-P0-B |
| R08 | Stage CP 已保存 `received`，请求 `resume` | 不返回空 `waiting`，不得要求旧 request 再执行 | T03/T29 | P-PARTIAL |
| R09 | 同一 Tenant 下 startKey 冲突 / 不同 Tenant 同 key | 前者按 hash 对比，后者隔离；无跨租户 runId 复用 | T05/T09/T30 | P-PARTIAL |
| R10 | 故意替换验证后未加载的生成文件 | 要求从同一份已验证字节导入；身份不匹配拒绝 | T07/T30 | P-PARTIAL |
| R11 | 内部 Store 超时，另一个调用已经推进多个阶段 | 线性化 load + Ledger 查清是否接纳，不仅看 revision+1 | T06/T09/T29 | P-PARTIAL |
| R12 | 2000 条以上阶段写入、ledger 累积、WAL 扩张 | 明确写放大、资源限制，必要时事务内拆表，不丢回执 | T29/T34 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R13 | 生成 IR 同时出现 `await` 与 CP `awaiting` | Compile/IR validator 拒绝未约定阶段；合法结果采用唯一枚举 | T01/T03/T30 | DESIGN-ONLY/NOT-FULLY-TESTED |
| R14 | 向 `advance` 送错 Block 的 `certifiedEvent` 或非法 `toBlockId` | `FK_I_INVALID_TRANSITION`，CP 不变，不派发 | T07/T30 | P-PARTIAL |
| R15 | Verification 抛执行错误，另一次真实返回 `false` | 前者不走 `onFailure`，后者才走；失败原因可恢复 | T19/T33 | DEFERRED-P0-B |
| R16 | Human UI 断线，另一次真人明确拒绝 | 前者不能代替拒绝；后者才进入修订链 | T20/T23 | DEFERRED-P0-B |
| R17 | 宿主控制信号和普通 Agent 失败同时存在 | 控制信号不被消耗为业务尝试、不直接伪造 `cancelled` | T14/T23 | DEFERRED-P0-B |
| R18 | 无 Agent 纯工作流、Runtime 没有 validateResult/SkillResolver | 必须支持纯流程 `start()` 正常到终点 | T01/T10 | P-PARTIAL |
| R19 | `checkStep` 读取 State，随后 `verify` 读取候选 State | 两次读取符合 Standard 当前真实视图，未通过不合并候选 | T15/T33 | DEFERRED-P0-B |
| R20 | Action 失败后下一 Action 成功，后继读取 contextError | 不应自动清除旧错误；`state.error` 不增加 | T18/T33 | DEFERRED-P0-B |
| R21 | 相同 startKey/业务输入，仅调整阶段预算或日志参数 | 复用相同 Run；改变真正策略/业务输入则拒绝 | T05/T09/T34 | P-PARTIAL |
| R22 | Action `indeterminate` → 新 Reconcile 请求 → still-indeterminate / confirmed-succeeded | 保持原 operationId，不重新调用 execute，最终成功才合法提交 | T17/T32 | DEFERRED-P0-B |

## 4. V0.6-R5 S01–S14 原生验收边界

| ID | 正式可观察不变量 | 设计/阶段 | 当前审计判定 |
|---|---|---|---|
| S01 | 纯 Condition→Terminal 正常成功，缺失布尔输入 → `errored(FK_R002)`，再次 resume revision 不增长 | N1 / P0-A | P-PARTIAL |
| S02 | Agent 默认重试、stepCounter、同一 Pending 重读 ID 稳定；派发/接纳/提交 CAS 前后故障注入 | N3/N11 / P0-A | P-PARTIAL |
| S03 | 纯 validator 稳定异常/非法值 → `errored` 且不消耗 attempt；临时丢绑定明确恢复条件 | N1 / P0-A | P-PARTIAL |
| S04 | 并发同回执仅接纳一次，冲突拒绝；CAS 成功丢响应由 namespace 内线性化读+ledger 识别 | N12 / P0-A | P-PARTIAL |
| S05 | 同 startKey 不同 namespace 各自独立，跨 namespace 访问不泄漏；伪造 PC/非法合法边拒绝且 CP 不变 | N3/N5 / P0-A | P-PARTIAL |
| S06 | 固定产物被替换/策略改变拒绝；SDK 升级能否继续由支持的语义/CP Schema 决定，不能重编译旧源 | N6 / P0-A | P-PARTIAL |
| S07 | JSON 恶意原型、 getter、无效数值、大小超限拒绝；不同阶段预算最终 State 相同 | 序列化 / P0-A | P-PARTIAL |
| S08 | 外部 checkStep 读提交前 State，verify 读候选合并 State；接纳后杀进程不重做已提交阶段 | N2 / P0-B | DEFERRED-P0-B |
| S09 | 外部 Action statePatch 越界拒绝，未知结果只 reconcile 原 operationId，不重发 execute | 副作用 / P0-B | DEFERRED-P0-B |
| S10 | Action 错误跳过相邻 Verification，后续可信 Action 能读取 contextError；最终可信结果投影可见 | N2/N7 / P0-B | DEFERRED-P0-B |
| S11 | Human 来源模型 stdin 伪造拒绝，真实审批通过；Loop 最后失败不再修订，重启不增加轮次 | N4 / P0-B | DEFERRED-P0-B |
| S12 | 管理 cancel 与终态竞争，仅一个 CAS 赢；迟到旧回执不能激活已终态 Run | D2 / P0-A 基础，P0-B 补偿 | GAP-P0-A; DEFERRED-P0-B |
| S13 | 真实宿主的 JS → 当前模型/工具 → JS 日志证据；宿主没有 JS 或审批通道则记 BLOCKED | T27 / Host | N-BLOCKED |
| S14 | 既有 Standard 全量回归；exports 五项、bin 保持一个、TS 5.0 及 Windows/Ubuntu Node 22/24、模式差异表逐项判定 | N8/N10/N13 / 全阶段 | P-PARTIAL |

## 5. V0.6-R5 正文 §§1–18 逐章审查入口


| § | 审查主题 | 必查原始语义 | 当前源码/证据入口 | 初步结论 / 后续动作 |
|---|---|---|---|---|
| §1 | 产品边界 | 已有 Shared Standard 语义与新 Interactive 子路径；不得变成强制 Server/模型网关 | src/interactive/index.mjs; docs/interactive.md | 已初步交叉核对，继续审查根 API 六项/部署边界 |
| §2 | 十四不变量/架构 | Program 唯一控制流、可信 Registry、零 import、同字节加载 | src/compiler/interactive/{emit,validate-ir}.mjs; src/interactive/load.mjs | P0-A 执行路径存在，长期 ABI/恶意字节需补 |
| §3 | 生命周期与 Stage | waiting/paused/finished、独立接纳/Commit 持久屏障 | src/interactive/coordinator.mjs; tests/interactive/crash.test.mjs | 阶段级脚本证据存在，未完成所有切点 |
| §4 | API 与身份 | start/complete/resume/adminTerminate/可信结果读取 | src/interactive/index.mjs; types/interactive.d.ts | CF-01 与 CF-02 高优先级差异 |
| §5 | Program ABI / 类型 | ProgramTable、transition proposal、HostSubmission 判别联合 | types/interactive.d.ts; src/compiler/interactive/emit.mjs | P0-A 可执行子集，完整 §5 类型差异需审 |
| §6 | Registry / retain / upgrade | 不可变 Program、同库 retain、旧 Run 跨版本恢复 | src/interactive/sqlite-store.mjs; tests/interactive/store.test.mjs | 同库脚本证据存在，跨 SDK 版本兼容未验证 |
| §7 | PublicTask/认证事件 | 模型最小披露，Host 专属结果认证、Human 不可伪造 | src/interactive/trusted-host.mjs; tests/interactive/trusted-host.test.mjs | P0-A 公共 Agent 已有，真实 OS 来源不足 |
| §8 | Store/Journal | Genesis/CAS/Receipt/Journal 原子事务 | src/interactive/sqlite-store.mjs; tests/interactive/store.test.mjs | P 级测试多项；掉电/系统跨平台仍需补 |
| §9 | SQLite 参考 schema | 同事务 Program retain/Genesis 与 WAL/FULL | src/interactive/sqlite-store.mjs | 现代码 schema vs §9 全字段待逐条复核 |
| §10 | 节点语义 | 基本 Agent/Condition 与 P0-B Action/Human/Loop、P1/P2 | src/compiler/interactive/feature-gate.mjs | A 子集存在；B/P1/P2 Deferred |
| §11 | 安全与多租户 | 严格 JSON/JCS、OS 用户、Namespace、Host 控制通道 | src/interactive/canonical.mjs; docs/interactive-trusted-host-security-v2-design.md | 真实 Windows 模型越权测试 BLOCKED |
| §12 | 错误分类 | FK_R/ FK_I、非纯校验、基础设施错误边界 | src/interactive/coordinator.mjs; src/interactive/host-attestation.mjs | 已覆盖部分脚本，未穷尽所有正式码 |
| §13 | 资源预算/运维 | 2 MiB、128 stage 候选、Ledger 增长/写放大 | src/interactive/canonical.mjs; tests/interactive/s07-capacity.test.mjs | S07 脚本证据存在，性能/长期运行未知 |
| §14 | Standard/Interactive 差异 | T33 明确有意不等价的字段/行为与端到端对照 | tests/integration/m6-e2e.test.mjs; docs/interactive.md | 只覆盖 A 子集，B 仍延期 |
| §15 | 验收追踪 | T01–34/R01–22/S01–14 来源与阶段 | 本文件 §2–§4 | 编号齐全，逐条实测证据尚未最终核销 |
| §16 | 实施门禁 | P0-A/B/P1/P2 与禁用未实现阶段 | src/compiler/interactive/feature-gate.mjs | P0-A gate 存在；Admin/T27 遗留 |
| §17 | 设计 Finding | R5-01..10 的文档修订与真实验证边界 | R5-INDEPENDENT-CONVERGENCE-REVIEW.md | 候选设计收敛不代表实现验收 |
| §18 | 用户冻结/授权 | 确认技术方案与实施计划，不自动宣布代码发布授权 | 00-APPROVAL-RECORD.md; PR #13/#14 | 2026-11-10 已确认计划，当前 M1–M5 实现已在 main；不应重新规划 |

## 6. 下一轮证据优先级

1. **P1 / CF-01：** 检查 adminTerminate、管理凭据、tombstone 事务与 S12-A 的真实实现；在明确差异和用户确认前不动生产 Core。
2. **P1 / CF-02：** 对照 V0.6 §4/§5 与真实 `./interactive` 导出、TypeScript、packaged consumers；查找是否曾有获批变更记录，不能只看编译是否成功。
3. **N / S13/T27：** 分离真实 Grok 文件 Harness M 层、脚本 Host P 层与真正原生 JS tool-call N 层；补原生来源、OS 安全和审计。
4. **P0-A S12-A：** 与 CF-01 同步；P0-B Human/cancel 不可代替 P0-A 管理终止。
5. **跨平台实测与原型差距：** 保留已有 22/22 PoC、9/9 SIGKILL，补真实 Node/Windows、JCS、Program 升级与 Stage 性能证据。
6. **独立复审：** 当前矩阵先由第二审查者核对源码及原始验收日志；任何新的正式需求/ABI 变更必须单独审批。

## 7. 本轮判定

**R1 为阶段性证据矩阵，不是最终符合性通过。** T01–34、R01–22、S01–14 的原文已逐项抽取并且编号完整。已发现两处需要重点复核的 P0-A 契约差异（受权 adminTerminate 与公共 SDK API 形态），以及原生宿主/系统隔离阻断。P0-B、P1、P2 的合法延期不应误判为 P0-A 缺陷。下一步是在不修改正式契约/生产 Core 的前提下完成差异复现和可验证的审查结果。

---
原件校验：T 34 / R 22 / S 14；SHA-256 分别匹配；生成时间 2026-11-12。