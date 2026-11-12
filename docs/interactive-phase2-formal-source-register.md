# FlowKit Interactive — Phase 2 正式契约原件追踪登记

**状态：SRC-01 / V0.3 与 SRC-02 / V0.6-R5 均已找回并完成 SHA-256/包内清单验证；SRC-03、SRC-04 也已在资料空间目录中定位。**  
**登记日期：2026-11-12（UTC+8）**  
**当前 main：** `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`  
**关联设计：** [Trusted Host V2](./interactive-trusted-host-security-v2-design.md) · [完整路线图](./interactive-full-delivery-roadmap-2026-11-11.md)

## 1. 目标原件

| ID | 应取得的正式原件 | 已知历史路径/版本线索 | 当前证据 | 状态 |
|---|---|---|---|---|
| SRC-01 | `FlowKit-Host-Driven-Interactive-Execution-Requirements-V0.3-Confirmed.md` | 用户上传的 `FlowKit-Interactive-Development-Handoff-For-Grok-2026-11-10(2).zip` 内部 `01-CONFIRMED-REQUIREMENTS/`；范围 T01–T34 | 已取得原文件 56,883 bytes；SHA-256 `3a0adc3edb41869a6309bae29ec5496df00970c815f8dc16330a90cbf26e703e`；与 MANIFEST、SHA256SUMS 和历史审查报告前缀一致 | **VERIFIED** |
| SRC-02 | `TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md` | `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff(1).zip` 内部 `FlowKit-Interactive-V0.6-R5-Confirmed/`；资料空间 `/FlowKit/TECHNICAL-DESIGN-V0.6-R5-CONFIRMED.md` | 原文件 114,621 bytes；SHA-256 `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba`；与交接 ZIP 内 SHA256SUMS 完整值一致；9/9 清单条目全部 PASS。相同文件也存在于 Core POC evidence ZIP 的 baseline/ 目录，SHA-256 完全相同 | **VERIFIED** |
| SRC-03 | `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip` | 资料空间 `/FlowKit/FlowKit-Interactive-V0.6-R5-Confirmed-Handoff.zip`；本轮用户上传同内容副本 `FlowKit-Interactive-V0.6-R5-Confirmed-Handoff(1).zip` | 资料空间目录存在原始命名记录；本轮上传副本 91,555 bytes，SHA-256 `2deb5b3fa60ed3b7c2d29f028e33835c47aaa0a976e947de717128caf7326549`，包含 V0.6-R5 正式原件，内部 9/9 SHA256SUMS 校验通过。资料空间原始条目的原始字节未单独导出，不声称其 ZIP 容器字节与上传副本完全相同 | **LOCATED / CONTENT VERIFIED VIA UPLOADED COPY** |
| SRC-04 | `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip` | 资料空间 `/FlowKit/FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip` | 已在资料空间目录定位，大小 171,006 bytes；当前文件读取接口未提供该 ZIP 的原始字节，因此尚未对其内部文件和 ZIP SHA-256 做验证。不是本轮已上传的 V0.6 Confirmed Handoff ZIP | **LOCATED / RAW BYTES NOT YET VERIFIED** |

**重要区分与已完成验证：** 用户单独上传的 `FlowKit-Interactive-Design-V0.3-R2-Independent-Review-Grok(1).md`（55,392 bytes，SHA-256 `7efca5840151e3a1851b4fb590ec11780f56f53da691a02d770871cdf477646f`）是对 **Technical Design Draft V0.3-R2** 的独立审查报告，不是 V0.6-R5 技术设计原件。它记录的需求 SHA 前缀 `3a0adc3e…6e703e` 已由本次 ZIP 中的真实 V0.3 文件完整验证；Draft V0.3-R2 的 SHA-256 为 `92eff8d4…475520f8`。上传 ZIP 的完整 SHA-256 `8a2f679a796234383b5108d58db16c1016a35c6110301bc4eb7e091ee2ed5826` 也与报告所记 ZIP 前缀/后缀吻合。该 ZIP 内 MANIFEST 的 `technical_design_status` 明确为 `Draft V0.3-R2, not yet confirmed`，因此不能把它当作 V0.6-R5。

## 2. 当前可读取的相关材料（仅二级证据）

| 材料 | 当前可读取位置/标识 | 能证明什么 | 不能替代什么 |
|---|---|---|---|
| Grok V0.3-R2 独立审查报告 | 用户上传的同名 Markdown；另有 Library 副本 | 证明历史审查报告曾引用 V0.3 Confirmed 需求，并记录其 SHA 前缀、T01–T34 范围；本次已用原件核验完整需求 SHA | 不能替代 V0.6-R5 技术设计 |
| P0-A 确认记录 | Library：`00-APPROVAL-RECORD.md` | 证明用户于 2026-11-10 确认 P0-A 实施计划，并将 Requirements V0.3 / Technical Design V0.6-R5 作为上游基线 | 不是需求或技术设计正文 |
| P0-A 实施计划 | Library：`01-P0A-IMPLEMENTATION-PLAN-V0.1-CONFIRMED.md` | 证明计划层的 M1–M6、31 项文件级工程任务和验收原则 | 计划明确要求需求 V0.3 优先于技术 V0.6-R5；不能用计划反向重建上游契约 |
| Stage 2 PoC 报告 | Library：`STAGE2-POC-REPORT.md` | 证明历史 PoC 以 V0.3/V0.6-R5 为设计基线，并明确 PoC 不是正式验收 | 不能替代正式契约 |
| PR #14 / 当前路线图 | main：`docs/interactive-trusted-host-security-v2-*.md`、本登记 | 证明当前 Trusted Host V2 设计、Finding 和后续阶段记录 | 这些是后续安全设计和摘要，不是 2026-11-10 的原始批准契约 |

## 3. 已完成的原件验证与待执行的符合性审查

SRC-01 和 SRC-02 的原件字节、SHA-256 与包内清单已验证；SRC-03 已定位并由上传副本验证内容；SRC-04 已定位但其 ZIP 原始字节尚未读取。原件恢复步骤已完成，以下是正式符合性审查顺序：

1. **原件固定（已完成）**：SRC-01 为 56,883 bytes；SRC-02 为 114,621 bytes；分别记录完整 SHA-256 和来源。
2. **版本/批准状态核验（已完成）**：V0.6-R5 正文标明 2026-11-10 用户明确确认、冻结技术基线；确认只冻结设计，不等于代码实施授权。
3. **交接包完整性（已完成）**：V0.6-R5 Confirmed Handoff 的 `SHA256SUMS.txt` 共 9 项，9/9 PASS；Core POC evidence ZIP 中同一 V0.6-R5 基线文件 SHA-256 完全相同。
4. **V0.3 需求符合性（待执行）**：逐条提取 T01–T34 原始措辞、阶段、约束和验收条件，对照当前 main；不得以路线图同名编号代替。
5. **V0.6-R5 技术符合性（待执行）**：逐条核对 API、ABI、Program、Checkpoint、Store、Coordinator、Host、安全边界、错误语义和平台要求。
6. **交叉追踪（待执行）**：把原文条款映射到当前 main、PR #14 合并后的 Trusted Host 设计、M1–M6、T/S/C/TH/SEC/NAT 台账；逐项标记 PASS、GAP、CONFLICT、NOT-IMPLEMENTED、OUT-OF-SCOPE，并区分设计符合与实现状态。
7. **独立复审（待执行）**：对所有差异给出源码/原文证据链；不得自动修改正式需求或技术设计。需要修订时，先提出差异和建议，等待用户确认。
8. **收口裁决（待执行）**：只有逐条符合性矩阵完成并通过独立复审，才可将完整 Phase 2 正式契约符合性标为 PASS。

## 4. 对阶段的影响

- PR #14 已合并，代表 Trusted Host V2 **安全设计记录已入库**；不代表其与正式 V0.3/V0.6-R5 的符合性已证明。
- F-01 与 F-R2-01 已在设计文档层面关闭。
- F-02（Grok 原生工具绑定）和 F-04（Windows 跨账户/继承句柄隔离）仍需各自 PoC/OS 实测。
- SRC-01 / V0.3 与 SRC-02 / V0.6-R5 原件均 **VERIFIED**；正式原件缺失不再是阻断项。
- F-07 的“原件不可得”问题已关闭；F-07 的实质符合性裁决转为 **PENDING REVIEW**，在完成逐条矩阵前不能标 PASS。
- 下一步执行 T01–T34、V0.6-R5 §§1–18、R01–R22、S01–S14 的规范符合性与当前实现追踪。
- H3-01/H3-05 OS-only 工作和 Grok 工具能力 PoC 可按既定隔离边界推进；H3-02/03/04 仍需各自依赖 PoC、设计复核和安全测试。
- 在逐条符合性审查完成前，不得宣称完整 V0.3/V0.6-R5 技术契约符合性 PASS；不得借审查之名擅自修改正式需求、技术设计、Program ABI、Core API、SQLite Schema、P0-A 状态语义或扩张到 P0-B/P1/P2。
- 不得因为原件缺失而重写一份“新版 V0.3”或“新版 V0.6-R5”并冒充历史批准版本。

## 5. 后续材料与边界

- **当前无需用户重新上传 V0.3 或 V0.6-R5。** 两份正式原件均已在本轮资料中找到并验证。
- SRC-04 `FlowKit-Interactive-Final-Convergence-Review-V0.6-R5.zip` 已在 Library `/FlowKit/` 定位，大小 171,006 bytes；本轮任务不依赖该 ZIP 才能开始符合性审查。若后续需要逐条核对历史 R5 复审过程，再单独读取该归档。
- 不能将 V0.3-R2 Draft 或任何摘要当作 V0.6-R5 正式设计；本登记引用的 V0.6-R5 正式文件 SHA-256 为 `09f3a5698e238d10b80efb8e26d1c41e51b663ca620efa70815dd7b52f2106ba`。

---

**当前结论：** SRC-01（V0.3）与 SRC-02（V0.6-R5）正式原件均已找回并完成 SHA-256/清单验证；SRC-02 位于本轮上传的 Confirmed Handoff ZIP，9/9 条目通过。SRC-03 在资料空间已定位且有已验证内容副本；SRC-04 在资料空间已定位，但其 ZIP 原始字节尚未读取。原件恢复门禁已解除，下一步应直接开展 V0.3/V0.6-R5 逐条符合性核验，不再要求用户重新上传这两份文件；H3-01/H3-05 的独立 OS 安全工作可以继续，但不得越界修改冻结功能契约。
