# G01 — 冻结原件追踪表

审查对象 `21b02e785cacf703c359d7d4f853b8196aa17b19`。原件位置见下表；测试位置以审查对象为准。下面的路径缩写：**I/** = `src/interactive/`，**CI/** = `src/compiler/interactive/`，**t/** = `tests/interactive/`（测试名默认后缀 `.test.mjs`），**m6** = `tests/integration/m6-e2e.test.mjs`，**D** = `types/interactive.d.ts`。冒号后是起始行。

**P** = 基线实际运行的程序/Store/脚本 Host 覆盖所述子例；**P 部分** = 有运行证据但缺完整断言、切点、阶段或适配器；**静态** = 源码/设计证据；**缺口** = P0-A 应交付但当前不存在或不符合；**待裁决** = 存在接口或语义冲突，未找到获批替代契约；**延期** = 冻结范围明确排除本阶段；**BLOCKED** = 缺真实运行、前置权限或专项决策。所有测试引用结合 `npm-verify.stdout` 使用；相邻的设计断言未因此变成 PASS。

## T01–T34

需求 V0.3 §16 第 598–631 行，技术 V0.6-R5 §15.1 第 932–965 行；两列不完全等价的，以各原件的断言为准。

| ID | V0.3 / R5 行 | 结果与证据 |
|---|---|---|
| T01 | 598 / 932 | P：生成 JS 路由、各阶段持久化、无 Agent 终点及缺布尔路径，t/emitter:51、t/coordinator:75/90/115/122、m6:250/293/365。 |
| T02 | 599 / 933 | P：Pending 持久和 Agent 指令、Schema、缺失及 attempt 子例，I/coordinator.mjs:153/391、t/coordinator:90、t/trusted-host:314、m6:201。 |
| T03 | 600 / 934 | P 部分：发布后重启并接纳、接纳后不重新派发，t/crash:89/118、m6:201/234；全切点见 T29。 |
| T04 | 601 / 935 | P：非法输出/异常 validator/缺绑定不提交候选，t/coordinator:170/197/283/353/365；非纯外部验证延期。 |
| T05 | 602 / 936 | P：错误 node/attempt/requestId、跨租户 runId 拒绝；startKey 冲突和命名空间隔离，t/coordinator:151/231/313、t/store:107、t/trusted-host:357。 |
| T06 | 603 / 937 | P：旧同回执保留首次接受 revision、最新 Frame、不同内容拒绝，t/coordinator:137/151/297/376、t/crash:152。 |
| T07 | 604 / 938 | P 部分：身份/字节/策略/非法边子例，I/load.mjs:54、t/emitter:103、t/ir:62、t/coordinator:244、m6:279/306/340；跨 SDK 版本未实测。 |
| T08 | 605 / 939 | P：非法值/循环/accessor/Proxy/上限拒绝、own-key 数据与输入快照，t/store:40/50、t/coordinator:324/407/421、t/s07-capacity:89/419。 |
| T09 | 606 / 940 | P 部分：真实 SQLite 双进程和丢 ACK，t/store:196、t/crash:152、t/coordinator:376；未覆盖不合规 Store 的陈旧读（R03/R11）。 |
| T10 | 607 / 941 | P：Standard 合法而 A 禁用的节点和绑定拒绝；纯流程可运行，t/compiler-front:38/57/67/79/89、t/coordinator:283；另有 CF-08。 |
| T11 | 608 / 942 | BLOCKED：没有无 JS 平台上的实际 Host 拒绝记录；文档要求不冒充可执行。 |
| T12 | 609 / 943 | P：`npm run verify` 的 Standard/AOT、类型、打包和固定契约；package.json、tests/contracts.test.mjs、基线 Actions 43233955173。 |
| T13 | 610 / 944 | P：Agent attempt、reasons、State 不变，t/coordinator:170；高级验证 P0-B。 |
| T14 | 611 / 945 | P 部分：合法失败和耗尽 FK_R004，t/coordinator:170/213；控制信号与失败并发仍是 R17。 |
| T15 | 612 / 946 | 延期 P0-B：高级 Agent 验证顺序与候选 State；t/compiler-front:57、t/coordinator:283 证明 A 不会静默忽略。 |
| T16 | 613 / 947 | 延期 P0-B：Action 写集合、提交和外部效果；t/compiler-front:38。 |
| T17 | 614 / 948 | 延期 P0-B：Action 对账；R5 §10.3。 |
| T18 | 615 / 949 | 延期 P0-B：Action 错误与跳过 Verification；R5 §10.3/14。 |
| T19 | 616 / 950 | 延期 P0-B：独立/Loop Verification；t/compiler-front:38。 |
| T20 | 617 / 951 | 延期 P0-B：可信 Human/修订；R5 §10.5。 |
| T21 | 618 / 952 | 延期 P0-B：Loop 边界；R5 §10.6。 |
| T22 | 619 / 953 | 完整 Skill 失败/重试矩阵延期 P0-B；P0-A 旧 Pending 与 Skill/Program 身份子例，m6:201/340。 |
| T23 | 620 / 954 | 业务 cancel、补偿和控制信号延期 P0-B；计划 T23-A 管理终止是独立 P0-A 缺口（CF-01）。 |
| T24 | 621 / 955 | 延期 P1：Parallel all_succeeded；R5 §10.7。 |
| T25 | 622 / 956 | BLOCKED（P2 专项决策）：any 与迟到结果未冻结；V0.3 §15、R5 §10.7/16。 |
| T26 | 623 / 957 | 延期 P1：多 Pending/写集合并发冲突；R5 §10.7。 |
| T27 | 624 / 958 | P：m6:171/328；M：已合并 G02 的 ChatGPT Pending 证据。原生 Grok T/N/V BLOCKED；同 PR G03 只证实合成 MCP 能力。 |
| T28 | 625 / 959 | P 部分：五导出和包/类型/文档回归、此矩阵；CF-02/05/06 说明版本/接口并未全面对齐。 |
| T29 | 626 / 960 | P 部分：t/crash:89/118/152、m6:201/234，覆盖已列的 Agent 前后切点；未证 SQLite 内核/掉电、任意切点或 P0-B。 |
| T30 | 627 / 961 | P 部分：程序/Checkpoint/签名/非法边负例 t/emitter:103、t/ir:62、t/store:226、t/trusted-host:147/357；完整运行时 Proposal 判别及 OS 隔离未证。 |
| T31 | 628 / 962 | P 部分：纯 validator 失败、双进程仅接纳一次 t/coordinator:197/365、t/crash:152；不会宣称可检测任意副作用或 exactly-once。 |
| T32 | 629 / 963 | 延期 P0-B：不支持幂等的外部 Action 的未知状态；R5 §10.3。 |
| T33 | 630 / 964 | P 部分：Standard/Interactive A 子集对照 m6:171/293/365、t/emitter:51；Human、Loop、Action 路线延期。 |
| T34 | 631 / 965 | P 部分：容量、暂停恢复、PublicTask 最小字段 t/s07-capacity:89/165/407/419、m6:250/328、t/trusted-host:99；长期压力、正式结果投影和原生隔离未证。 |

## R01–R22

技术 V0.6-R5 §15.2 第 975–986、992–1001 行。

| ID | R5 行 | 结果与证据 |
|---|---:|---|
| R01 | 975 | P：接纳后、校验前 kill 并恢复候选，t/crash:118。 |
| R02 | 976 | P 部分：晚到重复保留原 acceptedRevision、返回最新 Frame，t/coordinator:137、t/s07-capacity:165/193；独立核查精确 revision+5 场景。 |
| R03 | 977 | P 部分：丢 ACK 恢复 t/coordinator:376；未证非线性化适配器返回陈旧读会被安全拦截（CF-06）。 |
| R04 | 978 | P：State/startIntent 在 await 前快照，t/coordinator:407/421；编译 options 的 CF-08 是另一个入口。 |
| R05 | 979 | P 部分：throw/undefined、稀疏非法数组，t/coordinator:197/365；数字返回同类型路径，但这两项不等于数字子例有独立记录。 |
| R06 | 980 | 静态：纯声明契约（R5 §10.1），不得推断可拦截副作用；现有纯校验拒绝 t/coordinator:197，外部验证器延期。 |
| R07 | 981 | 延期 P0-B：Action/Verification/contextError；R5 §10.3/14。 |
| R08 | 982 | P：received 恢复不重新发同一请求或空 waiting，t/crash:118、t/coordinator:258。 |
| R09 | 983 | P：同命名空间冲突、不同租户分隔，t/store:107、t/coordinator:231/313。 |
| R10 | 984 | P：相同经验证字节才执行、篡改拒绝，I/load.mjs:54、t/emitter:103、m6:306/340；不等于任意可信 Registry 管理策略已验证。 |
| R11 | 985 | P 部分：晚到回执和丢 ACK 分别实测，t/coordinator:137/376；未证与并发多个中间提交同时发生的完整组合。 |
| R12 | 986 | P 部分：21 条 receipt 后的有界 Checkpoint 和旧 Ack，t/s07-capacity:165/193；≥2000 条/WAL 写放大没有测量。 |
| R13 | 992 | P 部分：稳定 IR/缺阶段拒绝 t/ir:23/62；`await` 与 `awaiting` 精确混合负例未单列。 |
| R14 | 993 | P 部分：编译 IR 错边 t/ir:62、产物不符 t/emitter:103；I/coordinator.mjs:54/92 校验当前 Block/部分字段，完整运行时 Proposal 非法并集未证。 |
| R15 | 994 | 延期 P0-B：Verification 执行错误 vs false；R5 §10.4。 |
| R16 | 995 | 延期 P0-B：断线不是 Human 拒绝；R5 §10.5。 |
| R17 | 996 | P 部分：普通调用失败重试 t/coordinator:213；控制信号与失败同时出现的完整场景未执行，业务取消为 B。 |
| R18 | 997 | P：无 Agent 无需校验器或解析器，t/compiler-front:89、t/coordinator:75。 |
| R19 | 998 | 延期 P0-B：checkStep/verify 视图；R5 §10.1/14。 |
| R20 | 999 | 延期 P0-B：contextError 后继语义；R5 §10.3/14。 |
| R21 | 1000 | P 部分：业务漂移/同 key、预算独立最终状态 t/coordinator:231/258、m6:250/279；变日志选项的完整组合未证明。 |
| R22 | 1001 | 延期 P0-B：同 operationId 的未知/确认对账；R5 §10.3。 |

## S01–S14

技术 V0.6-R5 §15.3 第 1007–1020 行。这里的 S 场景编号与 P/M/T/N/V 证据等级无关。

| ID | R5 行 | 结果与证据 |
|---|---:|---|
| S01 | 1007 | P：t/coordinator:75/122、m6:365，纯终点/缺输入和终态稳定。 |
| S02 | 1008 | P 部分：t/coordinator:90/170、t/crash:89/118、m6:201；未涵盖底层 SQLite 掉电。 |
| S03 | 1009 | P 部分：t/coordinator:197/283/365；暂缺绑定后再挂载的恢复协议没有完整证明。 |
| S04 | 1010 | P 部分：t/crash:152、t/coordinator:137/151/376，适用于 SQLite/现有 API；外部 Store 接缝 CF-06。 |
| S05 | 1011 | P 部分：t/store:107/226、t/ir:62、t/coordinator:313、t/trusted-host:357；完整伪造 PC/合法边错组合及真实隔离未证。 |
| S06 | 1012 | P 部分：t/store:82/241、t/stage2-program-cache:76、m6:340；跨 SDK/CP Schema 矩阵未执行。 |
| S07 | 1013 | P：t/store:40/50、t/s07-capacity:89/109/165/419、m6:250 与 tests/integration/m6-ledger-boundary.test.mjs:28；限额和预算结论限定于现有 P 测试，不推及真实模型安全边界。 |
| S08 | 1014 | 延期 P0-B：高级验证读视图/进程恢复；R5 §10.1/14。 |
| S09 | 1015 | 延期 P0-B：Action Patch 与 reconcile；R5 §10.3。 |
| S10 | 1016 | 延期 P0-B：Action 错误路线；P0-A 的可信结果读取另见 CF-05。 |
| S11 | 1017 | 延期 P0-B：Human 真审批与 Loop 最终修复边界；R5 §10.5/10.6。 |
| S12 | 1018 | P0-A 管理终止缺口（CF-01、计划 S12-A）；P0-B 业务补偿延期。 |
| S13 | 1019 | P/M 已有，原生 Grok T/N/V BLOCKED；m6:171、G02 #21、同 PR G03。 |
| S14 | 1020 | P 部分：基线本地和 CI 四矩阵、包和类型；T33 完整分期及新提交 CI 分开记录。 |

## A-M1-01–A-M6-06（31 项）

计划 V0.1 §§4–9（原件行号如下）。计划中建议的文件名不是唯一判定标准；有同等功能时定位实际实现，缺失功能另列。

| 任务 | V0.1 行 | 当前文件 / 可观察证据与残余 |
|---|---:|---|
| A-M1-01 | 114 | P：I/compile.mjs:37/41 调用现有 src/compiler/analyze.mjs，t/compiler-front:17/79，真实 JS/TS 与 Standard 诊断。 |
| A-M1-02 | 115 | P 部分：CI/feature-gate.mjs、t/compiler-front:38/57/67/89；CF-08 是 options 快照差异。 |
| A-M1-03 | 116 | P：CI/lower.mjs、t/ir:23/54/91、t/coordinator:122，稳定图/源身份和缺布尔。 |
| A-M1-04 | 117 | P 部分：CI/validate-ir.mjs、t/ir:62；运行时 Proposal 全量判别另审。 |
| A-M1-05 | 118 | P：t/compiler-front:17/79、t/ir:23/62/100 及本地 Standard 回归。 |
| A-M2-01 | 130 | P：CI/emit.mjs、t/emitter:35/51/75/119，零 import、字节稳定、真实分支。 |
| A-M2-02 | 131 | P 部分：I/compile.mjs、CI/feature-gate.mjs、t/emitter:119、t/compiler-front:79；CF-08，诊断全部字段未逐项核销。 |
| A-M2-03 | 132 | P：实际是 I/load.mjs:54；t/emitter:103、t/stage2-program-cache:76、m6:306。 |
| A-M2-04 | 133 | 待裁决：I/coordinator.mjs:29/47/54/92/117、t/ir:62；完整运行时 unknown keys、transitionId 和 ABI 形态待确认。 |
| A-M2-05 | 134 | P 部分：t/emitter:35/51/75/103、t/coordinator:122；完整字面转义向量未逐项核销。 |
| A-M3-01 | 146 | P 部分：I/canonical.mjs:34/111/115、I/sqlite-store.mjs:139、t/store:40/50/82；重复 JSON 文本键/JCS 互操作和五操作外部 Store 尚未证明。 |
| A-M3-02 | 147 | P 部分：I/sqlite-store.mjs:75/92/196/290/340、t/store:130/167/196/241；R5 DDL、冻结接口 CF-06 待裁决。 |
| A-M3-03 | 148 | P 部分：I/sqlite-store.mjs:92/150/163/178/290、t/store:82、t/coordinator:244；同库 FK retain 实际有效，V1/V2 共存/迁移未证。 |
| A-M3-04 | 149 | P 部分：t/store:40/50/82/107/130/167、t/coordinator:137/376；R03/R11 的组合场景仍缺。 |
| A-M3-05 | 150 | P 部分：t/crash:89/118/152；应用进程故障和事务异常有测试，SQLite 内部掉电未测。 |
| A-M4-01 | 164 | P 部分：I/coordinator.mjs:451/534/567/659、t/coordinator:75/90/122/258；§5 运行时 shape 仍有差异。 |
| A-M4-02 | 165 | P 部分：I/coordinator.mjs:174/247/534、t/coordinator:231/283、t/stage2-integration:141/173；日志参数完整组合 R21 未执行。 |
| A-M4-03 | 166 | P：I/coordinator.mjs:153/391/419、t/coordinator:90/170/197/324、t/trusted-host:314；高级验证为 B。 |
| A-M4-04 | 167 | P 部分：I/coordinator.mjs:567、t/coordinator:137/151/376、t/crash:118；外部 Store 语义 CF-06。 |
| A-M4-05 | 168 | 待裁决（CF-02）：I/index.mjs:2、D:161、package.json；根入口保持，子路径可消费，冻结顶层签名缺失。 |
| A-M4-06 | 169 | P 部分：t/coordinator:170/197/231/258/297、t/crash:89/118/152；不是所有主机/故障切点。 |
| A-M5-01 | 190 | 缺口（CF-05）：I/trusted-host.mjs:175 和 t/trusted-host:99/117 证明 PublicTask；I/coordinator.mjs:144、D:83 仍把完整终态 State 放进 SDK Frame。 |
| A-M5-02 | 191 | 缺口（CF-01）：I/index.mjs:2、I/coordinator.mjs:220、D:183 无独立 Admin Controller/凭据/墓碑事务。 |
| A-M5-03 | 192 | P 部分：m6:171/328、tests/integration/m6-host.mjs 短进程实验；未证生产主机完整授权或无 JS 主机。 |
| A-M5-04 | 193 | P 部分：t/trusted-host:99/117/147/291/357、t/coordinator:313；管理端和目标 Grok OS 证据仍缺。 |
| A-M6-01 | 207 | P：package.json、scripts/package-files.mjs、scripts/check-package.mjs、tests/contracts.test.mjs；verify 有契约和包证据。 |
| A-M6-02 | 208 | P 部分：tests/types/interactive.ts 在仓库内直接检查声明，tests/package/consumer.mjs 实测已安装 tarball 的 Interactive ESM；现有 TS tarball 消费者没有直接 import Interactive，仍缺该子路径的已安装 TS 最低版本正负例。CF-02/05/06 仍影响冻结声明。 |
| A-M6-03 | 209 | P：package.json、.github/workflows/ci.yml、基线 Actions 43233955173，四矩阵加安全/文档检查与本地 verify。 |
| A-M6-04 | 210 | P 部分：t/crash:89/118/152、t/coordinator:244/376、m6:201/234/306/340；完整存储故障矩阵未关闭。 |
| A-M6-05 | 211 | P 部分：docs/interactive.md、docs/interactive-host-security.md、m6:171/328；NAT-14、安全宿主及完整差异仍开放。 |
| A-M6-06 | 212 | P 部分：m6:250、t/s07-capacity:165/193 与计划容量断言；无 ≥2000 阶段/WAL 写放大、延迟分位或跨平台性能原始样本。 |
