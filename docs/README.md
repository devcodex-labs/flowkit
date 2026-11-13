# 文档入口

| 用途 | 入口 |
|---|---|
| 用户指南、示例和 API | [文档站](https://devcodex-labs.github.io/flowkit/)及其[源码](../website/content/) |
| 内部 Interactive P0-A 接入 | [Interactive 接入](./interactive.md)、[可信 Host 安全](./interactive-host-security.md)、[Stage 2 契约](./interactive-stage2-contract.md) |
| 候选状态和审查 | [P0-A 发布验收矩阵](./evidence/p0a-g07-g12-20261113/release-matrix.md) |
| 正式发行与安装 | [发布维护](./releasing.md) |

`docs/evidence/` 保存提交绑定的验收报告、探针、命令和原始日志。文件名含 `attempt` 或 `probe` 的条目可能被证据报告引用。日期化的审查记录描述当时的基线，当前状态以发布验收矩阵为准。暂存输出写到已忽略的 `.tmp/`，需要留存的日志和校验和随对应验收记录归档。

PR #16／#17 的[历史核验报告](./evidence/20261112-pr16-pr17/FlowKit-PR16-PR17-Local-Verification-Final-20261112.md)和 Phase 2 [R1](./evidence/20261112-pr16-pr17/interactive-phase2-conformance-audit-r1-20261112.md)／[R2](./evidence/20261112-pr16-pr17/interactive-phase2-conformance-audit-r2-20261112.md) 审查记录已归档到对应证据目录。
