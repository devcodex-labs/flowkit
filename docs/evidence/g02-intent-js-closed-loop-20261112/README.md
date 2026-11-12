# G02 证据目录（2026-11-12，Asia/Shanghai）

本目录保存 G02「真实用户意图 → Workflow DSL → 可执行 JavaScript → Standard / Interactive P0-A 执行」的原始输入、编译日志和本地复现输出。它不是新的需求或技术设计，也不构成独立复审 PASS。

| 路径 | 内容 |
|---|---|
| `dsl-generation/` | Grok 生成 `.workflow.js` 时的完整输入、第一次原始输出，以及“一次通过、无第二次尝试”的说明 |
| `cli/` | 官方 `flowkit compile` / `flowkit check` 与 `compileInteractive` 的原始输出、退出码和 Program 身份 |
| `execution/` | Standard `run()`、Interactive 夹具重放、本地 `node --test` 的原始日志 |
| `07-standard-golden-diff.md` | 与 `examples/editorial.workflow.js` golden 的可解释差异 |
| `HASHES.sha256` | 上述文件及示例/夹具的 SHA-256 |

证据分级：编译与 JS/SQLite 执行为 P；`source=grok-model` 为 M 层结果消费（6 次消费 / 5 份独立正文 / 1 次复用并重新绑定 Pending 身份，不是 6 次独立模型推理）；`source=scripted-invalid` 是脚本负例。`pendingAtEnd` 只描述终态帧；`publishedPendingCount` 来自实际执行 route。本环境用 Node 和 FlowKit CLI 执行 JavaScript，**不得**标为 N-PASS 或原生安全 Host 来源认证。GitHub CI 7/7 只证明仓库回归，不证明原生 Grok 工具或跨用户 OS 隔离。

正式审查请同时使用 GitHub PR、精确 HEAD、本目录与交接包中的 `STAGE-REVIEW-REPORT.md`。
