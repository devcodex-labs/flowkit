# FlowKit P0-A V0.1 — 31 Task Current-Main Crosswalk

**Snapshot main:** \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\`  
**Approved plan:** \`01-P0A-IMPLEMENTATION-PLAN-V0.1-CONFIRMED.md\`, confirmed 2026-11-10.  
**Purpose:** Map all 31 approved file-level tasks to current source, tests and evidence. This is a source-presence and gap inventory, **not** the final acceptance report. A source file/test existing does not automatically mean its full task is PASS.

## 1. Status meanings

- **CODE-PRESENT** — implementation/test surface exists and maps to the task; acceptance still requires exact contract and runtime evidence.
- **PARTIAL** — some behavior exists, but a named part of the approved task or its evidence remains open.
- **GAP** — required implementation surface/behavior is not present on current main.
- **CI-BLOCKED** — local evidence exists but current exact-main GitHub Actions run has not completed.
- **NOT-IN-SCOPE** — excluded by confirmed P0-A plan; not counted as a defect.

No item in this table is a final P0-A acceptance PASS.

## 2. M1 — Standard compiler reuse / Feature Gate / Resumable IR

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M1-01 Standard analyzer reuse | \`src/interactive/compile.mjs\` calls \`analyzeSource\`; original analyzer remains in \`src/compiler/analyze.mjs\` | \`tests/interactive/compiler-front.test.mjs\`: real Standard analyzer for JS/TS and diagnostic preservation; \`ir.test.mjs\` compares original Graph/Dataflow/when AST | **CODE-PRESENT**. Finish T01–T34 mapping and exact CI matrix. |
| A-M1-02 P0-A feature gate | \`src/compiler/interactive/feature-gate.mjs\` | \`compiler-front.test.mjs\`: unsupported Action/Verification, Agent verify, featureStage and pure Condition/Terminal | **CODE-PRESENT**. Keep negative cases in full release matrix. |
| A-M1-03 Resumable IR lowering | \`src/compiler/interactive/lower.mjs\` | \`ir.test.mjs\`: stable IR, source identity, original when AST semantics | **CODE-PRESENT**. Complete independent comparison against V0.6 §2/§5 and edge-case ledger. |
| A-M1-04 IR validation | \`src/compiler/interactive/validate-ir.mjs\` | \`ir.test.mjs\`: injected edges/events, duplicate blocks, missing phases | **CODE-PRESENT**. Verify all T/R/S negative cases, not only current unit fixtures. |
| A-M1-05 M1 tests | \`tests/interactive/compiler-front.test.mjs\`, \`ir.test.mjs\` | 6 + 5 named tests; exact current-main tree is included in updated PR #12/#11 merge-tree CI runs 43181841181 and 43182753787, both 7/7 | **CODE-PRESENT / CI-PASS via exact merge-tree matrix** (Ubuntu 24.04 + Windows 2025 × Node 22.13.0/24.22.1). Direct main run 43183321344 was still in progress at this snapshot. |

## 3. M2 — Executable Program / ABI / loader

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M2-01 JS emitter | \`src/compiler/interactive/emit.mjs\` emits executable \`advance()\`, ProgramTable and identity | \`tests/interactive/emitter.test.mjs\`: deterministic bytes/hash, zero imports, Condition/Terminal and Agent frame/Pending/retry decisions | **CODE-PRESENT**. Complete V0.6 §5/§10 contract crosswalk. |
| A-M2-02 compile API / diagnostics | \`src/interactive/compile.mjs\` returns diagnostics and compiled bytes/identity | \`compiler-front.test.mjs\`, \`emitter.test.mjs\` | **CODE-PRESENT; module layout consolidated**. Approved plan named \`diagnostics.mjs\`, but separate file is not itself a semantic requirement; verify diagnostic fields and stable codes. |
| A-M2-03 same-byte loader | \`src/interactive/load.mjs\` exports \`loadInteractiveProgram\` | \`emitter.test.mjs\`: wrong digest, dynamic import and ABI mismatch rejection; \`stage2-program-cache.test.mjs\`: re-read exact Store bytes/identity/policy | **CODE-PRESENT** under \`load.mjs\` rather than planned \`loader.mjs\`. Finish exact corrupted-byte and same-byte load audit. |
| A-M2-04 Checkpoint / proposal runtime validation | Relevant checks are distributed across \`validate-ir.mjs\`, \`coordinator.mjs\` and \`sqlite-store.mjs\`; no standalone \`src/interactive/checkpoint.mjs\` | \`ir.test.mjs\`, \`coordinator.test.mjs\`, \`store.test.mjs\` | **PARTIAL**. Build an explicit requirement-to-function-to-negative-test map for every CheckpointView, event, proposal, stack effect and immutable identity invariant. |
| A-M2-05 emitter/loader/ABI tests | \`emitter.test.mjs\`, \`ir.test.mjs\`, \`compiler-front.test.mjs\` | Emitter suite includes deterministic standalone output, exact hash, zero imports, routing and loader rejects | **CODE-PRESENT**. Dedicated test file names differ from plan; verify the complete required golden/ABI vector coverage. |

## 4. M3 — Canonical JSON / Registry / SQLite Store / Journal

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M3-01 canonical JSON and identity | \`src/interactive/canonical.mjs\`: bounded canonical bytes, snapshot, hash and decoding; Store implements artifact identity | \`store.test.mjs\`: key order, prototype-as-data, accessors, Proxy, cycle, \`-0\`, non-finite and limits | **PARTIAL**. Confirm the exact V0.6 canonicalization requirement and add/verify full RFC 8785/JCS golden vectors (POC-F04); current tests show a constrained canonical JSON contract, not by themselves complete JCS conformance. |
| A-M3-02 SQLite CheckpointStore | \`src/interactive/sqlite-store.mjs\` implements WAL/FULL, Genesis, transactions, CAS, Journal and receipt index | \`store.test.mjs\`: atomic CAS/Journal, duplicate transition rollback, connection restart and two OS processes | **PARTIAL**. Current public Store interface is synchronous while R1/R2 CF-06 records an async five-operation V0.6 contract discrepancy. Resolve against exact V0.6 §5/§8 and approval record; preserve atomic semantics. |
| A-M3-03 Program Registry / Run retain | fk_i_artifacts stores immutable Program bytes/identity; fk_i_runs(namespace, artifact_hash) has a composite FK to the artifact row. createRun() inserts the Run reference and Genesis Journal in one write transaction; deleteArtifact() refuses while any Run references the artifact. | store.test.mjs: immutable bytes, tenant namespace, deletion refusal, atomic Run/Journal; m6-e2e.test.mjs: retained Program and tamper rejection | **CODE-PRESENT for atomic Run-retain + Genesis**. Important distinction: putArtifact() pre-registers immutable bytes in a preceding transaction, but the durable Run→artifact retain association is the FK-bearing Run row committed atomically with Genesis. A crash before createRun() can leave an unreferenced artifact row, not a Run without its Program retain. Finish the exact V0.6 §6.2 lifecycle/cleanup crosswalk; do not call this an established atomic-retain defect. |
| A-M3-04 Store/Journal/Receipt tests | \`tests/interactive/store.test.mjs\`, \`s07-capacity.test.mjs\`, \`coordinator.test.mjs\` | Tests include CAS, Journal chain, receipt history, duplicate transition rollback, tenant isolation and cross-process competition | **CODE-PRESENT / PARTIAL**. Finish full historical Ack, unknown-CAS-response and all approved failure-matrix cases with raw evidence. |
| A-M3-05 crash workers | \`tests/interactive/crash.test.mjs\`, \`tests/integration/m6-worker.mjs\`, \`m6-host.mjs\` | Real SIGKILL before/after Agent publish, receipt acceptance, validation and State commit; two-process receipt race | **PARTIAL**. Current tests cover representative cut points, not proof that all F01–F20 and all applicable Windows/Linux equivalents have passed. |

## 5. M4 — Coordinator / Agent / API

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M4-01 Coordinator | \`src/interactive/coordinator.mjs\` | \`coordinator.test.mjs\`: Condition/Terminal, Pending, retry, commit, resume, budget and concurrency | **CODE-PRESENT**. Full T01–T14 and S01–S07 closure remains part of M6. |
| A-M4-02 policy preflight | Policy snapshot/hash and runtime-binding checks are integrated in \`coordinator.mjs\`; no separate \`policy.mjs\` | \`coordinator.test.mjs\`: unsupported checkStep and missing bindings reject before Store writes; \`stage2-integration.test.mjs\`: binding-version drift | **CODE-PRESENT; module consolidated**. Verify all approved policy/skill/program identity drift cases. |
| A-M4-03 Agent execution semantics | Agent frame, Skill resolution, retries, validation and candidate commit are integrated in \`coordinator.mjs\`; no separate \`agent.mjs\` | \`coordinator.test.mjs\`: retries+1, FK_R004, pure validator contract, State isolation and candidate commit | **CODE-PRESENT; module consolidated**. Verify complete Standard parity and every T02/T04/T13/T14 case. |
| A-M4-04 receipt lifecycle | Receipt acceptance, duplicate identity, conflict, CAS and durable index are integrated in Coordinator/Store; no separate \`receipts.mjs\` | \`coordinator.test.mjs\`, \`store.test.mjs\`, \`crash.test.mjs\` | **CODE-PRESENT; module consolidated**. Finish full receipt replay and lost-response matrix. |
| A-M4-05 public SDK entry | \`src/interactive/index.mjs\` is exported as package subpath \`./interactive\`; there is no standalone \`src/interactive.mjs\` facade | \`tests/package/consumer.mjs\` imports \`@devcodex-labs/flowkit/interactive\` and checks its exports/real run | **CODE-PRESENT; file layout/API shape differs from plan**. CF-02 still requires V0.6 §4 and approval-record review before changing public exports. |
| A-M4-06 Coordinator/Agent/recovery tests | \`coordinator.test.mjs\`, \`crash.test.mjs\`, \`store.test.mjs\` | 23 Coordinator tests (including two R04 tests), 3 crash tests and 10 Store tests | **CODE-PRESENT / PARTIAL**. Test files are consolidated; map each T01–T14/T29 acceptance case to exact assertions and raw execution evidence. |

## 6. M5 — Trusted Host / projections / admin / bridge

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M5-01 PublicTask / trusted result | \`src/interactive/trusted-host.mjs\` provides allowlisted \`getPublicAgentTask()\`; \`coordinator.mjs\` public frame currently includes terminal State; no separate \`readTrustedTerminalResult\` capability is exposed | \`trusted-host.test.mjs\`: public task excludes State/Host secrets and enforces disclosure; CF-05 source discrepancy remains | **PARTIAL**. Need an explicit public-vs-trusted result API/permission boundary and model-facing adapter test; do not infer a real leak without showing the model receives the Host \`load()\` result. |
| A-M5-02 admin controller / adminTerminate | No \`admin-controller.mjs\`, \`adminTerminate\` export or corresponding trusted admin facade found in current source/types | R2 CF-01; current coordinator/trusted-host exports list only start/complete/resume/load/accept/task | **GAP — P0-A blocker**. Design the independent Host Admin principal, tombstone, audit, CAS race, Program-missing escape path and stale-receipt rejection against frozen V0.6/approved M5 plan before implementation. |
| A-M5-03 reference Host bridge CLI | Current main has \`examples/interactive/s13-chatgpt.workflow.js\` and \`examples/interactive/c01-live-chatgpt.workflow.js\` from PR #11/#12; these are evidence-specific workflows, not a reusable trusted Host bridge CLI or general consumer example | PR #11/#12 merged test/evidence workflows; M6 integration Host fixtures remain under \`tests/integration/\` | **GAP / NOT PROVIDED AS A REUSABLE TRUSTED-HOST EXAMPLE**. Build the minimal short-lived trusted Host bridge after M5 security boundary is resolved; no new npm bin. |
| A-M5-04 tenant/auth/projection/admin tests | \`tests/interactive/trusted-host.test.mjs\`, \`tests/security/host-isolation.mjs\`, \`tests/integration/m6-e2e.test.mjs\` | 16 Trusted Host tests; Linux separate-UID negative test; M6 worker integration | **PARTIAL**. Admin tests cannot pass before A-M5-02; Windows separate-account/ACL/handle-inheritance negatives remain BLOCKED. |

## 7. M6 — CI / package / types / crash / docs / performance

| Task | Current main implementation | Tests/evidence | Status and remaining closure |
|---|---|---|---|
| A-M6-01 package exports/manifest | \`package.json\`, \`scripts/package-files.mjs\`, \`check-package.mjs\`, \`test-package.mjs\`; exports include \`./interactive\`, no extra npm bin | \`tests/package/package.test.mjs\`; updated PR #12/#11 merge-tree CI runs 43181841181 and 43182753787 each passed 7/7 | **CODE-PRESENT / CI-PASS via exact merge-tree matrix**; current-main direct push run 43183321344 was in progress at this snapshot. |
| A-M6-02 TS declarations/consumer | \`types/interactive.d.ts\`, \`tests/types/interactive.ts\`; package consumer imports Interactive runtime subpath | \`scripts/test-types.mjs\`, \`scripts/test-package.mjs\`, \`tests/package/consumer.mjs\`; updated PR #12/#11 merge-tree CI runs passed 7/7 | **CODE-PRESENT / CI-PASS via exact merge-tree matrix**. Verify the TS 5.0.4 minimum remains part of the final release gate. |
| A-M6-03 CI integration | package.json test/verify includes Interactive and integration tests; .github/workflows/ci.yml has 4 OS/Node verify jobs + 2 Linux Host jobs + website | PR #12 merge-tree run 43181841181 passed 7/7; PR #11 merge-tree run 43182753787 passed 7/7. Current main push run 43183321344 (head 81c7839) was in progress at this snapshot. PR #20's previous exact-head run 43174072647 passed 7/7 on its older 606d055 base; PR #20 must be updated and re-run on current main. | **CODE-PRESENT / PR-MERGE-TREE CI-PASS; CURRENT MAIN PUSH CI-IN-PROGRESS**. This does not close M6 native-host/fault/performance gates. |
| A-M6-04 fault/concurrency matrix | \`crash.test.mjs\`, \`m6-e2e.test.mjs\`, \`m6-ledger-boundary.test.mjs\`, \`store.test.mjs\` | Representative process kills, two-process races, M6 host restart and capacity tests | **PARTIAL**. Map full F01–F20 and platform-equivalent cuts; current coverage is not a full matrix PASS. |
| A-M6-05 docs/examples | Interactive maintainer docs exist: docs/interactive.md, docs/interactive-stage2-contract.md, docs/interactive-host-security.md and docs/interactive-s07-capacity.md. PR #11/#12 also add two test-specific workflows under examples/interactive; neither is a reusable trusted Host consumer bridge. No examples/interactive/README.md exists. | docs:examples verifies existing Standard documentation examples; current Interactive material is maintainer guidance plus evidence-specific workflows, not a complete packaged consumer example suite. | **PARTIAL**. Remaining work is a maintained Interactive README, reusable Trusted Host example, consumer-facing docs integration, supported Node/OS/security limits and a consolidated M6 evidence guide. |
| A-M6-06 budget/performance | \`scripts/bench-interactive-load.mjs\` is explicitly diagnostic-only; S07 capacity tests cover checkpoint/receipt limits | \`s07-capacity.test.mjs\` 13 tests; benchmark records load/cache timings and Journal revisions | **PARTIAL**. No dedicated \`budget-perf.test.mjs\` or full write-amplification/concurrency/WAL/FULL benchmark evidence; add bounded metrics without inventing SLA. |

## 7.1 PR #11 / #12 final evidence review (merged)

Both PRs are now merged into current main. Their unique contributions are documentation, fixtures, example workflows and tests; neither changes production Core source, Program ABI or Store schema.

### PR #12 — C01–C24 acceptance assets

- Merge commit: \`8ccb53055f640539fd86c524f079867fbdb12713\`.
- Exact updated PR-head Actions run [43181841181](https://github.com/devcodex-labs/flowkit/actions/runs/43181841181): **7/7 jobs passed**. The four Ubuntu/Windows × Node 22/24 matrix jobs passed; Node 22 cells reported 386/386 tests.
- Scripted protocol layer: \`complex-c01-c12.test.mjs\` contains 14 tests covering C01–C04, C10–C11 and C13–C20. C13–C20 are scripted Trusted Host tests with zero model calls.
- Recorded-model-response layer: \`c01-live-chatgpt.test.mjs\` replays five ChatGPT-authored responses against five exact Pending identities (four dependent Agent nodes plus a deliberate invalid-schema review response and corrected retry). The CI log records \`execution=CHATGPT_AUTHORED_FIXTURE_REPLAY\`, five recorded responses, five request IDs, Program hash, final State hash, terminal success and 39 Journal revisions. This is M-level recorded response evidence, not live model API execution inside CI or native provider/session attestation.
- Normal CI requires all five response fixtures. Only explicit \`FLOWKIT_C01_PREPARE=1\` allows an incomplete preparation run. A missing fixture cannot silently produce a green normal CI test.
- The test creates a fresh temporary SQLite DB per CI run and tests close/reopen within that run; it does not share one physical DB across separate model turns/Actions runs.
- C21 remains PARTIAL; C22 has protocol/OS-UID evidence but native Host remains BLOCKED; C23 remains M/N BLOCKED; C24 remains CI/compatibility partial with N BLOCKED. C12/S13 remains BLOCKED.
- C04's dedicated fixture uses retries=1 (two attempts); default retries=2 / three attempts is covered separately by main Coordinator tests.

### PR #11 — ChatGPT-authored response bound to FlowKit Pending (M-level)

- Merge commit: \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\`.
- Exact updated PR-head Actions run [43182753787](https://github.com/devcodex-labs/flowkit/actions/runs/43182753787): **7/7 jobs passed**. The four Ubuntu/Windows × Node 22/24 matrix jobs passed; Node 22 cells reported 387/387 tests.
- The test publishes an actual FlowKit Public Pending, then binds a ChatGPT-authored response delivered through an authenticated GitHub tool action to the exact \`runId/requestId/taskDigest\`; the trusted Host subsequently verifies, signs its Host receipt, commits by CAS, checks duplicate Ack and performs same-phase SQLite close/reopen.
- **This is not a FlowKit native JavaScript-tool invocation and not native S13.** The model response returns through a GitHub tool action; there is no independent provider/session attestation, Grok Build/Codex native tool provenance or cross-UID model isolation. See \`docs/interactive-chatgpt-response-evidence.md\`.
- Phase 1 and Phase 2 are separate Actions invocations with separate temporary SQLite databases. Phase 2 reconstructs the deterministic Pending and verifies exact identity; it does not continue the physical DB from Phase 1.
- Normal CI requires the complete response fixture. Only explicit \`FLOWKIT_S13_PREPARE=1\` permits a preparation-only Pending run.

**Combined decision:** retain both PR contributions in main as P/M-level evidence assets. Neither merge passes native Grok C12/S13/T27, Windows Secure Host, or overall P0-A acceptance.


## 8. Cross-cutting findings and corrected interpretation

| Finding | Current conclusion |
|---|---|
| CF-01 | P0-A admin termination is absent; this is a real implementation gap. |
| CF-02 | Factory API is present; whether top-level signatures are required is a formal V0.6 §4/approval decision, not a simple missing capability. |
| CF-05 | Terminal State is present in Coordinator/Host load frame; PublicTask itself is allowlisted. The separate trusted result-read permission and model-facing adapter boundary remain unresolved. Do not claim a proven model leak without a path showing the model receives Host load output. |
| CF-06 | Current Store interface is synchronous; compare exact frozen async Store contract and approved implementation decisions before changing it. |
| CF-07 | Fixed in merged #18; keep both R04 tests. Updated PR #12/#11 merge-tree CI runs 43181841181 and 43182753787 passed all four Ubuntu/Windows × Node 22/24 verify cells, including the R04 regressions; direct current-main push run 43183321344 was in progress at this snapshot. |
| CF-08 | Reproduced in local probe; not fixed and not shown to bypass P0-A feature gate. Add an isolated regression and minimal fix. |
| F-02 | Grok native MCP/tool_call start-input binding and truncation behavior remain PARTIAL/BLOCKED. |
| F-04 | Cross-principal Windows inherited-handle / service-token tests remain BLOCKED; Linux UID test alone is insufficient. |
| F-07 | Formal source recovery is closed; full T01–T34 and V0.6 §§1–18 conformance decision remains pending. |

## 9. Phase 0 conclusion and next actions

1. The 31-task inventory shows M1/M2/M4 have broad implementation surfaces, but source presence is not final acceptance. M3's Run→Program retain and Genesis association is atomic through the Run FK + Genesis transaction; the async Store contract discrepancy remains open. M5 has material P0-A gaps (admin termination and reference bridge) plus result-projection closure. M6 still lacks exact-current-main CI, complete fault/performance evidence and native-host acceptance.
2. Do not repeat M1–M5 wholesale. Work only on proven gaps and incomplete evidence.
3. Complete the formal V0.3/V0.6-R5 conformance matrix before changing CF-02/05/06 public contracts.
4. Resolve CF-01 and the M5 result projection boundary before declaring P0-A complete.
5. Run H3-01 and H3-05 under their approved independent security scope; H3-02 requires its tool-capability probe; H3-03 follows H3-02; H3-04 follows H3-03 + H3-05.
6. Keep local verification and GitHub Actions statuses separate. New PR #12/#11 runs 43181841181 and 43182753787 completed 7/7; current main push run 43183321344 was still in progress. Five stale queued runs remain on the old design branch with zero jobs; they are not evidence that current PR/main jobs are stuck.

**This crosswalk does not modify the approved plan or authorize changing frozen semantics. All task statuses remain subject to independent review and raw evidence.**
