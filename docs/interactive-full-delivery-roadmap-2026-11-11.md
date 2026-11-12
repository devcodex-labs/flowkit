# FlowKit Interactive — Full Delivery Roadmap & Closure Ledger

**Baseline date:** 2026-11-11 (UTC+8)  
**Repository:** `devcodex-labs/flowkit`  
**Historical Phase 0 baseline:** `ea2bb10893a9be2e5de3561fc9a660a6977ae15c`  
**Current main HEAD after PR #14:** `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`  
**Phase 2 design record:** merged via PR #14 (docs-only; formal contract conformance remains conditional)

> This document records the approved end-to-end route from the current M6/P0-A state through P0-B, P1, P2 and production delivery. It is a roadmap and traceability ledger, not evidence that deferred features have been implemented or passed.

## 1. Current baseline

### 1.1 Main and CI

- Current main HEAD after PR #14: `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`.
- Post-merge main CI: [43132513659](https://github.com/devcodex-labs/flowkit/actions/runs/43132513659), **7/7 jobs successful** (Ubuntu/Windows × Node 22/24, Linux Host OS-user isolation × Node 22/24, website).
- PR #14 merge commit: `ae5fc5a42c67eb6e2c229d72ff4d9ac8e3aab3cd`; the merge adds only the reviewed Trusted Host V2 design/acceptance/review documentation.
- M1–M5 implementation surfaces and S07 capacity work exist on main. Their presence is not a blanket claim that every M6/native-host gate is passed.
- PR #8, #9 and #10 are merged.
- PR #7 is **closed without merge** as superseded. PR #13 is **merged** into main with current-main M6 tests, correct project-root discovery and successful exact-HEAD CI.
- PR #12 remains open Draft, head `c6b42a36050d885a37831cbdf0839428b2052c85`, based on `ea2bb10893a9be2e5de3561fc9a660a6977ae15c`. Its scripted C13–C20 tests and documentation CI passed; this does not pass C12/S13 native-host gates.
- PR #14 is **merged** as a docs-only conditional security design record. Merge does not authorize Phase 3 or claim Windows/Linux Secure Host, Grok native provenance, C12/S13 or M6 acceptance.

### 1.2 Evidence classes

- **P — Protocol/scripted:** real FlowKit compiler, generated Program, Host, SQLite and protocol; Agent responses may be scripted. Proves protocol behavior only.
- **M — Live model:** a real model session produces the result for an actual Pending. Requires per-turn request identity, response evidence and Host trace.
- **N — Native host attested:** native host tool invocation and session/process provenance are independently verified; OS/Host security boundary is demonstrated.
- **D — Deferred by approved scope:** intentionally belongs to a later milestone; it is not a defect in the current milestone, but must remain in the ledger.

Never count P evidence as M or N. Never count a CI replay of recorded model turns as a new live model session.

## 2. Complete milestone route

| Phase | Scope | Required exit condition | Current state |
|---|---|---|---|
| 0 | Baseline freeze and traceability | Immutable baseline, full requirement/Finding/test ledger and evidence index | **Complete** — established in merged PR #13 |
| 1 | M6 current-main test compatibility | PR #7 tests run against frozen current main; no Core semantic change hidden in test repair | **PASS, merged** — PR #13; main CI 7/7; four matrix cells 369/369, Linux isolation/M6 e2e 11/11 on Node 22/24; no production Core change |
| 2 | Trusted Host security design and formal contract conformance | Approved threat model, OS identity, IPC, key custody, Store ownership, provenance and confirmed V0.3/V0.6-R5 conformance | **设计记录已合并**（PR #14；main CI 43132513659 7/7 PASS）；F-01/F-R2-01 **CLOSED**；F-02/F-04 仍 PARTIAL；F-07 正式原件符合性 **BLOCKED**。该 BLOCKED 只限制历史契约符合性声明和涉及 Core/Program ABI/P0-A 语义的变更，**不阻断与既有语义独立的 H3-01 Host OS 隔离、H3-05 OS-only 安全负例及工具能力 PoC**。参见 [正式契约原件登记](./interactive-phase2-formal-source-register.md) |
| 3 | Trusted Host security implementation | Windows and Linux isolation, access-denial tests and secure Host operations pass | Pending |
| 4 | Native Grok Build JS tool bridge | Grok Build itself calls FlowKit JS tools through Pending → model completion → JS submit/resume → Terminal | Pending |
| 5 | M6 live-model complex acceptance | Applicable C01–C24 cases classified and evidenced at P/M/N levels; all M6 blockers closed | Pending |
| 6 | M6 independent review and P0-A closure | Dot review, full CI, PR integration, all P0-A hard gates passed | Pending |
| 7 | P0-B sequential semantics | Action, Verification, Human, Loop, Cancel and context/result semantics pass S08–S12 and applicable T requirements | Deferred |
| 8 | P1 Parallel all_succeeded | Dedicated fail-fast/parallel contract, recovery and concurrency acceptance pass | Deferred |
| 9 | P2 Parallel any | Winner election, loser cancellation, late results and recovery pass | Deferred |
| 10 | Production compatibility and release | Host matrix, SDK/types/CLI/package/docs/performance/security/release gates all pass | Deferred |

### 2.1 Phase 2 formal contract source gate

PR #14 is merged as a **conditional security design record**. The main post-merge CI passed 7/7, but Phase 2 formal conformance is not closed because the original confirmed Requirements V0.3 and Technical Design V0.6-R5 bodies/full SHA-256 are not available in the current Library/Conversation or main repository. Existing approval records, implementation plan, POC report and independent-review report are secondary evidence only; they cannot replace the approved source documents.

The exact source names, historical path/hash clues, available secondary records and verification procedure are registered in [interactive-phase2-formal-source-register.md](./interactive-phase2-formal-source-register.md). Missing originals keep F-07 and formal conformance BLOCKED, but **are not a blanket stop on all further engineering**. H3-01/H3-05 OS-only work and the non-production Grok tool capability PoC may proceed in isolated branches without changing Core, Program ABI, SQLite schema or frozen P0-A semantics. Any change touching those frozen contracts, and the final Phase 2 conformance claim, must wait for original-source recovery or an explicitly user-approved replacement baseline.

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

Deliverables: threat model, trust topology, candidate-ingress security contract (with optional authenticated listening IPC only when needed), key custody, provider/session evidence design, Windows/Linux profiles, attack matrix and acceptance gates. Independent review must close all **applicable design-blocking** findings before Phase 3. Missing formal V0.3/V0.6-R5 originals remain an explicit conformance BLOCKED item, not evidence that they never existed; OS capability PoCs can be performed separately, but no final conformance claim can be made without them.

## 6. Phase 3 — Trusted Host security implementation

1. Implement distinct OS identities or an equivalently strong restricted token boundary.
2. Restrict Host private directory, key and SQLite DB/WAL/SHM to the Host principal.
3. Validate all **actual model-candidate ingress paths** with explicit authorization and bounded I/O. Do not introduce a TCP/mTLS/Named Pipe listener just to satisfy a checklist: in a no-listener deployment record `NO_LISTENER` and test the real MCP/anonymous-pipe/tool-input path instead.
4. Ensure the model cannot access raw DB, key, signer, Coordinator or private State.
5. Add Windows ACL and Linux UID/GID integration tests. A test that exits because the platform is unsupported is BLOCKED, not PASS.
6. Test read, write, replace, symlink, path traversal, process spawning, inherited handles/environment, IPC spoofing, replay, wrong tenant and unauthorized API calls.
7. Verify Host can still sign, commit, resume and recover after model access is denied.
8. Record raw OS identity, access-denied evidence, process tree, IPC identity and Store integrity.
9. Repeat after reboot/restart and on the supported Node matrix.

Entry: independent Phase 2 security design approved, with frozen OS principals, Host secrets/ACL and no insecure default Node Named Pipe; Grok native tool evidence is **not** required for H3-01/H3-05 OS-only isolation. H3-02 implementation requires only a separately documented Grok tool-registration and signed-before-completion input/timing **capability PoC**, which is **not** a formal NAT-14 PASS.

Exit: **both Windows and Linux** Secure Host Profiles pass their applicable P0 OS/handle/active-ingress/signing/Outbox tests. H3-05 OS-only tests depend only on H3-01; H3-04 adapter integration adds active-ingress and recovery checks later. Without a listening endpoint, prove its absence and test the actual candidate-input mechanism, rather than demanding mTLS. One platform PASS only proves that platform. NAT-14 is officially tested in Phase 4; C12/S13 N remains BLOCKED until native model evidence is complete.

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

1. An **independent reviewer** (local Grok Build or another separate reviewer; Dot is not mandatory) checks exact code SHA, Program hash, raw native tool events, Pending/response, Host traces, signed statements, SQLite, Journal hash chain and OS evidence.
2. Run exact-HEAD CI: Ubuntu 24.04 and Windows 2025 × Node 22.13.0 and 24.22.1.
3. Run Linux cross-UID and Windows ACL isolation jobs independently.
4. Run build, npm verify, package/tarball, types, CLI, docs examples, website and Standard regressions.
5. Resolve every M6 blocker and rerun the relevant scenario plus full regression.
6. PR #12 may be merged only as the scripted matrix/docs contribution after its own review; its merge does not pass C12/S13.
7. PR #7 was closed without merging and its current-main replacement PR #13 was merged after independent code review and CI; do not merge it again. Future M6 native-host security evidence remains in PR #14 and follow-up scoped implementation PRs.
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

### 14.2 Individual T01–T34 requirement ownership

| ID | Frozen requirement scope | Owning phase | Required closure evidence |
|---|---|---|---|
| T01 | Pure Condition → Terminal | P0-A | true/false/missing input; deterministic FK_R002 terminal; no infinite resume |
| T02 | Agent, Skill and missing inputs | P0-A | Skill resolution, declared inputs, missing-input behavior and Standard Pending parity |
| T03 | Wait, kill process, new process completes same Run | P0-A | real process restart, same Run/request identity, durable completion |
| T04 | Invalid Schema and missing/failed validator | P0-A | invalid output rejected, retry/terminal semantics, validator contract failures |
| T05 | Old requestId, wrong node, attempt or runId | P0-A | stale/forged identity rejected before mutation; namespace boundary also closes N5 |
| T06 | Duplicate receipt idempotency and conflict | P0-A | same receipt returns original Ack; conflicting content rejected; cross-process CAS evidence |
| T07 | Source, Program, compiler and policy drift | P0-A + production upgrade | drift fails closed; immutable artifact retained; SDK upgrade/resume policy closes N6 |
| T08 | Invalid JSON, prototype keys and capacity limits | P0-A | canonicalization negatives, 2 MiB hard limit, active reserve and no-mutation rejection |
| T09 | Two-process CAS | P0-A | actual independent processes contend; only one transition commits |
| T10 | Unsupported nodes/configuration preflight | P0-A | unsupported feature/nodes rejected before execution; Program ABI and featureStage rules close N3/N9 |
| T11 | Host has no JavaScript executor | Host | explicit NO_JS_EXECUTOR/BLOCKED; real native tool loop belongs to S13 |
| T12 | Standard regression, AOT, TypeScript, SDK and error codes | All / release | Standard regressions, exports, types, package and error-code contracts |
| T13 | retries:2 means at most three attempts | P0-A | attempt count, new request identity and no extra dispatch |
| T14 | Retry exhaustion preserves FK_R004 | P0-A | terminal errored state, original cause and no invalid State commit |
| T15 | Three-stage verification and candidate state | P0-B | checkStep/verify views, candidate merge and restart behavior; N2 |
| T16 | Action Patch and writes allowlist | P0-B | allowed writes applied; unauthorized writes rejected; deletion semantics documented |
| T17 | Action succeeds but receipt is lost | P0-B | indeterminate/reconcile with stable operationId; no second execute side effect |
| T18 | Action → Verification and onFailure path | P0-B | contextError remains visible to trusted executor and terminal result; N2/N7 |
| T19 | Verification true/false/invalid | P0-B | all outcomes, candidate State and invalid verifier behavior |
| T20 | Human reject → revise → approve and prefix | P0-B | model cannot forge human decision; only independently verified human channel accepted; N4 |
| T21 | Loop 1/3 iterations and final failure | P0-B | iteration count, max-exceeded route and restart parity |
| T22 | Skill pinning and drift | P0-B + production upgrade | exact Skill identity, drift rejection and durable resume policy |
| T23 | Cancel, late result and control signals | P0-B | cancellation/terminal race, idempotent cancel and stale receipt rejection |
| T24 | Parallel all_succeeded / multiple Pending | P1 | separately approved fail-fast contract, branch state, concurrency and recovery |
| T25 | Parallel any | P2 | winner election, terminal CAS, loser cancellation and late results |
| T26 | Out-of-order/duplicate results and write conflicts | P1 | branch ordering, merge policy, duplicate handling and concurrent conflict recovery |
| T27 | Real host closure | Host / M6 | native JS tool log: Pending → model completion → JS submit/resume → Terminal; S13 |
| T28 | Source/artifact/package/types/docs consistency | All / release | reproducible compiler artifacts, package/tarball, types, CLI and executable docs |
| T29 | Kill before/after every Agent phase | P0-A, P0-B, P1 and P2 | process-kill matrix with same Run, exact Pending/operation identity and durable state |
| T30 | Forged Cursor, receipt or identity | All | tamper/replay/wrong-tenant/wrong-Program negative cases; no unauthorized mutation |
| T31 | Non-pure validator and double complete | P0-A/P0-B | pure-local contract enforced; concurrent complete has one durable outcome |
| T32 | External target without idempotency | P0-B/P1/P2 | indeterminate/reconcile policy; no false exactly-once or rollback claim |
| T33 | Standard vs Interactive comparison | All milestones | row-by-row semantic parity/difference register; no undocumented divergence |
| T34 | Long-running workflow, budgets and privacy | P0-A through production | bounded Checkpoint/Journal, recovery, disclosure minimization, capacity exit and stress evidence |

### 14.3 Individual S01–S14 acceptance ownership

| ID | Frozen acceptance scope | Owning phase | Closure evidence |
|---|---|---|---|
| S01 | Pure Condition → Terminal | P0-A | correct terminal, missing input becomes persistent errored state, repeated resume is stable |
| S02 | Single Agent, retries and process-cut matrix | P0-A | publish/accept/commit cut points; request identity and Pending match Store |
| S03 | Repeated invalid output and validator contract | P0-A | retries+1, FK_R004 and deterministic validator failure exit |
| S04 | Two processes complete same request | P0-A | same receipt idempotent; different receipt conflict; uncertain CAS reconciled |
| S05 | Identity and transition rejection paths | P0-A | wrong namespace/run/request/attempt/block and corrupt Store rejected without mutation |
| S06 | Source/Program/Skill/Policy drift | P0-A | pinned bytes and policy mismatch fail closed before dispatch |
| S07 | JSON adversarial inputs, Checkpoint capacity and stage budget | P0-A | canonical JSON, hard/active limits, byte-equal terminal State for budget 1/128 |
| S08 | External checkStep/verify and candidate views | P0-B | Standard-equivalent trusted executorContext and restart at each boundary |
| S09 | External Action, writes and reconcile | P0-B | Patch allowlist, receipt loss, stable operationId and no duplicate execute |
| S10 | Action → Verification → onFailure and contextError | P0-B | verifier/notify context and terminal contextError match frozen semantics |
| S11 | Human reject/revise/approve and Loop limit | P0-B | forged human submission rejected; trusted human provenance; exact loop count |
| S12 | Cancel and late receipt | P0-B | CAS winner, repeated cancel idempotency, stale receipt rejection |
| S13 | Native real-host JS tool loop | Phase 4 / M6 | raw native tool logs and independently verified Host/session/process provenance |
| S14 | Four CI cells, package, types, SDK and Standard regression | Every release gate | exact-HEAD verify, exports/types/tarball/docs and supported OS/Node matrix |

### 14.4 C01–C24 complex acceptance ownership

The frozen detailed matrices remain the source of exact test steps and assertions:
- [C01–C12 frozen matrix and evidence rules](https://github.com/devcodex-labs/flowkit/blob/test/interactive-complex-c01-c12-acceptance/docs/interactive-complex-acceptance-c01-c12.md)
- [C13–C24 extension and evidence tiers](https://github.com/devcodex-labs/flowkit/blob/test/interactive-complex-c01-c12-acceptance/docs/interactive-complex-acceptance-extension-c13-c24.md)
- [C13–C24 results report](https://github.com/devcodex-labs/flowkit/blob/test/interactive-complex-c01-c12-acceptance/docs/interactive-complex-acceptance-c13-c24-results-2026-11-11.md)

| ID | Frozen scenario | Evidence tier / owner |
|---|---|---|
| C01 | Four serial Agents and two Conditions | P + M; Phase 5 |
| C02 | Dynamic routes, true/false and missing-condition errors | P + M; Phase 5 |
| C03 | Schema rejection, retry and valid repair | P + M; Phase 5 |
| C04 | Invalid output and retry exhaustion | P + M; Phase 5 |
| C05 | Host crash at Pending/accept/validate/commit boundaries | P + M/N; Phase 5 |
| C06 | Two-process CAS, lost response and duplicate/conflicting receipts | P + M/N; Phase 5 |
| C07 | Source/Program/Skill/Policy drift | P + N; Phase 3/5 |
| C08 | Permissions, signature verification and data leakage | P + N; Phase 3/5 |
| C09 | Checkpoint capacity, oversize and bounded receipt behavior | P + M/N; Phase 5 |
| C10 | Long Agent chain and durable receipt ledger | P; Phase 5 |
| C11 | Stage-budget 1/128 terminal State byte parity | P; Phase 5 |
| C12 | Native Grok/Codex host and JS tool loop | N; Phase 4/5 |
| C13 | Branch truth table × stage-budget cross product | P; Phase 5 |
| C14 | Forged, stale, tampered and oversized receipts during a live Pending | P; Phase 5 |
| C15 | Historical Ack replay after Host rebuild and Terminal | P; Phase 5 |
| C16 | Trusted provider-call failure and bounded retry | P + M/N; Phase 5 |
| C17 | Host policy/binding drift mid-chain | P; Phase 5 |
| C18 | Interleaved Runs, idempotent start and conflicting start intent | P; Phase 5 |
| C19 | 36-Agent chain failing at Agent 18 with fail-fast | P; Phase 5 |
| C20 | Two different valid signed results competing for one CAS | P; Phase 5 |
| C21 | SIGKILL and same physical DB recovery across Node/OS versions | P enhancement; Phase 10 unless approved as a hard gate |
| C22 | Prompt injection and attempts to claim Host authority | P + M/N; Phase 3/5 |
| C23 | Combined live-model failure, crash/recovery and competing submitters | M/N; Phase 5 |
| C24 | Compatibility, package, docs and native-host release gate | P + N; Phase 6/10 |

All C rows remain individually classified PASS/FAIL/PARTIAL/BLOCKED/DEFERRED in the detailed matrix. This summary table does not replace their individual raw evidence.

### 14.5 Finding ownership

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

### 14.6 Global release rule

No stage is complete while any applicable requirement, acceptance case, historical Finding or regression remains unclassified. Every unresolved item must be either:
- fixed and re-tested;
- BLOCKED with concrete missing evidence and re-entry condition; or
- DEFERRED to an approved later phase with a named milestone.

A phase cannot pass by deleting a test, weakening an assertion, changing the evidence tier or combining results from different commits.

## 15. Current next actions

1. Phase 0/1 **complete**: PR #13 merged to main `9bac8f86347a405efe068f96423ae3e501005061`; old PR #7 closed unmerged.
2. Main CI [42998521531](https://github.com/devcodex-labs/flowkit/actions/runs/42998521531): 7/7 successful; Ubuntu/Windows × Node 22/24 each 369/369; Linux OS isolation + M6 11/11 on both Node versions.
3. Phase 2 security design record (still Draft/Conditional): [Trusted Host V2](./interactive-trusted-host-security-v2-design.md), [threat model](./interactive-trusted-host-security-v2-threat-model.md), [acceptance matrix](./interactive-trusted-host-security-v2-acceptance.md), [review ledger](./interactive-trusted-host-security-v2-review.md). Third-round Grok review closed F-01/F-R2-01; F-02/F-04 remain PARTIAL and F-07 remains BLOCKED.
4. Three rounds of Grok Build independent review have been completed, including the final targeted review of F-01/F-R2-01. Phase 2 is **not yet frozen**: F-02 native tool binding, F-04 cross-principal handle isolation and F-07 formal contract provenance remain open/BLOCKED. Draft/CI success is not a substitute for native Host security acceptance or a professional third-party security certification.
5. Then implement OS isolation, trusted bridge, direct Grok Build tool loop, real-model edge cases and Phase 6 M6 closure. PR #12 remains Draft until its own scoped review.

**Formal contract source caveat:** Historical FlowKit requirement V0.3 and technical design V0.6-R5 are cited in previous handoffs, but their full immutable bodies/SHA-256 are not presently available to this PR's independent reviewer. Conformance to those documents remains **BLOCKED** until the exact originals can be independently read and hashed; roadmap IDs cannot replace official text.

**No direct main modification or release is authorized. Merge only through a reviewed PR after exact-HEAD CI. This test/roadmap PR does not authorize production semantic changes or declare M6 complete.**
