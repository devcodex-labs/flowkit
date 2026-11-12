# FlowKit Interactive — Phase 2 正式契约原件追踪登记

**状态：部分恢复 — SRC-01 已取得并完成 SHA-256/包内清单验证；SRC-02（V0.6-R5 技术设计原件）仍 BLOCKED。**  
**登记日期：2026-11-12（UTC+8）**  
**当前 main：** `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`  
**关联设计：** [Trusted Host V2](./interactive-trusted-host-security-v2-design.md) · [完整路线图](./interactive-full-delivery-roadmap-2026-11-11.md)

## 1. 目标原件

| ID | 应取得的正式原件 | 已知历史路径/版本线索 | 当前证据 | 状态 |
|---|---|---|---|---|
| SRC-01 | `FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed.md` | 用户上传的 `FlowKit-Interactive-Development-Handoff-For-Grok-2026-11-10(2).zip` 内部 `01-CONFIRMED-REQUIREMENTS/`；范围 T01–T34 | 已取得原文件 56,883 bytes；SHA-256 `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e`；与 MANIFEST、SHA256SUMS 和历史审查报告前缀一致 | **VERIFIED** |
| SRC-02 | `TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md` | 目标为历史确认的 V0.6-R5 技术设计原件 | 本次上传的 2026-11-10 交接 ZIP 不含此文件；只含 `FlowKit-Interactive-Technical-Design-Draft-V0.3-R2.md`（103,479 bytes，SHA-256 `92eff8d490213ac74f542639df0b7deaf459457d1553f3e78a2d7d6a475520f8`），MANIFEST 明确标记技术设计为 Draft V0.3-R2 / not yet confirmed | **BLOCKED** |
| SRC-03 | `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` | 历史确认的 V0.6-R5 交接包 | 本次上传的是不同名称的 `FlowKit-Interactive-Development-Handoff-For-Grok-2026-11-10(2).zip`；其 SHA-256 为 `8a2f679a796234383b5108d58db16c1016a35c6110301bc4eb7e091ee2ed5826`，与历史审查报告记录的 ZIP 哈希前缀/后缀吻合，但包内 MANIFEST 证明它是 V0.3 requirements + V0.3-R2 technical draft 的审查交接包，不是 V0.6-R5 Confirmed Handoff | **NOT FOUND（已排除误认）** |
| SRC-04 | `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip` | V0.6-R5 最终收敛复审包 | 本次三个上传附件均未包含该文件或等价的原始归档 | **NOT FOUND** |

**重要区分与已完成验证：** 用户单独上传的 `FlowKit-Interactive-Design-V0.3-R2-Independent-Review-Grok(1).md`（55,392 bytes，SHA-256 `7efca5840151e3a1851b4fb590ec11780f56f53da691a02d770871cdf477646f`）是对 **Technical Design Draft V0.3-R2** 的独立审查报告，不是 V0.6-R5 技术设计原件。它记录的需求 SHA 前缀 `3a0adc3e…6e703e` 已由本次 ZIP 中的真实 V0.3 文件完整验证；Draft V0.3-R2 的 SHA-256 为 `92eff8d4…475520f8`。上传 ZIP 的完整 SHA-256 `8a2f679a796234383b5108d58db16c1016a35c6110301bc4eb7e091ee2ed5826` 也与报告所记 ZIP 前缀/后缀吻合。该 ZIP 内 MANIFEST 的 `technical_design_status` 明确为 `Draft V0.3-R2, not yet confirmed`，因此不能把它当作 V0.6-R5。

## 2. 当前可读取的相关材料（仅二级证据）

| 材料 | 当前可读取位置/标识 | 能证明什么 | 不能替代什么 |
|---|---|---|---|
| Grok V0.3-R2 独立审查报告 | 用户上传的同名 Markdown；另有 Library 副本 | 证明历史审查报告曾引用 V0.3 Confirmed 需求，并记录其 SHA 前缀、T01–T34 范围；本次已用原件核验完整需求 SHA | 不能替代 V0.6-R5 技术设计 |
| P0-A 确认记录 | Library：`00-APPROVAL-RECORD.md` | 证明用户于 2026-11-10 确认 P0-A 实施计划，并将 Requirements V0.3 / Technical Design V0.6-R5 作为上游基线 | 不是需求或技术设计正文 |
| P0-A 实施计划 | Library：`01-P0A-IMPLEMENTATION-PLAN-V0.1-CONFIRMED.md` | 证明计划层的 M1–M6、31 项文件级工程任务和验收原则 | 计划明确要求需求 V0.3 优先于技术 V0.6-R5；不能用计划反向重建上游契约 |
| Stage 2 PoC 报告 | Library：`STAGE2-POC-REPORT.md` | 证明历史 PoC 以 V0.3/V0.6-R5 为设计基线，并明确 PoC 不是正式验收 | 不能替代正式契约 |
| PR #14 / 当前路线图 | main：`docs/interactive-trusted-host-security-v2-*.md`、本登记 | 证明当前 Trusted Host V2 设计、Finding 和后续阶段记录 | 这些是后续安全设计和摘要，不是 2026-11-10 的原始批准契约 |

## 3. 原件恢复后的验证步骤

SRC-01 已完成字节级与包内完整性验证。剩余原件恢复后，按以下顺序执行，不得先改写内容：

1. **字节级固定**：记录原始文件名、文件大小、格式、来源、收到时间和 SHA-256 完整值。
2. **版本/批准状态核验**：确认标题、版本号、CONFIRMED 状态、用户确认记录、日期、变更记录和适用范围。
3. **交接包完整性**：若提供 ZIP，先读取包内文件清单与 `SHA256SUMS.txt`，验证全部条目；再计算 ZIP 本身的 SHA-256。不能只比较前缀。
4. **SRC-01 需求符合性**：已取得正式原文；下一步按原文逐条提取 T01–T34 的原始措辞、阶段、约束和验收条件，并对照当前 main。不得以当前路线图同名编号代替。
5. **SRC-02 技术符合性**：逐条核对 V0.6-R5 的 API、ABI、Program、Checkpoint、Store、Coordinator、Host、安全边界、错误语义和平台要求。
6. **交叉追踪**：把原文条款映射到当前 main、PR #14 合并后的 Trusted Host 设计、M1–M6、T/S/C/TH/SEC/NAT 台账；记录 PASS、GAP、CONFLICT、NOT-IMPLEMENTED、OUT-OF-SCOPE。
7. **独立复审**：对所有差异给出源码/原文证据链；不得自动修改正式需求或技术设计。需要修订时，先提出差异和建议，等待用户确认。
8. **收口裁决**：只有原件完整、SHA 验证通过、逐条符合性矩阵完成并通过独立复审，才可将 F-07 和 Phase 2 正式契约符合性改为 PASS。

## 4. 对阶段的影响

- PR #14 已合并，代表 Trusted Host V2 **安全设计记录已入库**；不代表其与正式 V0.3/V0.6-R5 的符合性已证明。
- F-01 与 F-R2-01 已在设计文档层面关闭。
- F-02（Grok 原生工具绑定）和 F-04（Windows 跨账户/继承句柄隔离）仍需各自 PoC/OS 实测。
- SRC-01 / V0.3 需求原件已 VERIFIED；可以立即开展 T01–T34 的需求追踪与当前 main/设计符合性审查。
- SRC-02 / V0.6-R5 技术设计原件仍 **BLOCKED**，因此技术设计版本符合性及完整 F-07 仍不能判 PASS。
- F-07 保持 **BLOCKED**，但这不意味着工程工作全部停止。可继续实施与历史功能契约无关且可独立回滚的 H3-01 Host OS 身份/私有目录/密钥隔离，以及 H3-05 OS-only 负例；也可做不改生产代码的 Grok 工具能力 PoC。
- 在正式原件恢复前，不得宣称 V0.3/V0.6-R5 符合性 PASS；不得修改 Program ABI、Core API、SQLite Schema、P0-A 状态语义或扩张到 P0-B/P1/P2。H3-02/03/04 的生产接入应在其依赖 PoC 和相关安全设计复核通过后推进。
- 正式原件恢复是关闭 F-07 和证明历史契约符合性的条件，不是继续所有独立安全工程工作的先决条件。
- 不得因为原件缺失而重写一份“新版 V0.3”或“新版 V0.6-R5”并冒充历史批准版本。

## 5. 需要用户重新提供的文件

**目前无需重新上传 V0.3。** 若要关闭剩余的技术设计原件门禁，请寻找并提供以下文件；现在不需要为 H3-01/H3-05 中断工作：

1. `TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md`
3. 如方便，上传 `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` 及其原始 `SHA256SUMS.txt`
4. 如方便，上传 `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip`

若上传 ZIP，请保留原始包，不要重新压缩或修改文件后再提供，以免改变 SHA-256。

---

**当前结论：** SRC-01 已取得、SHA-256 已完整验证，且 2026-11-10 交接包 13/13 清单通过；SRC-02（V0.6-R5 正式技术设计）仍无可验证原始字节，SRC-03/04 仍未找到。Phase 2 的 V0.3 需求追踪可以继续，但完整正式技术契约符合性维持 **BLOCKED**；H3-01/H3-05 的独立 OS 安全工作可以继续，但不得越界修改冻结功能契约。
