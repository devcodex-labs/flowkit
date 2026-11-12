# G01 — P0-A 正式契约审查

**审查已执行；符合性未通过，待独立复审。** 已完整读取三份确认原件，逐项核对 [追踪表](./traceability.md) 中的 34 T / 22 R / 14 S / 31 计划任务及下文 §§1–18。结论是发现明确缺口、契约差异和未证明的场景。此阶段只交证据，没有修改 Core、ABI、Store、SDK 或 Standard，也没有进入 G04。

审查基线：`21b02e785cacf703c359d7d4f853b8196aa17b19`，树 `3beb2ef618d1061b184ddb774512c4d827783db7`，与合并 [G02 PR #21](https://github.com/devcodex-labs/flowkit/pull/21) 后的 main `5a82a88160e01b0e9e2e457dea6af1e3db2c54e0` 同树。[Draft PR #22](https://github.com/devcodex-labs/flowkit/pull/22) 是唯一交付 PR。[基线 Actions 43233955173](https://github.com/devcodex-labs/flowkit/actions/runs/43233955173) 七项成功；本机 Windows / Node 24.22.2，`npm ci` 与 `npm run verify` 均退出 0，395/395、0 跳过。CF-08 另行复现，结果见下。独立复审包有原始 stdout/stderr、真实命令、SHA-256 和精确增量 diff；新证据提交的 CI 状态在独立清单中记录。

| 冻结原件（实际读完） | 字节 | SHA-256 | 取证来源 |
|---|---:|---|---|
| Requirements V0.3 | 56883 | `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e` | 本地 Grok 交接 ZIP 原始条目，与冻结登记一致 |
| Technical Design V0.6-R5 | 114621 | `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba` | 本地 R5 确认交接 ZIP 原始条目，与冻结登记一致 |
| P0-A Plan V0.1 | 42988 | `0ac8719f204aae274e64abc30d02caa637fc55a5f1751a6884341f05117e02c0` | ChatGPT Library 原始下载，与冻结登记一致 |

校验采用原始文件字节（未重编码）。范围 V0.3 全 710 行、R5 全 1128 行、计划全 319 行。R5 §18 将技术冻结与实施授权区分；计划的确认页和已确认交接决定给出 V0.1 实施范围。计划 §14 尾句留有“待用户确认”的旧措辞，保留原样；此处依据确认页、后续交接与用户本轮指示执行 G01/G03。R1/R2 仅作历史问题索引，审查结论直接取自原件和固定代码。下表的 D 是 `types/interactive.d.ts`。

| 发现 | 严重度 / 裁决 | 原件 → 当前行为 → 最小验证/修复候选（未执行） |
|---|---|---|
| CF-01 | P1，确认 P0-A 缺口 | R5 §§1.1/3.6/4–5/16、计划 A-M5-02/04/S12-A 要求独立受权 `adminTerminate`、无可用 Program 时仍能管理、原子墓碑和审计。公开入口、Coordinator/Trusted Host、类型中均无此能力；`src/interactive/index.mjs:2`、`coordinator.mjs:220/659`、`types/interactive.d.ts:183/254`。候选：独立管理凭据与单事务 CAS；验无 Program、普通模型输入拒绝、业务终态竞态及旧回执不能恢复运行。P0-B 的业务 cancel 不替代它。 |
| CF-02 | P1，DESIGN-QUESTION（确认差异，待裁决） | V0.3 §7.1 是示意；R5 §4 指向 §5 唯一规范签名、计划 A-M4-05 要求顶层 `start/complete/resume`。现为 `createInteractiveCoordinator`/`createTrustedInteractiveHost` 实例方法，签名也不同（入口第 2 行、D:161/183/254）。实际能力存在，未查得已批准用 factory 替代冻结顶层接口。先确认获批记录或向后兼容路径，再以发布包 ESM/TS 消费者验证；不直接加别名或撤旧接口。 |
| CF-05 | P1，确认 P0-A 投影缺口 | R5 §§4–5/7/11/16 与 A-M5-01 要求公开 Frame 用 `resultRef` 等有限信息，完整 State 走单独 `result:read` 可信读取。当前终态 `asPublicFrame` 包含 State（`coordinator.mjs:144`、D:83），受信 Host start/resume/load 转发（`trusted-host.mjs:147/159/163`）；`getPublicAgentTask` 有授权和字段限制（:175、测试 :99/117）。证实 SDK 角色未分离，未证真实模型泄漏。候选：拆分公开投影和受权读取；分别验证私密数据不会随模型/stdout 发送、跨租户和错误角色拒绝、合法读取成功。 |
| CF-06 | P1，DESIGN-QUESTION（确认差异，待裁决） | R5 §§5/8.1 冻结五个 Promise 操作 `createIfAbsent/load/compareAndSwap/loadTransition/loadReceipt` 与独立 Registry；§13.2 允许 SQLite 内部 DatabaseSync。当前 D:106、`coordinator.mjs:220/247/332`、`sqlite-store.mjs:290/340` 是同步 Store+Registry，冻结五操作单独提供时不能接入。现有 SQLite 原子测试有效。先找授权的差异或评审适配方案；适配必须保住原子 CAS、Receipt/Journal、历史查询和丢 ACK 后线性化判断，另验非线性化读不会导致派发。 |
| CF-08 | P2，基线实测复现 | R5 R04、计划 A-M1-02/A-M2-02 的稳定快照/阶段门禁。 `compile.mjs:37–44` 首次 await 后重新读取原 `options.featureStage`。`probe-cf08.mjs`：稳定 P0-A 编译 7,634 B；调用后改原选项到 P0-B，产物 0 B，`FK_I_UNSUPPORTED_GRAPH`。探针退出 0 表示成功复现问题；没有绕过阶段门禁。候选：统一使用已校验快照，再用同一负例保证产物与对照一致。 |
| ABI-01 | DESIGN-QUESTION，静态差异 | R5 §§3/5/8 的 transitionId 使用规范化事件/Program/Proposal；`coordinator.mjs:29` 实际以 namespace/run/revision/block/kind 构造带前缀 ID。:54/92 检查当前 Block 与部分 Proposal 字段，并不能据测试证明冻结判别联合所有未知键/非法字段都拒绝。D:83/93 的 Frame/Pending 形态也不同。先独立确认已持久历史、支持版本及升级风险；不改计算、字段或 schema。 |

CF-07（与 CF-08 分开）由 `606d055d5f02451fea0b30294889d740ef370d49` 修复，基线 `coordinator.test.mjs:407/421` 两项通过。CF-03 仍缺原生 Grok 可验证来源与真实 Host/Model 隔离；G03 仅能力 PoC。CF-04 维持已批准范围：Action/Human/Loop/业务 cancel 属 P0-B、Parallel all_succeeded 属 P1、any 留待 P2 专项裁决。

## V0.6-R5 §§1–18 正文审查

| § / 原件起始行 | 对照和裁决 |
|---|---|
| 1 / 27 | 产品链路仍为用户意图→可执行 JS→程序控制 Agent。G02 已合并有实际 JS/Pending，根入口 `src/index.mjs` 及包契约不扩张；本次不重跑 G02。Standard 与 Interactive 分层，无必需 FlowKit 服务。 |
| 2 / 60 | `compile.mjs:37`、`src/compiler/interactive/{lower,validate-ir,emit}.mjs` 与 `load.mjs:54` 落地 Standard 前端复用、真实 JS、同字节加载；程序决策和宿主持久化分离。ABI-01 留审。 |
| 3 / 142 | `coordinator.mjs:332/451/567/659`、crash 测试证明主要阶段/接纳屏障和无空 waiting；全故障矩阵 T29 部分，独立管理终止 CF-01。 |
| 4 / 226 | 实际子路径与公开 SDK/权限/可信读取对应 CF-01/02/05；R5 §5 是唯一规范声明，不能以 V0.3 示意代替。 |
| 5 / 264 | `types/interactive.d.ts:83/93/106/161/183/254` 和 `coordinator.mjs:29/92`：可执行 A 子集、显式形态差异 CF-02/05/06、ABI-01；未批准改 ABI。 |
| 6 / 509 | `sqlite-store.mjs:139/150/163/178` 的不可变字节、引用 FK、`coordinator.mjs:247` 固定旧 Program；m6:340 和 cache 测试成立，跨 SDK/CP 升级未实测。 |
| 7 / 547 | `trusted-host.mjs:175/221` 最小任务、可信回执可测；CF-05，Human 通道延期；实际模型和 Host 权限隔离未证。 |
| 8 / 592 | `sqlite-store.mjs:290/340` Genesis/CAS 和历史回执；R03/R11 仍缺、CF-06 的外部五操作未符合。 |
| 9 / 628 | 当前 SQL `sqlite-store.mjs:75/92–130/196/212/290/340` 对比 §9：WAL/FULL/外键、本地事务和 Journal/Receipt 索引有实测；实际四张 `fk_i_*` 表以 run→artifact FK 保留 Program，与参考 retain 结构不同；admin/outbox/墓碑与更广保留策略未证明。物理名字差异不单独判失败；不做迁移。 |
| 10 / 710 | 已落地 Condition/Terminal/基础 Agent；`feature-gate.mjs` 阻止提前扩张，P0-B/P1/P2 依原件。 |
| 11 / 787 | `canonical.mjs:34/111/115`、`trusted-host.mjs:175/221` 和 SQLite namespace，P 级测试通过；跨语言 JCS/完整文本重复键边界、目标 Grok 账户/ACL 及原生来源未证明。 |
| 12 / 820 | 基础错误已实测（FK_R002/FK_R004/容量/权限），运行期 `FK_I_INVALID_CHECKPOINT` 等实际分类与冻结词表须逐项核销；不扩大固定 Standard 61 码。 |
| 13 / 866 | 容量、预算、历史回执有界缓存已测，R12 长期样本缺；JS 不可用时真实拒绝记录缺（T11），G03 文件入口不能等同 FlowKit 2 MiB 安全验收。 |
| 14 / 901 | m6:171/250/293/365 证明 A 子集、状态与预算的对照。JSON 边界/缺失与 null 区别是已登记差异；B/P1/P2 不推断。 |
| 15 / 924 | 追踪表覆盖全部 T/R/S；原件的「未执行」是设计时状态，本轮证据逐项分级。 |
| 16 / 1030 | P0-A 与后续阶段区分；管理终止、可信读取、宿主能力是缺口或阻断，不能提前宣称 M5/M6 合格。 |
| 17 / 1084 | R5-01–10 是设计裁决，测试仅覆盖具体断言；远端 Store/升级/运维/宿主来源按剩余门禁处理。 |
| 18 / 1118 | 冻结授权与实施授权独立；依据本轮授权只做 G01/G03、同一个 Draft PR，停于独立复审。 |

**退出状态：提交审查记录，冻结契约符合性未通过。** G04 依赖独立复审与对争议契约的裁决；T11、T27/S13 原生可信宿主、R03/R11/R12、跨版本、部分故障与完整 ABI/诊断仍待对应证据。证据等级：P 是现有流程运行，M 是真实模型实际消费 FlowKit Pending，T 是受保护观察链，N 是原生端到端可信验收，V 是可独立验证的 provider 证明；本次 G01 不产生新的 M/T/N/V。
