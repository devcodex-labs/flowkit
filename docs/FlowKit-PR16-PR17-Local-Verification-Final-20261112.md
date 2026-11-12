# FlowKit PR #16 / #17 本地验收最终报告（2026-11-12）

本报告是对两个 Draft PR 的本地源码核对、测试复现、最小修复和独立复审记录。它不宣布 Phase 2、M6、P0-A、C12 或 S13 验收完成，也不代替 GitHub Actions 的 Ubuntu/Windows × Node 22/24 矩阵或真实 Grok 原生 Host。

合并建议：

- PR #16（文档审查）：建议合并。它是审查记录，不是 Phase 2 通过结论。
- PR #17（预期失败的回归测试）：不建议合并。两个 R04 用例已稳定失败，缺陷属实。
- PR #18（修复）：建议合并。竞态已消除，本地回归已通过，范围内复审没有新的 P0/P1。CI 矩阵仍是 `queued`，不能把本机结果写成在线矩阵通过。
- PR #19（本报告）：建议作为证据记录入库。它没有产品代码。同一次复核时它自己的 Actions 也仍是 `queued`。

## 1. PR HEAD 与基线

| PR | 状态 | Head | Base | 范围 |
|---|---|---|---|---|
| [#16](https://github.com/devcodex-labs/flowkit/pull/16) | OPEN, Draft, MERGEABLE | `90cc0de7e4f0d5971207a85221c32e9f79d9c9b5` | `13d573c5ddc4a0ed3502401589c581799c96c5d2` | 只新增两份审查文档，+259 / −0 |
| [#17](https://github.com/devcodex-labs/flowkit/pull/17) | OPEN, Draft, MERGEABLE | `ada01c933553206948ffcf2f944dfc5604e44da2` | 同上 | 只改 `tests/interactive/coordinator.test.mjs`，+31 / −0 |
| [#18](https://github.com/devcodex-labs/flowkit/pull/18) | OPEN, Draft, MERGEABLE | `452ac387b1f3da97d38bfb27b8582953ab1b818e` | 同上 | 修复 + 与 #17 相同的两个测试，+45 / −3 |
| [#19](https://github.com/devcodex-labs/flowkit/pull/19) | OPEN, Draft, MERGEABLE | 见第 14 节；本段写入时为 `3175a0794a8fb1305ffa0f06d1ae426c0c2b4ae9` | 同上 | 本报告与脱敏日志，无产品代码 |

PR #16 / #17 的 HEAD 与任务开始时给出的历史 SHA 一致，执行前已用 `gh pr view` 重新读取，不是沿用旧记录。2026-11-12 13:15 +08 再次 `gh pr view`：四条 PR 仍是 OPEN Draft，`mergedAt` 为 null，base 仍是 `13d573c5ddc4a0ed3502401589c581799c96c5d2`，#16/#17/#18 的 head 未变。本地 `D:\Worker\flowkit` 的 `main` 仍是该 SHA，`git status --porcelain=v1` 为空。原始输出在 `docs/evidence/20261112-pr16-pr17/actions-reconfirm-20261112T1315+0800.txt`。

检出：

- `D:\Worker\flowkit`：用户原工作区，仍在 `main`，未改。
- `D:\Worker\flowkit-pr16-verify`：detached `90cc0de`。
- `D:\Worker\flowkit-pr17-verify`：detached `ada01c9`。
- `D:\Worker\flowkit-pr17-fix`：分支 `fix/r04-start-input-snapshot-20261112`。
- `D:\Worker\flowkit-pr16-pr17-review`：分支 `review/pr16-pr17-local-verification-20261112`，本报告所在。
- 已有 worktree `D:\Worker\flowkit-acceptance-grok-20261111` 未使用。

`git diff --stat 13d573c 90cc0de` 只有：

- `docs/interactive-phase2-conformance-audit-r1-20261112.md`
- `docs/interactive-phase2-conformance-audit-r2-20261112.md`

没有生产代码。`git diff ada01c9 -- tests/interactive/coordinator.test.mjs` 在修复分支上为空，说明纳入的回归测试与 PR #17 逐字相同。

## 2. 环境与依赖

| 项 | 值 |
|---|---|
| 操作系统 | Microsoft Windows NT 10.0.26200.0 |
| 默认 Node | v24.22.2，x64，Volta `C:\Program Files\Volta\node.exe` |
| 另一次运行 | Volta `node@22.22.2` |
| npm | 11.19.1 |
| 引擎要求 | `package.json` `engines.node` 为 `>=22.13.0`。两个实际版本都满足 |
| 根依赖 | lockfile v3；`acorn` 8.19.0；dev `tar` 7.5.22、`typescript` 5.0.4 |
| 安装 | 两个 PR worktree 均 `npm ci --ignore-scripts --no-audit --no-fund`，exit 0，`added 8 packages` |
| 认证 | `gh auth status`：`rockyshi1993`，HTTPS，scopes `gist, read:org, repo, workflow`。本报告不记录令牌 |

CI 指定的 Node 22.13.0 与 24.22.1 没有逐版本重跑。本机跑的是 22.22.2 与 24.22.2。Linux 未跑。

## 3. 命令与日志位置

原始日志目录（未入库的完整输出，含 npm pack 文件清单）：`D:\Worker\flowkit-verify-logs\`。

随本审查分支提交的是脱敏后的决定性日志，位于 `docs/evidence/20261112-pr16-pr17/`。PowerShell `*>` 捕获的中文示例输出有代码页乱码；JSON 里的 `passed:true` 和英文断言不受影响。乱码不记为产品失败。

| 命令 | 目录 | 结果 | 日志 |
|---|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | PR16、PR17 worktree | PASS | 控制台 `added 8 packages` |
| `npm run verify` | PR16 `90cc0de`，Node 24.22.2 | PASS，369 tests / 369 pass / 0 fail，随后 types、package check、package consumer 均 exit 0 | `pr16-verify-node24.txt` |
| `npm run docs:examples` | PR16 | PASS，`FlowkitDocsConsumerV1.passed=true`，E01–E13 | `pr16-docs-examples-node24.txt` |
| `npm --prefix website ci --ignore-scripts --no-audit --no-fund` | PR16 | PASS，`added 333 packages` | `pr16-website-ci.txt` |
| `npm run docs:check` | PR16，autocrlf 工作区 CRLF | FAIL，见第 4 节 | `pr16-docs-check-node24.txt` |
| `npm run docs:check` | PR16，按索引强制 LF 后 | PASS，`{"pages":48,"full":true,"passed":true}`，16 tests / 0 fail | `pr16-docs-check-lf-node24.txt` |
| `npm run docs:build` | PR16 | PASS，`{"pages":48,"html":49,"full":true,"passed":true}` | `pr16-docs-build-node24.txt` |
| `node --test tests/interactive/coordinator.test.mjs` | PR17，Node 24.22.2 | FAIL，23 tests / 21 pass / 2 fail | `pr17-coordinator-node24.txt` |
| 同上 | PR17，Node 22.22.2 | FAIL，同样 21 pass / 2 fail | `pr17-coordinator-node22.22.2.txt` |
| 同上 | 修复提交前，Node 24.22.2 | PASS，23 / 0 | `fix-coordinator-node24-before-full.txt` |
| `npm run verify` | 修复分支，Node 24.22.2 | PASS，371 / 0 | `fix-verify-node24.txt` |
| `npm run verify` | 修复分支，Node 22.22.2 | PASS，371 / 0，package check `passed:true` | `fix-verify-node22.22.2.txt` |
| impact tests（coordinator、store、crash、s07、trusted-host、stage2） | 修复分支，Node 22.22.2 | PASS，71 / 0 | `fix-impact-node22.22.2.txt` |
| `npm run docs:examples` / `docs:check` / `docs:build` | 修复分支，LF 工作区，Node 24.22.2 | PASS | `fix-docs-*.txt` |
| 副作用探针 | 修复分支 | PASS | `probe-r04-side-effects-node24.txt` |
| Trusted Host 探针 | 修复分支 | PASS | `probe-r04-host-node24.txt` |
| CF-08 探针 | PR17 源码（与 main 的 `compile.mjs` 相同） | 竞态复现成功（脚本断言 exit 0） | `probe-cf08-node24.txt` |

`core.autocrlf=true`。`README.md` 在强制 LF 之前是 `i/lf w/crlf`。`docs:check` 第一次失败是工作区 CRLF 与生成的 quick-start 片段 LF 不一致，断言原文是 `Run npm run docs:sync`。按索引强制 LF 后，同一命令通过。这不是 PR #16 的文档内容缺陷。没有为了让检查变绿而改 README。

## 4. PR #16 审查结论：建议合并

结论：**PASS（作为审查记录可合并）**。不是 Phase 2 符合性 PASS。

已核对：

- 两份文档都写明不是最终 PASS。T01–T34、R01–R22、S01–S14 使用 `P-PARTIAL`、`DEFERRED`、`BLOCKED`、`GAP-P0-A`、`DESIGN-ONLY/NOT-FULLY-TESTED`。正文里的 “PASS” 都是在否定“已经通过”。
- R2 把证据分成 `SOURCE-CONFIRMED`、`SOURCE-INFERRED`、`CONTRACT-CONFIRMED-V03`、`V06-R1-EXTRACT`、`RUN-BLOCKED`，并写明这些不是测试 PASS 等级。
- R2 第 5 节把 PR #17 标成预期失败复现，并写明 CI `queued` 不等于测试 FAIL。这一点与当时的写法一致。本报告之后已经补上本地 FAIL，见第 5 节。R2 没有把这次尚未发生的运行写成通过。
- 五个关键 blob 在 `ae5fc5a` 与 `13d573c` 上由 `git rev-parse <commit>:<path>` 复核，与 R2 表一致：

| 文件 | blob |
|---|---|
| `src/interactive/coordinator.mjs` | `1ce6460d58c20a38580a30c2966ba8187f1382b7` |
| `src/interactive/trusted-host.mjs` | `315e22662e80c4f1561c2ab8d717a168251c1ed5` |
| `src/interactive/sqlite-store.mjs` | `0f2db54c145649525bcd77b0c501f083dfeb54ee` |
| `src/interactive/compile.mjs` | `43f6dfa86908a486446dc5193c7a4d2895926617` |
| `types/interactive.d.ts` | `a178b2adbff6b18345a7e1b63e3370269ac2425f` |

Findings：

| ID | 本轮结论 | 证据 |
|---|---|---|
| CF-01 | 源码缺口属实，P0-A `adminTerminate` 缺失。不因此改 API | `src/` 与 `types/` 无 `adminTerminate`。`coordinator.mjs` 返回的是 `start/complete/resume/load/policyHash`（main 第 657 行，修复后第 668 行） |
| CF-02 | factory 与具名函数的差异属实。未改公共导出 | `src/interactive/index.mjs` 导出的是 `compileInteractive`、`createInteractiveCoordinator`、`createTrustedInteractiveHost` 等 factory |
| CF-05 | 终态帧携带完整 `state` 属实。未改投影 | `asPublicFrame` 在 `coordinator.mjs` 第 144–151 行。类型 `InteractiveRunFrame.state?` 在 `types/interactive.d.ts` 第 83–92 行 |
| CF-06 | 公开 Store 接口是同步的，属实。未改 Store | `types/interactive.d.ts` 第 106–141 行；`sqlite-store.mjs` `createRun` 从第 290 行起同步返回 |
| CF-07 | R2 当时标为 `SOURCE-INFERRED`。本轮已升级为稳定复现的实现缺陷，并由 PR #18 修复。R2 没有把它写成测试 PASS | 见第 5–6 节 |
| CF-08 | 编译选项竞态属实，当前会被 P0-B 门禁拒绝，没有越权启用新阶段。本轮复现，不放进 CF-07 修复 | `compile.mjs` 第 40–44 行。探针见第 10 节 |

非阻断的引用精度：

- R1 把 `asPublicFrame` 写成约第 140–150 行。同一 blob 上函数实际从第 144 行开始。R2 已改成第 144–151 行。行为描述正确。
- R1 说闭包 API 只有 `start/complete/resume/load`。返回对象里还有 `policyHash`。这不改变“没有 `adminTerminate`”的结论。
- 本机没有找到 V0.6-R5 原文文件，因此没有独立重读 §4/§5/§8/§16 的措辞。R2 已把这部分标成 `V06-R1-EXTRACT`。CF-02、CF-05、CF-06 继续保持“不未经确认就改 API”。源码事实已在本轮重读。

本地适用测试全部通过（第 3 节）。R1 与 R2 的结论方向一致：R2 校准了行号和五个 blob，并新增 CF-07/CF-08，没有把 R1 的 PARTIAL/BLOCKED 改成 PASS。

## 5. PR #17 竞态复现：FAIL，根因属实

结论：**FAIL / 缺陷确认**。不是测试写错，也不是依赖或环境故障。其余 21 个 coordinator 测试在同一进程里通过。Node 24.22.2 与 Node 22.22.2 的失败形态相同。

提交：`ada01c933553206948ffcf2f944dfc5604e44da2`。

根因在修复前的 `src/interactive/coordinator.mjs` `start()`（当时第 534–552 行）：

1. `programBytes` 与 `programIdentity` 在第一次 `await` 之前已经复制。
2. `await loadInteractiveProgram(...)` 一定会让出。`load.mjs` 第 66 行还有 `await import(...)`。即使 Promise 已经完成，`await` 仍把后续代码排到微任务。
3. `initialCheckpoint` 里的 `copy(state)` 和随后的 `copy(startIntent)` 发生在这次让出之后。
4. 调用方在 `start()` 返回 Promise 之后、第一次 `await` 完成之前修改原对象，Checkpoint 和 `startIntentHash` 会看到修改后的值。

`copy` 是 `safeJSONSnapshot`（`canonical.mjs` 第 111–112 行），本身是深拷贝，但调用得太晚。

### 用例 1：State，含嵌套对象

命令：`node --test tests/interactive/coordinator.test.mjs`。

预期：`store.load(frame.runId).state` 等于调用瞬间的 `{ready:true, existing:'hello', context:{request:'before-await'}}`。

实际：AssertionError `persisted State must be a deep entry-time snapshot`。

```text
actual: { context: { request: 'modified-after-start' }, existing: 'modified-after-start', ready: true }
expected: { ready: true, existing: 'hello', context: { request: 'before-await' } }
at tests/interactive/coordinator.test.mjs:417
```

顶层 `existing` 和嵌套 `context.request` 都变成了调用之后写入的值。Store 已保存错误内容。Node 24 与 Node 22 的 actual/expected 相同。

### 用例 2：startIntent

预期：用原始 `{request:'before-await'}` 对同一 `startKey` 重放，得到同一个 `runId`。

实际：

```text
Error: FK_I_START_CONFLICT: startKey belongs to different intent
at sqlite-store.mjs:313
at coordinator.mjs:551
at tests/interactive/coordinator.test.mjs:430
code: FK_I_START_CONFLICT
```

第一次 `start()` 把突变后的 intent 写进了幂等身份。原始 intent 的重放被当成冲突。这是 Store 副作用，不是断言文案问题。

两次运行都是 2 fail / 21 pass，没有抖动。因此不建议合并 PR #17：它会把已知失败测试送进 `main`。同等测试已在 PR #18 中与修复一起通过。

## 6. 修复

分支 `fix/r04-start-input-snapshot-20261112`，提交 `452ac387b1f3da97d38bfb27b8582953ab1b818e`，Draft PR https://github.com/devcodex-labs/flowkit/pull/18 。

`start()` 在第一次 `await` 之前：

- 用现有 `copy()`（有界、拒绝 getter / proxy / 循环 / 非 JSON）复制 State。
- 超限 State 仍映射为 `FK_I_CHECKPOINT_CAPACITY` / `initial State exceeds Checkpoint hard limit`，与 `initialCheckpoint` 原来的映射相同。
- 同样复制 `startIntent`。非法 intent 仍是原来的 `TypeError` / `RangeError`，发生在 `putArtifact` 之前。
- 之后的 `initialCheckpoint(..., stateSnapshot)`、`createRun({startIntent:intentSnapshot})` 不再读取调用方对象。

没有 `Object.freeze` 调用方对象。没有只修 State 或只修 `startIntent`。没有改 CAS、Receipt、Journal、Program 身份或安全规则。

`initialCheckpoint` 仍会对已复制的 State 再做一次 canonical 拷贝。第二次拷贝的输入是第一次快照，不是调用方对象。`safeJSONSnapshot` 经 `JSON.parse` 产生新对象，不与调用方共享嵌套引用。持久化结果由下面的测试证明与调用瞬间一致。

非法输入与合法输入同时存在时，State/intent 错误会早于 Program 加载错误出现。这是“副作用之前拒绝非法输入”的结果。现有单故障测试（NaN State、缺失 binding、超限初始 State）仍通过。

## 7. 修复前后对比

| 运行 | 修复前 `ada01c9` | 修复后 `452ac38` |
|---|---|---|
| coordinator，Node 24.22.2 | 21 pass / 2 fail | 23 pass / 0 fail |
| coordinator，Node 22.22.2 | 21 pass / 2 fail | 含在下方 71 与 371 中 |
| `npm run verify`，Node 24.22.2 | PR16 基线 369 pass（无这两个测试） | 371 pass / 0 fail |
| `npm run verify`，Node 22.22.2 | 未对失败提交跑全量 | 371 pass / 0 fail |
| Node 22.22.2 impact（6 个文件） | 未跑 | 71 pass / 0 fail |

副作用探针（修复后，Node 24.22.2）对 NaN、getter、循环 State 和 NaN `startIntent` 计数：这些调用没有增加 `putArtifact` 或 `createRun`。随后一次成功启动、一次原始值重放、一次冲突重放合计 `puts: 3`、`creates: 3`。保存的 State 为：

```json
{ "existing": "before", "nested": { "request": "before" }, "ready": true }
```

调用后把顶层、嵌套和 `startIntent` 都改成 `after`，没有进入 Checkpoint。原始 intent 重放命中同一 Run；不同 intent 抛出 `FK_I_START_CONFLICT`。

Trusted Host 探针：`host.start()` 在同步进入 `coordinator.start()` 时完成快照。保存的 `existing` 与 `nested.request` 都是 `before`。`getPublicAgentTask` 的 `input` 是 `{existing:'before'}`，任务 JSON 不含 `after`。

## 8. 修复 PR

- URL：https://github.com/devcodex-labs/flowkit/pull/18
- Draft：是
- Head：`452ac387b1f3da97d38bfb27b8582953ab1b818e`
- Base：`13d573c5ddc4a0ed3502401589c581799c96c5d2`
- 未合并，未推 `main`，未发布 npm，未创建 Release

## 9. 测试状态

| 项 | 状态 |
|---|---|
| PR #16 `npm run verify`（Node 24.22.2） | PASS |
| PR #16 `docs:examples` | PASS |
| PR #16 `docs:check`（CRLF 工作区） | FAIL，环境行尾，非文档内容 |
| PR #16 `docs:check`（索引 LF） | PASS |
| PR #16 `docs:build` | PASS |
| PR #16 GitHub Actions run `43156062422` | BLOCKED，`status=queued`，`conclusion` 空，7 个 job pending / 0 秒，`gh pr checks` exit 8 |
| PR #17 两个 R04 测试 | FAIL，已复现 |
| PR #17 同文件其余测试 | PASS |
| PR #18 `npm run verify` Node 24.22.2 与 22.22.2 | PASS，各 371 |
| PR #18 docs examples / check / build | PASS |
| PR #17 Actions run `43155961638` | BLOCKED，`status=queued`，`conclusion` 空，7 个 job pending / 0 秒，`gh pr checks` exit 8 |
| PR #18 Actions run `43159273722` | BLOCKED，同上 |
| PR #19 Actions run `43159631042` | BLOCKED，同上。这是本报告自己的运行，不能当成报告已通过在线 CI |
| Ubuntu | BLOCKED，本机未跑 |
| CI 精确 Node 22.13.0、24.22.1 | BLOCKED，未跑 |
| 真实 Grok 原生 Host、C12、S13、T27 | BLOCKED |
| Windows ACL / 独立 OS 用户 | BLOCKED |
| CF-08 修复 | DEFERRED，已复现，未混入 PR #18 |

Standard 模式、Interactive 阶段顺序、Checkpoint CAS、startKey 冲突、两进程测试、Program 身份、失败恢复和类型/包导出都包含在两次 `npm run verify` 的 371 个测试里。这些通过不等于原生 Host 验收。

## 10. 与冻结契约的符合性

本次代码只提前做了 R04 要求的入口快照，使用仓库里已有的 canonical JSON。没有修改 Requirements V0.3、Technical Design V0.6-R5、Program ABI、SQLite schema 或公开类型。

仍未关闭、且本轮故意不改的契约项：

- CF-01：P0-A `adminTerminate` 仍缺失。
- CF-02：公共 SDK 形态差异仍待 V0.6 §4 与批准记录裁决。
- CF-05：终态公开帧仍带完整 State。修复没有新增泄露路径；`getPublicAgentTask` 的 allowlist 行为未改。
- CF-06：同步 Store 与异步五操作规范的差异仍在。
- CF-08：`compile.mjs` 第 44 行在两次 `await` 之后把 `options.featureStage` 传给 `lowerInteractive`，而前面的检查用的是 `snapshotOptions`。探针在合法 `P0-A` 调用返回前把选项改成 `P0-B`，结果从 7632 字节变成 0 字节，诊断为 `FK_I_UNSUPPORTED_GRAPH: This build implements only P0-A; caller cannot enable P0-B`。这是非确定性失败，不是权限提升。未修。

## 11. 独立复审

复审对象是提交 `452ac38` 的 diff，不是实施过程中的口头结论。

| 问题 | 结论 |
|---|---|
| 是否只让测试变绿 | 否。快照发生在 `coordinator.mjs` 第 545–553 行，早于第 554 行的 `await`。第 560 与 562 行使用这两份拷贝 |
| 是否只冻结外部对象 | 否。没有冻结调用方对象。拷贝来自 `canonicalBytes`，拒绝 getter |
| 新的调用方竞态 | 未发现。调用方要等到 `start()` 让出才能继续，而让出点已经在快照之后。Host `start()`（`trusted-host.mjs` 第 147–156 行）在自己的第一次让出之前同步调用 `coordinator.start`。探针已覆盖 |
| Store / CAS / 历史 Run | diff 不改 `sqlite-store.mjs`。旧 Checkpoint 不迁移。`createRun` 的哈希公式未改，只是输入改为入口快照 |
| 完整 State 泄露 | `asPublicFrame` 未改。Host 探针里的模型任务只有 allowlist 字段 |
| 额外不可逆副作用 | 非法输入在 `putArtifact` 之前抛出。合法路径的 `putArtifact` 仍在校验和 `assertRuntime` 之后，顺序与原来一致 |
| 已确认契约 | 未改 ABI、schema、错误码集合或 P0-A 范围。超限 State 的 `FK_I_CHECKPOINT_CAPACITY` 映射保留 |
| 新的 P0/P1 | 本 diff 内未发现。双故障时非法 State 会先于 Program 错误抛出，现有单故障测试覆盖了原先后果 |

CF-08 保持独立，不在这个 diff 里。

## 12. 合并建议

- **建议合并 PR #16。** 文档与源码证据一致，没有把未完成验收标成通过，没有生产代码。合并它只表示审查记录可以入库。
- **不建议合并 PR #17。** 测试失败是真的。PR #18 已包含同一测试。两个 PR 都合并会造成重复。修复合并后可以由后续复审关闭 #17。
- **建议合并 PR #18。** 竞态已在入口快照处消除，本地 Windows 的 Node 22.22.2 与 24.22.2 回归已通过，独立复审没有发现本变更范围内的新 P0/P1。这三项是本建议的依据。GitHub Actions 仍是 `queued`，不计入通过，也不把排队写成已证实的故障。
- **建议合并 PR #19。** 它只提交本报告和脱敏日志。合并它只表示证据记录可以入库。
- 本会话不执行合并、不推 `main`、不发布 npm、不创建 Release。最终复审和授权范围内的合并由后续复审方执行。

## 13. 未完成项

- GitHub Actions：PR #16 run `43156062422`、PR #17 run `43155961638`、PR #18 run `43159273722`、PR #19 run `43159631042` 在 2026-11-12 13:15 +08 仍是 `queued`，`conclusion` 为空。`gh pr checks` 对各 PR 的退出码都是 8。排队原因未判定。exit 8 在这里是 CLI 对未完成检查的退出码，不是产品测试失败。
- 未跑 Ubuntu，未跑 CI 锁定的 Node 22.13.0 与 24.22.1。
- 未做真实 Grok 原生工具调用、C12、S13、T27、Windows 独立账户 / ACL。脚本 Host 测试不能代替这些。
- CF-01、CF-02、CF-05、CF-06、CF-08 仍打开。CF-02/05/06 需要正式契约裁决后才能改 API。
- 本机未重新打开 V0.6-R5 原文，相关措辞仍以 R1 摘录和 R2 的披露为准。

## 14. 2026-11-12 13:15 +08 复核

命令在 `D:\Worker\flowkit` 执行。原始输出：`docs/evidence/20261112-pr16-pr17/actions-reconfirm-20261112T1315+0800.txt`。

| 对象 | 结果 |
|---|---|
| 本地 `main` | `13d573c5ddc4a0ed3502401589c581799c96c5d2`，`git status --porcelain=v1` 为空 |
| PR #16 | OPEN，Draft，MERGEABLE，`mergedAt` null，head `90cc0de7e4f0d5971207a85221c32e9f79d9c9b5` |
| PR #17 | OPEN，Draft，MERGEABLE，`mergedAt` null，head `ada01c933553206948ffcf2f944dfc5604e44da2` |
| PR #18 | OPEN，Draft，MERGEABLE，`mergedAt` null，head `452ac387b1f3da97d38bfb27b8582953ab1b818e` |
| PR #19 | OPEN，Draft，MERGEABLE，`mergedAt` null，head `3175a0794a8fb1305ffa0f06d1ae426c0c2b4ae9`（本复核记录提交之前） |
| run `43156062422` | `status=queued`，`conclusion` 空，`createdAt` `2026-11-12T04:37:52Z`，`updatedAt` `2026-11-12T04:37:54Z`，head `90cc0de` |
| run `43155961638` | `status=queued`，`conclusion` 空，`createdAt` `2026-11-12T04:36:58Z`，`updatedAt` `2026-11-12T04:36:59Z`，head `ada01c9` |
| run `43159273722` | `status=queued`，`conclusion` 空，`createdAt` 与 `updatedAt` 都是 `2026-11-12T05:07:42Z`，head `452ac38` |
| run `43159631042` | `status=queued`，`conclusion` 空，`createdAt` 与 `updatedAt` 都是 `2026-11-12T05:10:51Z`，head `3175a07` |

四个 run 各有 7 个 job，`gh pr checks` 都显示 `pending`、耗时 `0`。没有 job 进入 `in_progress`、`success` 或 `failure`。因此不能写在线 CI 通过，也不能写 GitHub Actions 已无法运行。本机 Windows 结果仍然只覆盖 Node 22.22.2 与 24.22.2。

本段本身的提交会让 PR #19 再排一次 Actions。那一次运行不在上表四个 run 里。本报告不预写它的 `status` 或 `conclusion`。
