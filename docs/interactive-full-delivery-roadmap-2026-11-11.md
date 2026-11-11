# FlowKit Interactive — Full Delivery Roadmap & Closure Ledger

**Baseline date:** 2026-11-11 (UTC+8)  
**Repository:** `devcodex-labs/flowkit`  
**Frozen main:** `ea2bb10893a9be2e5de3561fc9a660a6977ae15c`  
**Planning branch:** `fix/m6-current-main-e2e-20261111`

> This document records the approved end-to-end route from the current M6/P0-A state through P0-B, P1, P2 and production delivery. It is a roadmap and traceability ledger, not evidence that deferred features have been implemented or passed.

## 1. Current baseline

### 1.1 Main and CI

- Main HEAD: `ea2bb10893a9be2e5de3561fc9a660a6977ae15c`.
- Main CI run: [42954859078](https://github.com/devcodex-labs/flowkit/actions/runs/42954859078), completed successfully.
- M1–M5 implementation surfaces and S07 capacity work exist on main. Their presence is not a blanket claim that every M6/native-host gate is passed.
- PR #8, #9 and #10 are merged.
- PR #7 is open Draft, head `e1e15a70356e53401288d393aa7527c6723fe797`, based on an older main snapshot `c873e3edf0f1a78b13178966cdeb408391755170`. Its M6 tests need to be revalidated against current main.
- PR #12 is open Draft, head `c6b42a36050d885a37831cbdf0839428b2052c85`, based on `ea2bb10893a9be2e5de3561fc9a660a6977ae15c`. Its scripted C13–C20 tests and documentation CI passed; this does not pass C12/S13 native-host gates.

### 1.2 Evidence classes

- **P — Protocol/scripted:** real FlowKit compiler, generated Program, Host, SQLite and protocol; Agent responses may be scripted. Proves protocol behavior only.
- **M — Live model:** a real model session produces the result for an actual Pending. Requires per-turn request identity, response evidence and Host trace.
- **N — Native host attested:** native host tool invocation and session/process provenance are independently verified; OS/Host security boundary is demonstrated.
- **D — Deferred by approved scope:** intentionally belongs to a later milestone; it is not a defect in the current milestone, but must remain in the ledger.

Never count P evidence as M or N. Never count a CI replay of recorded model turns as a new live model session.

## 2. Complete milestone route

| Phase | Scope | Required exit condition | Current state |
|---|---|---|---|
| 0 | Baseline freeze and traceability | Immutable baseline, full requirement/Finding/test ledger and evidence index | In progress on this branch |
| 1 | M6 current-main test compatibility | PR #7 tests run against frozen current main; no Core semantic change hidden in test repair | Pending |
| 2 | Trusted Host security design | Approved threat model, OS identity, IPC, key custody, Store ownership and provenance contract | Pending |
| 3 | Trusted Host security implementation | Windows and Linux isolation, access-denial tests and secure Host operations pass | Pending |
| 4 | Native Grok Build JS tool bridge | Grok Build itself calls FlowKit JS tools through Pending → model completion → JS submit/resume → Terminal | Pending |
| 5 | M6 live-model complex acceptance | Applicable C01–C24 cases classified and evidenced at P/M/N levels; all M6 blockers closed | Pending |
| 6 | M6 independent review and P0-A closure | Dot review, full CI, PR integration, all P0-A hard gates passed | Pending |
| 7 | P0-B sequential semantics | Action, Verification, Human, Loop, Cancel and context/result semantics pass S08–S12 and applicable T requirements | Deferred |
| 8 | P1 Parallel all_succeeded | Dedicated fail-fast/parallel contract, recovery and concurrency acceptance pass | Deferred |
| 9 | P2 Parallel any | Winner election, loser cancellation, late results and recovery pass | Deferred |
| 10 | Production compatibility and release | Host matrix, SDK/types/CLI/package/docs/performance/security/release gates all pass | Deferred |

## 3. Phase 0 — Baseline and traceability

1. Freeze main SHA, PR heads, dependency lock hash, Node/npm versions and CI run IDs.
2. Maintain a separate code branch for each implementation/fix; do not edit main directly.
3. Build a traceability index connecting T01–T34, S01–S14, C01–C24, N1–N13, R1/R2, R01–R22, source files, tests, CI jobs and evidence.
4. Every item has a state: PASS, FAIL, PARTIAL, BLOCKED or DEFERRED.
5. Every BLOCKED item must state the missing prerequisite, owner and re-entry condition.
6. Every DEFERRED item must name its target phase; it cannot disappear from the ledger.
7. Every PASS must cite an exact commit, executable test or raw evidence. A PR description alone is not evidence.

## 4. Phase 1 — M6 current-main test compatibility

1. Rebase/recreate the M6 test changes from current main, rather than relying on the stale PR #7 base.
2. Fix the temporary project fixture so the project-root contract is tested correctly:
   - create a temporary `package.json` and verify default ancestor discovery; and
   - separately verify explicit `projectRoot` override.
3. Include `tests/integration/*.test.mjs` in the normal test command.
4. Run the M6 cross-process tests and Linux OS-user isolation job.
5. Run build, full `npm run verify`, docs examples and website checks.
6. Keep the worker explicitly labelled scripted; do not present it as Grok/Codex/Claude provider integration.
7. If a production Core defect is found, create a separate minimal Core-fix PR and rerun relevant regressions.
8. Do not merge the old PR #7 or the replacement PR until review and exact-HEAD CI pass.

## 5. Phase 2 — Trusted Host security design

Freeze a Host threat model before implementation:

- Assets: Host signing key, SQLite DB/WAL/SHM, Program allowlist, policy/binding manifests, private State, provider/session evidence.
- Principals: user, Grok Build/model process, Host process, other local processes, other tenants, CI and administrators.
- Trust boundaries: OS identity/token, filesystem ACL, IPC endpoint, provider/session transport and Host signer.
- Attack paths: same-user process, child process, shell/tool execution, path traversal/symlink, DB/WAL access, key extraction, IPC spoofing/replay, stale request, cross-tenant run, policy drift and log leakage.
- Host owns Program verification, authorization, private Store, signer and receipt acceptance.
- Model receives only the minimum public task and submits result data through a constrained operation. It never receives the signer, raw Store, Coordinator or unrestricted Host API.
- Define Windows and Linux deployment profiles separately. Linux UID isolation is not evidence of Windows ACL isolation.
- Define what can and cannot be proven about native provider/session origin. A self-declared session ID or Host signature over unverified model JSON is not provider-origin proof.
- Provider-signed evidence may be used if genuinely available, but is not assumed to be the only possible design. Any alternative Host-owned transport must state its exact assurance level and limits.
- Human approval remains unavailable/blocked unless a model-unwritable trusted human decision channel is independently verified.

Deliverables: threat model, trust topology, IPC contract, key custody design, provider/session provenance design, Windows/Linux deployment designs, attack matrix and acceptance criteria. Independent review must close all design findings before Phase 3.

## 6. Phase 3 — Trusted Host security implementation

1. Implement distinct OS identities or an equivalently strong restricted token boundary.
2. Restrict Host private directory, key and SQLite DB/WAL/SHM to the Host principal.
3. Expose only constrained IPC operations with explicit authorization and input/output schemas.
4. Ensure the model cannot access raw DB, key, signer, Coordinator or private State.
5. Add Windows ACL and Linux UID/GID integration tests. A test that exits because the platform is unsupported is BLOCKED, not PASS.
6. Test read, write, replace, symlink, path traversal, process spawning, inherited handles/environment, IPC spoofing, replay, wrong tenant and unauthorized API calls.
7. Verify Host can still sign, commit, resume and recover after model access is denied.
8. Record raw OS identity, access-denied evidence, process tree, IPC identity and Store integrity.
9. Repeat after reboot/restart and on the supported Node matrix.

Exit: security tests pass on both supported OS families, with no same-principal bypass. If the actual Grok Build execution environment cannot be isolated from Host secrets, keep native secure-host acceptance BLOCKED and do not expose Host secrets to that model.

## 7. Phase 4 — Native Grok Build JavaScript bridge

1. Use direct Grok Build as the first native host; ACP is optional and not a prerequisite.
2. Verify the real Grok Build process/session and available JS execution/tool interface.
3. Register or expose the FlowKit JS tool through the supported native tool mechanism; do not substitute file polling or an external harness that advances every step.
4. Freeze tool operations and schemas (names to be reconciled with the existing SDK contract): start, get Pending, submit result, resume, status and result.
5. The Host owns Program execution, Pending creation, disclosure, result verification, signing, CAS and SQLite.
6. Grok Build must call the JS tool, inspect the returned Pending, perform the real Agent work, call the JS tool to submit, and call again to continue until Terminal.
7. Preserve raw native tool invocation events and bind them to runId/nodeId/requestId/attempt/programHash/response digest and Host acceptedRevision.
8. Verify that a model cannot forge Host provenance by editing a session ID, JSON file or self-asserted receipt.
9. Keep provider-origin assurance distinct from Host-observed process/transport assurance; document any residual limitation.
10. Do not implement a Grok-only workflow semantic. The adapter is host-specific; FlowKit Core remains model-neutral.

Exit: repeatable native tool loop, Host-controlled transitions, secure process boundary and independently reviewable evidence.

## 8. Phase 5 — M6 complex live-model acceptance

- Preserve the frozen C01–C24 definitions and original pass/fail criteria.
- For each scenario, declare required evidence tier P, M or N.
- Reuse existing P-level tests; do not waste model calls repeating scripted cases.
- Live-model tests must include real Pending, model output, request identity, tool trace and Host acceptance.
- Native-host/security tests require N evidence; a real model answer alone is not enough.
- Prioritize C04, C05, C06, C07, C08, C09, C12, C22 and C23.
- C05: kill/restart around Pending publication, model completion, receipt acceptance, validation, State commit and next Pending; resume the same Run.
- C06: two independent live model sessions contend for the same Pending; identical replay and conflicting result cases.
- C04: separate controlled invalid-output injection from naturally generated invalid model output and retry exhaustion.
- C09: distinguish unverified oversized receipt, trusted provider output overflow and valid receipt causing Checkpoint capacity overflow.
- C22: prompt injection and attempts to read/modify Host assets.
- C23: a combined multi-Agent Run with failure, retry, Host crash/recovery and competing submitters, with exact state/ledger invariants.
- C21 cross-OS/Node DB migration remains an enhancement unless the approved contract elevates it; N6 durable artifact/SDK upgrade compatibility must still be closed before long-running production delivery.

Exit: every C item is PASS, FAIL, PARTIAL, BLOCKED or explicitly DEFERRED with owner and re-entry condition. No missing row.

## 9. Phase 6 — M6 review, P0-A closure and merge

1. Dot independently checks exact code SHA, Program hash, raw native tool events, Pending/response, Host traces, signed statements, SQLite, Journal hash chain and OS evidence.
2. Run exact-HEAD CI: Ubuntu 24.04 and Windows 2025 × Node 22.13.0 and 24.22.1.
3. Run Linux cross-UID and Windows ACL isolation jobs independently.
4. Run build, npm verify, package/tarball, types, CLI, docs examples, website and Standard regressions.
5. Resolve every M6 blocker and rerun the relevant scenario plus full regression.
6. PR #12 may be merged only as the scripted matrix/docs contribution after its own review; its merge does not pass C12/S13.
7. PR #7 or its current-main replacement may be merged only after M6 integration CI and security gates pass.
8. Do not release a version until P0-A release criteria are explicitly met.

## 10. Phase 7 — P0-B sequential workflow

Before implementation, close applicable design findings and freeze semantics for:
- N2: kind-specific Pending with model-visible task and trusted executor context.
- N4: Human provenance; model-generated human approval is rejected.
- N7: stable host-visible terminal result/state API.
- N13: Standard/Interactive semantic-difference register.
- N5: namespace/tenant isolation.
- N6: immutable artifact retention and SDK/semantics-version upgrade policy.
- N8/N9/N10/N11/N12 as applicable to Program ABI, feature gate, package contract, Agent Pending parity and transition/reconcile identity.

Implement and validate in this order:
1. Action Patch and writes allowlist.
2. Action receipt loss, indeterminate and reconcile with stable operationId.
3. Verification true/false/invalid and candidate-state semantics.
4. Action → Verification → onFailure paths and contextError persistence.
5. Human reject → revise → approve with trusted human provenance.
6. Loop iteration limits, final failure and restart recovery.
7. Skill pinning/drift behavior.
8. Cancel, terminal race and late receipt rejection.
9. Stable terminal result and contextError reads.
10. Standard/Interactive T33 row-by-row parity/difference review.

Exit: applicable T15–T23, S08–S12, T31/T32 and T33 checks pass. Any unsupported host Human channel stays BLOCKED, not silently simulated.

## 11. Phase 8 — P1 Parallel all_succeeded

Before code, separately approve the P1 contract and fail-fast semantics (historical TD-017):
- multiple Pending creation and durable branch identity;
- branch scheduling and dispatch barriers;
- all_succeeded aggregation;
- one branch failure and other in-flight branch behavior;
- stop-new-dispatch versus already-dispatched work;
- state write-set conflict and merge policy;
- duplicate/late receipts;
- crash/restart with partially completed branches;
- external side-effect reconciliation (no false exactly-once or rollback claim).

Implement Program/IR, Coordinator, Store and Host support, then test independent branches, simultaneous success/failure, CAS races, recovery and Standard parity. Do not implement P2 any semantics in this phase.

## 12. Phase 9 — P2 Parallel any

Freeze and implement separately:
- deterministic winner election when multiple branches succeed;
- atomic terminal CAS;
- loser cancellation and already-running side effects;
- late result rejection/ack semantics;
- write conflicts and winning-branch state;
- crash/restart during winner election and cancellation;
- external side-effect reconciliation.

Do not infer any semantics from all_succeeded or claim that cancelling a local process rolls back an external operation.

## 13. Phase 10 — Production compatibility and release

1. Host adapters: ChatGPT, Codex, Claude Code and Grok Build, each with a declared capability/limitation matrix.
2. Core remains model/host neutral; adapters do not change workflow semantics.
3. Verify SDK JS API, TypeScript declarations, exports, CLI, package/tarball and supported Node versions.
4. Verify immutable Program ABI, artifact storage, resume after SDK update and semantics-version compatibility.
5. Complete install, quick-start, DSL, Agent, Host, security, recovery, Action/Human/Loop/Parallel, error and API docs.
6. Verify docs against source and executable examples.
7. Run performance/stability tests: long chains, many Runs, concurrency, WAL/FULL, Checkpoint size, Journal growth, recovery loops and large outputs.
8. Complete security review, changelog, SemVer, tag, npm release, website and release notes.
9. Re-run installation/upgrade verification against the published artifact.

## 14. Global traceability ledger

### 14.1 Frozen requirement and acceptance identifiers

| Family | Coverage | Closure rule |
|---|---|---|
| T01–T14 | P0-A core semantics | P0-A hard gates |
| T15–T23 | P0-B sequential semantics | P0-B hard gates |
| T24, T26 | P1 parallel all_succeeded/concurrency | P1 hard gates |
| T25 | P2 parallel any | P2 hard gates |
| T27–T34 | host, process, compatibility, parity and long-run requirements | assigned to the relevant phase; no silent omission |
| S01–S07 | P0-A protocol/security/capacity | P0-A |
| S08–S12 | P0-B Action/Verification/Human/Loop/Cancel | P0-B |
| S13 | native host loop | Phase 4 / M6 |
| S14 | package, types, CI, compatibility and Standard regression | every release gate |
| C01–C24 | current complex acceptance matrix | Phase 5, tier P/M/N explicit |
| N1–N13 | design review findings | closed or explicitly deferred before dependent phase |
| R1/R2, R01–R22 | historical review/falsification cases | preserved as regression and review evidence |

### 14.2 Finding ownership

| Finding | Planned closure |
|---|---|
| N1 | verify current P0-A deterministic-error exit; fix if any discrepancy |
| N2 | Phase 7 P0-B kind-specific Pending/executor context |
| N3 | verify current Program ABI/InteractiveRuntime; close any remaining contract gap before P0-A release |
| N4 | Phase 7 Human provenance; shell-only model approval remains blocked |
| N5 | Phase 7 tenant/namespace boundary before production multi-tenant use |
| N6 | Phase 7 durable artifact and SDK upgrade/resume policy |
| N7 | Phase 7 public host-visible terminal result |
| N8 | verify generated Program zero-import rule before release |
| N9 | verify unsupported featureStage rejection before release |
| N10 | package/bin/exports checks before release |
| N11 | Agent Pending parity before P0-A final compatibility sign-off |
| N12 | parallel/transition/reconcile identity before P1 |
| N13 | Standard/Interactive difference register before P0-B parity sign-off |

This assignment is a tracking map, not an assertion that the finding is already fixed or that a new API is approved. Any requirement-stage change requires the user's approval.

### 14.3 Global release rule

No stage is complete while any applicable requirement, acceptance case, historical Finding or regression remains unclassified. Every unresolved item must be either:
- fixed and re-tested;
- BLOCKED with concrete missing evidence and re-entry condition; or
- DEFERRED to an approved later phase with a named milestone.

A phase cannot pass by deleting a test, weakening an assertion, changing the evidence tier or combining results from different commits.

## 15. Current next actions

1. Complete Phase 0 baseline/traceability.
2. Port PR #7 M6 integration tests onto the frozen current main in a new branch.
3. Fix project-root fixture correctly and add default-discovery plus explicit-override tests.
4. Re-run exact-HEAD M6 integration, full verification and platform CI.
5. Independently review and then proceed to Phase 2 Trusted Host security design.

**No merge, main modification, release or production semantic change is authorized by this roadmap.**
