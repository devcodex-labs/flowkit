# FlowKit Phase 0 — Current Baseline & CI Fallback

**Snapshot:** 2026-11-12 (UTC+8)  
**Repository:** \`devcodex-labs/flowkit\`  
**Snapshot base:** \`606d055d5f02451fea0b30294889d740ef370d49\`  
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

- Current main at snapshot: \`606d055d5f02451fea0b30294889d740ef370d49\`.
- M1–M5 implementation surfaces are present on main. Their presence is not a blanket completion claim for every task or security gate.
- PR #16 (R1/R2 audit docs), PR #19 (local verification evidence) and PR #18 (R04 fix + regression tests) are merged.
- PR #17 is closed without merge; its two deliberately failing R04 regression tests are included in #18.
- PR #7 is closed without merge; its M6 work was superseded by #13.
- PR #11 and #12 remain open Draft and must be reviewed on their own merits.

### 2.2 Remaining open PRs

| PR | Branch | HEAD | Base recorded by PR | Current diff against main | Decision |
|---|---|---|---|---|---|
| [#11 ChatGPT tool bridge](https://github.com/devcodex-labs/flowkit/pull/11) | \`test/s13-chatgpt-tool-bridge\` | \`eac72c66a33e8a6411aa8748240abe9146d0c4c0\` | historical \`ea2bb108\` | 5 commits ahead / 6 behind; 4 unique files | Rebase/update, review actual tool-turn evidence and security boundary; do not equate with native Grok S13 |
| [#12 C01–C24 acceptance](https://github.com/devcodex-labs/flowkit/pull/12) | \`test/interactive-complex-c01-c12-acceptance\` | \`c6b42a36050d885a37831cbdf0839428b2052c85\` | historical \`ea2bb108\` | 15 commits ahead / 6 behind; 8 unique files | Rebase/update, review scripts, matrices and evidence; merging scripts does not pass C12/S13 |

No PR #11/#12 content is to be discarded merely to make branch cleanup easier. Extract/merge only reviewed assets; explicitly mark native-host gaps BLOCKED.

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

- Latest successful main run before the three PR merges: [43146363166](https://github.com/devcodex-labs/flowkit/actions/runs/43146363166), commit \`13d573c5ddc4a0ed3502401589c581799c96c5d2\`, 7/7 jobs successful. It is **not** the current \`606d055\` HEAD.
- The three rapid main pushes from merges #16/#19/#18 created runs [43161068943](https://github.com/devcodex-labs/flowkit/actions/runs/43161068943), [43161142187](https://github.com/devcodex-labs/flowkit/actions/runs/43161142187) and [43161214780](https://github.com/devcodex-labs/flowkit/actions/runs/43161214780). All now report \`completed/cancelled\`; the first two were superseded in the same-ref concurrency window.
- Run 43161214780 is attempt 2; all seven jobs currently report cancelled. Accessible run metadata does not establish why its final attempt was cancelled. Do not label it queued or failed.
- Five older runs (43095884874, 43095901291, 43095937558, 43096034832, 43096045021) remain \`queued\` on the old \`design/trusted-host-security-v2-20261111\` branch. Each currently has zero jobs and no associated open PR in the run metadata. Treat them as stale queued events, not as evidence that the current main workflow has active jobs waiting for a runner.
- At the time of this snapshot, there are 5 queued runs, 0 in-progress runs. The latest main run is cancelled, not queued.

GitHub Status currently reports all systems operational. The Nov 11 incident affecting Actions/Pages/Copilot was marked resolved at 21:21 UTC, with GitHub stating that the Actions backlog had been fully processed. Therefore, do **not** assert a current global GitHub outage without new evidence. A fresh isolated workflow run is required to test current scheduling on this repository.

Official status: https://www.githubstatus.com/  
Official Actions billing/usage: https://docs.github.com/en/actions/concepts/billing-and-usage

The repository is now public. GitHub documents standard GitHub-hosted runner usage as free for public repositories. This makes private-repository included-minute exhaustion an unlikely explanation for current standard hosted-runner scheduling; repository/org policy and stale events still require evidence. Do not infer a billing cause.

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
| CF-07 start input snapshot | FIXED in merged #18 | Retain regression tests; local Windows Node 22/24 PASS; Linux/CI matrix still outstanding |
| CF-08 compile options snapshot | REPRODUCED / not fixed | Add isolated regression, then minimal fix and re-run compiler/feature-gate tests |
| F-02 native Grok tool binding | PARTIAL/BLOCKED | H3-02 capability probe before adapter implementation |
| F-04 cross-principal handle isolation | PARTIAL/BLOCKED | H3-05 Windows/Linux OS negative tests |
| F-07 formal contract provenance | Source recovery CLOSED; conformance review PENDING | Complete T01–T34 / §§1–18 traceability; do not mark overall conformance PASS yet |

## 7. Phase 0 work order

1. Use this document as the current snapshot; keep historical audit reports immutable.
2. Build the 31-row A-M1-01 through A-M6-06 task crosswalk against current source files, tests, package exports, workflow and raw evidence. Distinguish implementation presence from acceptance PASS.
3. Update the roadmap, formal source register and conformance plan to the current main SHA, preserving their historical baseline notes.
4. Rebase/review PR #11 and #12; extract only validated test assets and evidence.
5. Continue formal V0.3/V0.6-R5 contract conformance and CF-01/02/05/06/08 closure.
6. Only after Phase 0 inventory is complete, proceed through the corrected Phase 1/2 sequence; H3-01 and H3-05 may proceed independently of Grok tool PoC, while H3-02/03/04 and Phase 4 retain their stated dependencies.

**No production semantics, ABI, Store schema, confirmed requirements, npm publication or deployment is changed by this baseline record.**
