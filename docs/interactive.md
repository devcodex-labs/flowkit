# FlowKit Interactive — P0-A M4 Host Coordinator

> **Internal/maintainer integration only.** The Standard root API remains exactly
> \`run / compile / compileSource / check / evalWhen / isControlSignal\`.
> Interactive APIs live under \`@devcodex-labs/flowkit/interactive\`.
> This does **not** grant a model permission to act as a trusted Host.

## Supported features

- **Implemented**: Condition, Terminal, Agent (no Agent verify/checkStep), immutable compiled JavaScript Program, original Standard analyzer, namespace-scoped SQLite WAL/FULL Checkpoint Store, phase-by-phase CAS, deterministic Agent preparation, persist-before-publish, receipt-accept-before-validate, local sync validation, retry exhaustion, crash resume, final State and error cause.
- **Not implemented in P0-A**: Human, Action, Verification, Loop, Parallel, Agent verify or external checkStep, automatic \`runAgent\` invocation, trusted Human provenance bridge, background service, P0-B/P1/P2 extensions.
- The Coordinator and the Store are **owned and invoked by the Host**, not by the model. A model must not have direct filesystem/database access or direct \`complete()\` authority.

## Example: compile, start, resolve pending, resume

The source is a validated \`*.workflow.js\` or \`*.workflow.ts\` using
FlowKit's existing DSL; it is **not imported or executed** while compiling.

~~~js
import {readFile} from 'node:fs/promises';
import {
  compileInteractive, createSqliteCheckpointStore, createInteractiveCoordinator,
} from '@devcodex-labs/flowkit/interactive';

const compiled = await compileInteractive('tasks/review.workflow.js', {
  output: 'memory',
  featureStage: 'P0-A',
});
if (compiled.diagnostics.some(d => d.severity === 'error')) {
  throw new Error('Interactive compile rejected the workflow');
}

const store = createSqliteCheckpointStore('.host-private/review.db', {
  namespace: 'host-tenant-001',
});
try {
  const coordinator = createInteractiveCoordinator({
    store,
    policy: {bindingVersion: 1, hostPolicyId: 'host-policy-v1'},
    runtime: {
      // Trusted-read: return the instruction; do not make model calls here.
      skillResolver: async ({agent, skill, nodeId}) => {
        if (!agent || skill) throw new Error('Unsupported skill mapping in this example');
        return readFile(new URL('skills/' + agent + '.md', import.meta.url), 'utf8');
      },
      // Pure, synchronous local output schema validator.
      validateResult: (_outputSchema, result) =>
        typeof result?.answer === 'string' ? [] : ['answer is required'],
    },
  });

  let frame = await coordinator.start({
    programBytes: Buffer.from(compiled.code, 'utf8'),
    programIdentity: compiled.programIdentity,
    startKey: 'review-2026-11-10',
    state: {ready: true, message: 'Review the supplied draft'},
  });

  while (frame.status === 'waiting') {
    const task = frame.pending; // Only published after durable CAS.
    // modelResult = await HOST_OWNED_AGENT_TRANSPORT(task);
    const modelResult = {answer: 'Reviewed'}; // demonstration only
    frame = await coordinator.complete({
      runId: task.runId,
      requestId: task.requestId,
      nodeId: task.nodeId,
      attempt: task.attempt,
      kind: 'agent-result',
      result: modelResult,
    });
  }
  while (frame.status === 'paused' && frame.pauseReason === 'stage-budget') {
    frame = await coordinator.resume({runId: frame.runId});
  }
  if (frame.status === 'errored') throw new Error(frame.terminal?.causeCode);
  console.log(frame.status, frame.state);
} finally {
  store.close();
}
~~~

## Invariants and recovery

1. **Program is the routing authority.** The generated \`advance(view,event)\`
   and its verified immutable \`programTable\` supply legal stage transitions.
   The Coordinator does not reconstruct DSL routing or let model output choose
   \`toBlockId\`.
2. **A durable Pending precedes delivery.** The Host may dispatch only the
   \`frame.pending\` returned from a successful \`waiting\` CAS. A restart with
   that run ID returns the same \`requestId\` and persisted task.
3. **Receipt is stored before validation.** \`complete()\` atomically stores the
   result/failure, its canonical digest, \`acceptedRevision\` and the \`validate\`
   Checkpoint. The local validator runs only afterward. If the process stops
   between the two steps, \`resume()\` re-validates the **same** candidate,
   without publishing the previous request again.
4. **Receipt retransmission is idempotent.** The same canonical body with the
   same \`requestId/nodeId/attempt\` returns the original
   \`acceptedRevision\` even if several later revisions exist; different
   content returns \`FK_I_RECEIPT_CONFLICT\`.
5. **Only a validated result may modify State.** Validation failure retries
   with a new deterministic request ID up to \`retries+1\`; exhaustion becomes
   \`errored(FK_R004)\`. A malformed pure validator becomes
   \`errored(FK_I_VALIDATOR_CONTRACT)\`. No candidate is merged before a
   successful validation and commit-stage CAS.
6. **Identity is fixed.** The run pins \`namespace\`, Program artifact bytes,
   start intent, and policy fingerprint. Rebinding or changing policy requires
   a compatible, explicitly managed procedure; it is not inferred from source
   or a new Program file.
7. **Budget is explicit.** A finite \`maxStagesPerCall\` (1–128, default 128)
   produces a \`paused(stage-budget)\` checkpoint, which \`resume()\` can
   advance. It is never a fake \`waiting\` frame.

## Security / operational boundary

- Treat \`runtime.skillResolver\` as **trusted read-only code**: it may be
  invoked again after a conflict or crash. Do not charge models or execute
  external side effects in it.
- \`runtime.validateResult\` must be **synchronous, deterministic and pure**.
  FlowKit cannot establish purity of arbitrary Host callbacks.
- Agent input contains only declared input keys plus a \`missing\` list;
  absent keys are not synthesized as null. The Host still owns disclosure
  rules for confidential state and instructions.
- \`complete()\` is **not a model-exposed tool**. M5 must enforce actual Host
  provenance and identity outside the model-controlled process.
- Store data is written with \`node:sqlite\` in WAL mode and
  \`synchronous=FULL\`, with every transition in one SQLite transaction.
  Do not place this reference Store on an unreliable/shared filesystem.
  Node 22's built-in SQLite is experimental; the pinned GitHub Actions
  Ubuntu/Windows Node 22/24 matrix is mandatory evidence, not a generic
  claim of compatibility for arbitrary host environments.
- External Agent calls are **not exactly-once**: the Host must provide
  idempotent delivery/reconciliation if it has externally billed or side
  effecting operations. FlowKit guarantees a unique durable pending identity,
  not exactly-once provider execution.
- No npm publication, deployment, untrusted code sandbox, or background
  service is part of this milestone.
