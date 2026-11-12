# FlowKit Phase 0 — Current Baseline & CI Fallback

**Snapshot:** 2026-11-12 (UTC+8)  
**Repository:** \`devcodex-labs/flowkit\`  
**Snapshot base:** \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\`  
**Purpose:** Establish one current status record and a reproducible local verification path while GitHub Actions behavior is investigated. This document does not modify the approved V0.3/V0.6-R5 contract, P0-A implementation plan, Program ABI, Store schema, or product semantics.

## 1. Authority and status vocabulary

Authority order remains:

1. Requirements V0.3 (confirmed; T01–T34).
2. Technical Design V0.6-R5 (confirmed; §§1–18).
3. P0-A Implementation Plan V0.1 (confirmed 2026-11-10; M1–M6, 31 file-level tasks).
4. Trusted Host V2 (PR #14; security design supplement, not a replacement for V0.3/V0.6-R5).
5. Current \`main\` and reproducible tests.
6. Roadmaps, audit reports and local verification reports as evidence indexes, never as substitutes for the confirmed source documents.

Use only: \`PASS\`, \`FAIL\`, \`PARTIAL\`, \`BLOCKED\`, \`NOT-EXECUTED\`, \`NOT-IN-SCOPE\`, \`DEFERRED\`. A local PASS is not a GitHub Actions PASS; a scripted host fixture is not a native-host PASS.

## 2. Current repository and PR baseline

### 2.1 Main

- Current main at snapshot: \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\`.
- M1–M5 implementation surfaces are present on main. Their presence is not a blanket completion claim for every task or security gate.
- PR #16 (R1/R2 audit docs), PR #18 (R04 fix + regression tests), PR #19 (local verification evidence), PR #12 (C01–C24 acceptance assets) and PR #11 (ChatGPT Pending response evidence) are merged.
- PR #17 and PR #7 are closed without merge; their applicable test work was superseded by #18 and #13 respectively.
- PR #20 is the remaining open Draft; its five documentation files are refreshed against current main 81c7839, and exact-head run 43185112963 passed 7/7.

### 2.2 Remaining open PRs

| PR | Branch | HEAD | Current diff against main | Decision |
|---|---|---|---|---|
| [#20 Phase 0 baseline and CI fallback](https://github.com/devcodex-labs/flowkit/pull/20) | \`docs/phase0-current-baseline-ci-fallback-20261112\` | \`c6bff96de2d666dd483499bd4f09009392cd40c3\` (pre-refresh) | Five documentation files; branch is two commits behind current main after #12/#11 merges | Refresh baseline, correct stale PR/CI statuses, rerun exact-head CI, then final review/merge |


## 3. Verified local evidence already available

PR #19 records the following local Windows evidence:

- Windows NT 10.0.26200.0.
- Node v24.22.2: \`npm run verify\` — 371/371 tests PASS; type, package check and package consumer steps exit 0.
- Node v22.22.2: \`npm run verify\` — 371/371 tests PASS.
- Documentation examples, docs check (after LF normalization), docs build and selected impact/security probes PASS.
- Before the fix, the two R04 tests failed reproducibly on Node 22.22.2 and 24.22.2; after #18, both passed.
- CF-08 was separately reproduced as a non-deterministic compile-options rejection and remains unfixed.

Limits: these Node versions are not the exact CI pins (22.13.0 and 24.22.1); Ubuntu was not run; Windows ACL / separate OS identities, native Grok tool events, C12/S13/T27 and complete Host Outbox recovery were not proven. Do not upgrade these items to cross-platform or native-host PASS.

## 4. GitHub Actions diagnosis at this snapshot

### 4.1 Workflow shape

\`.github/workflows/ci.yml\` currently has seven jobs:

- 4 \`verify\` matrix jobs: Ubuntu 24.04 / Windows 2025 × Node 22.13.0 / 24.22.1.
- 2 Linux Host OS-user isolation + M6 integration jobs: Node 22.13.0 / 24.22.1.
- 1 website build/check job.

The workflow uses:

\`\`\`yaml
concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
\`\`\`

New pushes to the same ref can cancel older runs. This is intentional stale-run suppression, but multiple rapid pushes to \`main\` can cancel earlier main runs before their seven jobs finish.

### 4.2 Observed run facts

- Main run [43182546605](https://github.com/devcodex-labs/flowkit/actions/runs/43182546605) passed 7/7 on commit \`8ccb53055f640539fd86c524f079867fbdb12713\` after PR #12 merged.
- PR #11 exact updated-head Actions run [43182753787](https://github.com/devcodex-labs/flowkit/actions/runs/43182753787) passed 7/7 on merge tree \`c9b6033c8302cbb205f251f68aba2f45222d7191\`; PR #12 exact updated-head run [43181841181](https://github.com/devcodex-labs/flowkit/actions/runs/43181841181) passed 7/7. Both include the approved current-main implementation and all four Ubuntu/Windows × Node 22/24 verify jobs.
- Current main \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\` run [43183321344](https://github.com/devcodex-labs/flowkit/actions/runs/43183321344) completed 7/7. Refreshed PR #20 exact-head run [43185112963](https://github.com/devcodex-labs/flowkit/actions/runs/43185112963) also completed 7/7.
- PR #20's prior exact-head run [43174072647](https://github.com/devcodex-labs/flowkit/actions/runs/43174072647) passed 7/7 on the older \`606d055\` baseline. PR #20 is being refreshed to \`81c7839\`; its new exact-head run is the final Phase 0 CI gate.
- Five old runs (43095884874, 43095901291, 43095937558, 43096034832, 43096045021) remain queued on the obsolete design branch with zero jobs and no open PR. Treat them as stale events, not as active current-main work.
- New PR/main runs are now being scheduled and completing; the earlier repository-specific queue symptom has recovered for current work. The five old zero-job records are separate cleanup noise.

GitHub Status currently reports all systems operational. The Nov 11 incident affecting Actions/Pages/Copilot was marked resolved at 21:21 UTC, with GitHub stating that the Actions backlog had been fully processed. Therefore, do **not** assert a current global GitHub outage without new evidence. A fresh isolated workflow run is required to test current scheduling on this repository.

Official status: https://www.githubstatus.com/  
Official Actions billing/usage: https://docs.github.com/en/actions/concepts/billing-and-usage

The repository is now public. GitHub documents standard GitHub-hosted runner usage as free for public repositories. This makes private-repository included-minute exhaustion an unlikely explanation for current standard hosted-runner scheduling; repository/org policy and stale events still require evidence. Do not infer a billing cause.

### 4.3 PR #11 / #12 final evidence review

**PR #12 — C01–C24 acceptance assets (merged):**
- Merge commit \`8ccb53055f640539fd86c524f079867fbdb12713\`; exact updated-head run [43181841181](https://github.com/devcodex-labs/flowkit/actions/runs/43181841181) passed 7/7.
- The scripted suite covers C01–C04, C10–C11 and C13–C20. The five ChatGPT-authored responses are recorded fixtures replayed through FlowKit; they are not live model API calls inside CI.
- Normal CI requires all five fixtures; only explicit \`FLOWKIT_C01_PREPARE=1\` permits preparation-only execution. C12/S13, C22/C23 native-host gates remain BLOCKED.

**PR #11 — ChatGPT Pending response evidence (merged):**
- Merge commit \`81c7839e9f0abe6f4db20d0fc242253b0baff0ea\`; exact updated-head run [43182753787](https://github.com/devcodex-labs/flowkit/actions/runs/43182753787) passed 7/7.
- The experiment publishes a real FlowKit Pending, binds a ChatGPT-authored response delivered via a GitHub tool action to exact \`runId/requestId/taskDigest\`, and then exercises trusted Host signing/CAS, duplicate Ack and same-phase SQLite restart.
- This is M-level recorded response evidence, **not** a FlowKit native JS-tool invocation or native S13. Phase 1/2 use separate temporary DBs; there is no independent provider/session attestation.
- Normal CI requires the complete response fixture; only explicit \`FLOWKIT_S13_PREPARE=1\` permits preparation-only execution.

Both PRs are merged as test/evidence contributions only. They do not close native Grok C12/S13/T27 or overall P0-A acceptance.

## 5. CI outage / queue fallback policy

### 5.1 Continue development without pretending CI passed

When Actions is unavailable or a run is cancelled/queued:

1. Continue source review, requirement mapping, implementation and unit-level work in a scoped branch.
2. Run the same repository scripts locally on the exact PR HEAD.
3. Save raw logs and a machine-readable evidence summary.
4. Have a separate reviewer inspect the exact diff and evidence.
5. Keep the GitHub Actions state explicitly \`BLOCKED\` or \`NOT-EXECUTED\`; never relabel local results as CI PASS.
6. Do not repeatedly create meaningless commits to chase a runner. Trigger one clean isolated run after the branch is ready, then inspect its run/job metadata.

### 5.2 Standard local verification commands

Run from a clean worktree at the exact PR HEAD:

\`\`\`bash
node --version
npm --version
git rev-parse HEAD
git status --short
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run docs:examples
npm --prefix website ci --ignore-scripts --no-audit --no-fund
npm run docs:check
npm run docs:build
\`\`\`

Use the exact CI Node pins where possible: 22.13.0 and 24.22.1. Record the actual versions; do not claim exact-matrix coverage if using 22.22.2/24.22.2.

### 5.3 OS coverage

- Windows tests must run on Windows for Windows-specific path, process, ACL, token and handle behavior.
- Linux tests may run locally in Ubuntu 24.04 / WSL2 with distinct OS users for early verification. Label this \`LOCAL-LINUX\`, not GitHub-hosted Ubuntu CI. If the test depends on a hosted-runner-specific behavior, keep it BLOCKED until tested there.
- Do not use a same-UID shell or same-user child process as proof of cross-principal isolation.
- For each OS/Node combination, record: exact commit SHA, OS build, Node/npm version, install command, test command, exit code, TAP summary, log path/hash, and reviewer.

### 5.4 Merge and release gates

- Docs-only PRs can be reviewed and merged using local docs/test evidence if the diff is isolated and no repository rules require a successful Actions check. This does not pass product M6.
- Core/runtime/security PRs require local Windows + Linux evidence appropriate to the changed behavior, raw logs, independent diff review and explicit residual-risk record before any interim merge decision.
- Missing online CI remains \`CI-BLOCKED\`; missing OS profile or native-host proof remains \`BLOCKED\`. Neither can be silently waived to declare P0-A complete.
- P0-A/M6 final closure and release still require the approved four-matrix CI and all applicable security/native-host evidence. Do not bypass branch protection or required checks.

## 6. Current technical findings carried forward

| Finding | Current status | Next action |
|---|---|---|
| CF-01 \`adminTerminate\` | GAP / high-confidence P0-A implementation gap | Reconcile exact V0.6-R5 + approved M5 task, then implement trusted admin controller/tombstone/CAS/audit and race tests |
| CF-02 SDK API shape | OPEN / contract decision required | Compare V0.6-R5 §4 and approval record; do not add public exports based only on illustrative V0.3 examples |
| CF-05 terminal State projection | OPEN / source-confirmed discrepancy | Separate public model projection from trusted result read; test actual model-facing adapter |
| CF-06 Store sync vs async contract | OPEN / source-confirmed discrepancy | Compare V0.6-R5 §5/§8 and approved M3 design; preserve atomic CAS/receipt semantics |
| CF-07 start input snapshot | FIXED in merged #18 | Retain both regression tests; updated PR #12/#11 merge-tree CI and current-main run 43183321344 passed all four Ubuntu/Windows × Node 22/24 verify cells |
| CF-08 compile options snapshot | REPRODUCED / not fixed | Add isolated regression, then minimal fix and re-run compiler/feature-gate tests |
| F-02 native Grok tool binding | PARTIAL/BLOCKED | H3-02 capability probe before adapter implementation |
| F-04 cross-principal handle isolation | PARTIAL/BLOCKED | H3-05 Windows/Linux OS negative tests |
| F-07 formal contract provenance | Source recovery CLOSED; conformance review PENDING | Complete T01–T34 / §§1–18 traceability; do not mark overall conformance PASS yet |

## 7. Phase 0 work order

1. Use this document as the current snapshot; keep historical audit reports immutable.
2. Build the 31-row A-M1-01 through A-M6-06 task crosswalk against current source files, tests, package exports, workflow and raw evidence. Distinguish implementation presence from acceptance PASS.
3. Update the roadmap, formal source register and conformance plan to the current main SHA, preserving their historical baseline notes.
4. PR #11/#12 evidence assets have been independently reviewed and merged; preserve their M/P evidence labels and native-host BLOCKED gates.
5. Continue formal V0.3/V0.6-R5 contract conformance and CF-01/02/05/06/08 closure.
6. Only after Phase 0 inventory is complete, proceed through the corrected Phase 1/2 sequence; H3-01 and H3-05 may proceed independently of Grok tool PoC, while H3-02/03/04 and Phase 4 retain their stated dependencies.

**No production semantics, ABI, Store schema, confirmed requirements, npm publication or deployment is changed by this baseline record.**
