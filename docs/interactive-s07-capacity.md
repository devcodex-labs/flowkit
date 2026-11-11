# FlowKit Interactive P0-A — S07 bounded Checkpoint / receipt liveness contract

> Stage 1 P1 fix only. FlowKit is a deterministic JavaScript workflow engine, **not** a business artifact repository or Context service. No new user file storage, object store, context graph, GC or TTL is introduced here.

## Capacity, identity and explicit outcomes

- The **hard** canonical JSON Checkpoint limit remains **2 MiB**, preserving its existing external corruption/read guard.
- The Store reserves **256 KiB** of capacity for deterministic failure and recovery. Creation and every **nonterminal** transition must stay at or below **1.75 MiB** (`MAX_ACTIVE_CHECKPOINT_BYTES`); this includes Pending preparation/publication, so an impossible-to-recover Pending is not published merely because its waiting snapshot fit the absolute maximum.
- There is **no arbitrary per-Agent 128 KiB limit**. Agent result JSON has the existing **2 MiB hard canonicalization ceiling**, but whether it can be accepted depends on the entire **1.75 MiB active Checkpoint** including State, Pending, Candidate, and receipt cache. Larger business outputs should be saved by the **Host's user-selected storage** before signing/returning a small reference in the existing Agent result. FlowKit never decides where files are saved or how business content expires.
- When a Host-authenticated, matching Agent receipt exceeds the inline bound, or a Coordinator transition would exceed the active Checkpoint budget, the Coordinator deterministically commits `errored(FK_I_CHECKPOINT_CAPACITY)` with original State intact, clears Pending/Candidate, appends a Journal entry, and then reports the error to the Host. It **does not** pretend to have accepted the receipt, does not manufacture `acceptedRevision`, and never emits a second Pending. Another Host may use `load` to inspect the durable terminal state. A different process racing this transition is resolved by optimistic CAS.
- An initial State that would overflow the active limit is rejected **before** Run creation; users should pass small values or Host-managed references.
- The soft budget applies to nonterminal transitions; a terminal error may use the remaining reserved capacity. Under the Store's new admission rules every newly written active Checkpoint has enough space for a bounded terminal error even after its Pending is removed.
- Malformed or oversized **untrusted** input rejected before Host authentication does not authorize an attacker to terminate another user's Run. The Host verifies provenance before invoking the private Coordinator.

## Receipt index — still FlowKit execution data

The default SQLite Store adds a narrowly scoped table `fk_i_receipt_index`:

`(namespace, run_id, request_id, node_id, attempt, digest, accepted_revision, entry_hash)`

This table is an **immutable idempotency index**, *not* a business result repository. A successful receipt CAS inserts the index row, updates the Checkpoint, and appends the audit Journal **inside one SQLite IMMEDIATE transaction**. `getReceipt(runId, requestId)` is namespace-scoped and verifies stored digest/row identity against the committed receipt Journal entry.

The Checkpoint retains at most the 16 most recent receipt summaries for low-cost inspection; all earlier accepted receipts remain accessible from the immutable SQLite index by `requestId` with their original `acceptedRevision` and digest. Existing Checkpoints whose full inline receipt history predates this feature are backfilled from their verified committed Journal records under the next receipt CAS before bounded compaction; no evidence is silently discarded.

Existing `CheckpointStore` adapters without the optional `getReceipt` capability retain legacy inline receipt handling. The reference SQLite adapter implements the new index and enforces the capacity contract. Other adapters must uphold equivalent atomicity and capacity/terminal behavior to claim S07 conformance.

## Non-goals and evidence

- No file I/O API or Context integration. The Host chooses where business outputs and temporary files live and when they expire.
- No automatic pruning of the SQLite receipt index, Journal or Program bytes. Run retention and schema migration are separate future work; an audit index must not disappear while an accepted Run may be queried.
- The M6 near-2MiB adversarial seed must now fail **before** creating an unacceptably large waiting Checkpoint, while the original valid 64-KiB Agent result proceeds from the prior safe Checkpoint. Oversized inline results must end in durable `errored`, preserving State, journal integrity and immutable Program identity.
- Stage 1 cannot claim S13 real Codex/Claude/Grok model/tool integration or mark M6 complete.

The change keeps the Program's routing authority, the 2 MiB hard integrity limit, namespace and artifact pins, and the existing Standard API untouched.
