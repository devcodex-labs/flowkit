# FlowKit Interactive — Phase 2 正式契约原件追踪登记

**状态：BLOCKED — 等待用户重新提供正式原件。**  
**登记日期：2026-11-12（UTC+8）**  
**当前 main：** `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`  
**关联设计：** [Trusted Host V2](./interactive-trusted-host-security-v2-design.md) · [完整路线图](./interactive-full-delivery-roadmap-2026-11-11.md)

## 1. 目标原件

| ID | 应取得的正式原件 | 已知历史路径/版本线索 | 当前证据 | 状态 |
|---|---|---|---|---|
| SRC-01 | `FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed.md` | `01-CONFIRMED-REQUIREMENTS/FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed.md`；范围 T01–T34 | 2026-11-10 的 Grok 独立审查报告记载 SHA-256 前缀 `3a0adc3e…6e703e`，但没有原文件字节和完整哈希 | **BLOCKED** |
| SRC-02 | `TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md` | 历史确认的 V0.6-R5 技术设计原件 | P0-A 确认记录和实施计划只引用版本/文件名，没有包含完整技术正文或完整哈希 | **BLOCKED** |
| SRC-03 | `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` | 历史确认交接包 | 当前可检索 Library/Conversation 未找到该文件 | **NOT FOUND** |
| SRC-04 | `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip` | V0.6-R5 最终收敛复审包 | 当前可检索 Library/Conversation 未找到该文件 | **NOT FOUND** |

**重要区分：** Library 中可读的 `FlowKit-Interactive-Design-V0.3-R2-Independent-Review-Grok.md` 是对 **Technical Design Draft V0.3-R2** 的独立审查报告，不是已确认的 V0.6-R5 技术设计原件。该报告还记录了 V0.3-R2 Draft 的 SHA-256 前缀 `92eff8d4…475520f8`，不能把它当成 V0.6-R5。该报告提到的 ZIP 哈希前缀 `8a2f679a…2ee5826` 属于它所审查的历史交接包记录，不能未经原包核对就认定为 SRC-03 或 SRC-04。

## 2. 当前可读取的相关材料（仅二级证据）

| 材料 | 当前可读取位置/标识 | 能证明什么 | 不能替代什么 |
|---|---|---|---|
| Grok V0.3-R2 独立审查报告 | Library：`FlowKit-Interactive-Design-V0.3-R2-Independent-Review-Grok.md` | 证明历史审查报告曾引用 V0.3 Confirmed 需求，并记录其 SHA 前缀、T01–T34 范围 | 不能替代需求正文、完整 SHA 或 V0.6-R5 技术设计 |
| P0-A 确认记录 | Library：`00-APPROVAL-RECORD.md` | 证明用户于 2026-11-10 确认 P0-A 实施计划，并将 Requirements V0.3 / Technical Design V0.6-R5 作为上游基线 | 不是需求或技术设计正文 |
| P0-A 实施计划 | Library：`01-P0A-IMPLEMENTATION-PLAN-V0.1-CONFIRMED.md` | 证明计划层的 M1–M6、31 项文件级工程任务和验收原则 | 计划明确要求需求 V0.3 优先于技术 V0.6-R5；不能用计划反向重建上游契约 |
| Stage 2 PoC 报告 | Library：`STAGE2-POC-REPORT.md` | 证明历史 PoC 以 V0.3/V0.6-R5 为设计基线，并明确 PoC 不是正式验收 | 不能替代正式契约 |
| PR #14 / 当前路线图 | main：`docs/interactive-trusted-host-security-v2-*.md`、本登记 | 证明当前 Trusted Host V2 设计、Finding 和后续阶段记录 | 这些是后续安全设计和摘要，不是 2026-11-10 的原始批准契约 |

## 3. 原件恢复后的验证步骤

收到文件后，按以下顺序执行，不得先改写内容：

1. **字节级固定**：记录原始文件名、文件大小、格式、来源、收到时间和 SHA-256 完整值。
2. **版本/批准状态核验**：确认标题、版本号、CONFIRMED 状态、用户确认记录、日期、变更记录和适用范围。
3. **交接包完整性**：若提供 ZIP，先读取包内文件清单与 `SHA256SUMS.txt`，验证全部条目；再计算 ZIP 本身的 SHA-256。不能只比较前缀。
4. **SRC-01 需求符合性**：按原文逐条提取 T01–T34 的原始措辞、阶段、约束和验收条件；不得以当前路线图同名编号代替。
5. **SRC-02 技术符合性**：逐条核对 V0.6-R5 的 API、ABI、Program、Checkpoint、Store、Coordinator、Host、安全边界、错误语义和平台要求。
6. **交叉追踪**：把原文条款映射到当前 main、PR #14 合并后的 Trusted Host 设计、M1–M6、T/S/C/TH/SEC/NAT 台账；记录 PASS、GAP、CONFLICT、NOT-IMPLEMENTED、OUT-OF-SCOPE。
7. **独立复审**：对所有差异给出源码/原文证据链；不得自动修改正式需求或技术设计。需要修订时，先提出差异和建议，等待用户确认。
8. **收口裁决**：只有原件完整、SHA 验证通过、逐条符合性矩阵完成并通过独立复审，才可将 F-07 和 Phase 2 正式契约符合性改为 PASS。

## 4. 对阶段的影响

- PR #14 已合并，代表 Trusted Host V2 **安全设计记录已入库**；不代表其与正式 V0.3/V0.6-R5 的符合性已证明。
- F-01 与 F-R2-01 已在设计文档层面关闭。
- F-02（Grok 原生工具绑定）和 F-04（Windows 跨账户/继承句柄隔离）仍需各自 PoC/OS 实测。
- F-07 保持 **BLOCKED**。在本项目既定执行顺序中，先恢复并核验 SRC-01/SRC-02，再正式收口 Phase 2；**本登记未授权开始 Phase 3**。
- 不得因为原件缺失而重写一份“新版 V0.3”或“新版 V0.6-R5”并冒充历史批准版本。

## 5. 需要用户重新提供的文件

请重新上传以下文件（至少前两份原始 Markdown）：

1. `FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed.md`
2. `TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md`)
3. 如方便，上传 `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` 及其原始 `SHA256SUMS.txt`)
4. 如方便，上传 `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip`)

若上传 ZIP，请保留原始包，不要重新压缩或修改文件后再提供，以免改变 SHA-256。

---

**当前结论：** SRC-01 至 SRC-04 尚无可验证原始字节；当前相关报告、审批记录、实施计划和 PoC 报告仅作为二级线索保存。Phase 2 正式契约符合性维持 **BLOCKED**。
