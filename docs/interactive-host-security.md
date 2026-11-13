# FlowKit Interactive P0-A — M5 trusted Host boundary

This is a **Host-owned security adapter** for the P0-A Agent workflow. It does
not create a sandbox, grant a model access to Host credentials, implement Human
approval, or change Standard's six root SDK functions.

## Trust topology

~~~text
PRIVATE TRUSTED HOST PROCESS / OS USER
  - approved compiler artifacts (hash allowlist from trusted CI)
  - pinned Ed25519 public keys and approved policy
  - locked-down SQLite Checkpoint Store
  - private Agent transport evidence (outside the model channel)
  - Host signer / KMS / isolated key material (outside the model channel)
  - createTrustedInteractiveHost(...)
          |
          | getPublicAgentTask() after explicit input allowlist + Host disclosure approval
          v
UNTRUSTED MODEL PROCESS / OS USER
  - receives only the public Agent Task (no Store, private key, full State or Coordinator)
  - produces model result data; CANNOT sign trusted Host evidence
          |
          | model result to a separate, trusted provider/Host transport
          v
TRUSTED HOST / TRANSPORT
  - validates observed result and constructs signed receipt evidence
  - accept({receipt,attestation}) verifies Ed25519 before any receipt CAS
          |
          v
P0-A Coordinator -> SQLite CAS -> accepted receipt -> local validation -> commit
~~~

**Hard requirement:** the model process must not share the Host UID, signing
key, private database path, or unrestricted filesystem/tool permissions.
A public JavaScript factory is **not** a security boundary by itself.
Any model with direct access to the Host-owned SQLite Store, private signing
material or raw Coordinator can bypass this adapter. In that environment,
secure Host approval is **BLOCKED** until isolation is available.

The signed record is for **Agent results only**. The P0-A graph still rejects
Human, Action, Verification, Loop, Parallel, Agent verify and external
checkStep; constructing a string `provenanceRef` or JSON
`{kind:"human",approved:true}` grants no approval.

## Host provisioning

1. Compile using the trusted FlowKit compiler and approve the **exact**
   `artifactHash` in a private build/deployment manifest. A SHA-256 hash only
   proves identity, **not compiler authenticity**; never automatically add
   model-supplied hashes to the allowlist.
2. Generate an Ed25519 key pair in the **Host/transport trust domain**.
   Store the private key in a restricted OS account, secret manager or KMS, not
   in a model-visible folder, prompt, shell argument, environment, or callback.
   Distribute only the public key to the Host verifier.
3. Configure an explicit `allowedInputKeys` allowlist and an affirmative
   `authorizeDisclosure` callback. The default allowlist is empty, so any
   undeclared Agent input blocks publication to the model.
4. Place the SQLite Store in a Host-only directory; keep WAL mode and FULL
   synchronization enabled and do not give model tools access to its files.
5. Use separate OS users/process isolation for the untrusted model worker.
   A shared-UID shell agent must not be treated as a trusted approval origin.

## OS-authenticated operator and auditor sessions

For the first internal deployment, the trusted launcher obtains the operator or
auditor identity from the Windows token SID or Linux UID of the authenticated
OS session. Store the identity-to-namespace and role mapping in Host-private
configuration. Provision the SQLite Store for the namespace assigned by that
mapping. The Model runs under a separate account and sees only task input and
submission tools.

Use the [role mapping](../examples/interactive/codex-os-access.mjs) and
[stdio session](../examples/interactive/codex-os-stdio.mjs) as reference adapters.
The stdio adapter expects an already authenticated peer and dedicated streams.
It authorizes each command against the server-side session and closes the grant
when the stream ends. It rechecks `result:read` before returning a result.
For writes, authorize again at the mutation boundary after any asynchronous
preparation. Policy reload cannot undo an operation already committed.
An operator may start, dispatch and complete in its
namespace. Grant `result:read` separately to the auditor and route it through
`readTrustedTerminalResult`. Keep full results on the authorized audit channel.
Use a trusted configuration reload to remove or change a grant. Removing and
then restoring it requires a new session. Deployments with multiple Host
processes must apply the policy update to each affected process.

For file submissions, the authorized Host fixes the original bytes and binds the
reference to the current namespace, Pending and observed Model call. The Host
must enforce the operator grant before claiming the snapshot. See the
[release matrix](./evidence/p0a-g07-g12-20261113/release-matrix.md) for candidate
verification and the remaining checks on the release deployment.

## Minimal Host-side integration

~~~js
import {
  createTrustedInteractiveHost,
  createAgentReceiptStatement,
  encodeAgentReceiptStatement,
  normalizeHostAgentReceipt,
} from '@devcodex-labs/flowkit/interactive';
import {sign} from 'node:crypto';

// All variables below belong exclusively to the trusted Host.
// store, runtime and compiled Program are created in the Host process.
// trustedPublicKey comes from the Host's secure key registry.
// privateKey is illustrative; in production use a protected signer/KMS.
const host = createTrustedInteractiveHost({
  store,
  runtime: {
    skillResolver: trustedSkillRead,
    validateResult: pureSynchronousValidator,
  },
  policy: {deploymentId:'approved-v1'},
  trustedArtifacts: [approvedProgramIdentity.artifactHash],
  trustedPublicKeys: {'transport-key-v1': trustedPublicKey},
  allowedInputKeys: ['documentId','summary'],
  disclosurePolicyId: 'model-input-allowlist-v1',
  authorizeDisclosure: async ({task}) => {
    // Must be a genuine, Host-owned authorization source, not the model.
    return trustedDlpAllows(task);
  },
});

const frame = await host.start({
  programBytes: approvedProgramBytes,
  programIdentity: approvedProgramIdentity,
  startKey: 'trusted-run-1',
  state: {documentId:'doc-123',summary:'safe-to-share',privateKey:'NOT_DISCLOSED'},
});

const task = await host.getPublicAgentTask({runId:frame.runId});
// The model sees task ONLY, never frame, store, privateKey or the Host process.
const result = await trustedModelTransport(task); // host-observed result
const receipt = {
  runId: task.runId,
  requestId: task.requestId,
  nodeId: task.nodeId,
  attempt: task.attempt,
  kind: 'agent-result',
  result,
};
const now = Date.now();
const statement = createAgentReceiptStatement({
  run: store.load(task.runId),
  receipt,
  keyId: 'transport-key-v1',
  proofId: trustedEventIdFromTransport,
  issuedAt: now,
  expiresAt: now + 60_000,
});
// Sign inside the separate Host/transport trust domain.
// NEVER send privateKey or this signing capability to a model process.
const signature = sign(
  null, encodeAgentReceiptStatement(statement), privateKey,
).toString('base64url');
const verified = await host.accept({
  receipt, attestation:{statement,signature},
});
console.log(verified.status); // waiting / paused / succeeded / failed / errored
~~~

In this example, `trustedModelTransport` and `trustedDlpAllows` are
**Host-provided integrations**, not FlowKit-owned network clients or
model-controlled callbacks. A model-submitted `receipt` does not become
trusted just because the Host signed it: the Host must independently verify
the actual provider/session origin before issuing the signature.

The signed statement uses canonical JSON bytes, versioned domain
`flowkit.host-agent-receipt.v1`, and binds the exact namespace, run ID,
request ID, node ID, attempt, submission kind, canonical result digest,
artifact identity, pinned policy identity, proof ID and issuance/expiry times.
Only Ed25519 is accepted, with canonical base64url signatures. The default
maximum proof lifetime is five minutes, with five seconds of clock skew.

## Oversized real model output: Host → Coordinator contract (P0-A S07)

**Two different failures must never be confused.**

1. **Unverified or raw oversized receipt**: \`host.accept()\` calls
   \`normalizeHostAgentReceipt()\` **before** signature/provenance verification.
   The signed v1 receipt's canonical JSON limit is **2 MiB**, including
   request metadata and the result envelope. A body above this limit returns
   \`FK_I_PROVENANCE_REJECTED\` with **no Checkpoint, Journal or receipt-index
   mutation**. The Run may still be \`waiting\`: rejecting unverified input
   **must not** give a model the power to terminate another Run.
2. **Trusted Host has independently observed provider output overflow**:
   the Host's own authenticated provider transport / streaming limiter records
   that the output cannot be represented within the v1 receipt limit. The Host
   sends **only a small, bounded, Ed25519-attested**
   \`{kind:'agent-call-failed',failure:{message:'...'}}\` for the *current
   authoritative Pending*. This is **an accepted failure receipt**, not an
   accepted oversize result. Existing Coordinator rules retry at most
   \`retries+1\` attempts; when exhausted, the Run durably becomes
   \`errored(FK_R004)\`. The failure receipt receives a normal immutable
   \`acceptedRevision\`, and its duplicates return the same Ack.
3. **Validly signed, bounded Agent result that overflows the *combined*
   active Checkpoint budget**: the S07 Store capacity reserve applies.
   Coordinator may durably terminate as \`errored(FK_I_CHECKPOINT_CAPACITY)\`
   **without accepting that result**. This is a separate failure mode.

A trusted Host integration should handle the provider output *before* building
or signing a receipt. Minimal Host-side decision logic (illustrative;
\`trustedModelTransport\` must be a **Host-owned provider/session transport**,
not model JSON and not a public self-declared status field):

~~~js
const task = await host.getPublicAgentTask({runId});
// The transport/Host must enforce an explicit response-byte budget, record
// genuine provider/session outcome, and prevent unbounded buffering.
// The observation is made outside the model channel.
const observed = await trustedModelTransport(task);
const identity = {
  runId:task.runId,requestId:task.requestId,
  nodeId:task.nodeId,attempt:task.attempt,
};

const receipt = observed.kind === 'verified-provider-output-limit'
  ? {
      ...identity,
      kind:'agent-call-failed',
      failure:{
        // Constant-size Host-authored message. NEVER append model output.
        message:'FK_I_AGENT_OUTPUT_TOO_LARGE: provider transport limit exceeded',
      },
    }
  : {
      ...identity,
      kind:'agent-result',
      result:observed.result,
    };

// The trusted signer must independently confirm observation.sessionId,
// observation.requestId and exact provider result before signing.
// Validate receipt size/shape with normalizeHostAgentReceipt(receipt).
// Do not convert ANY arbitrary normalization/provenance error to a failure.
const normalized = normalizeHostAgentReceipt(receipt);
const now = Date.now();
const statement = createAgentReceiptStatement({
  run:store.load(task.runId),receipt:normalized,
  keyId:'transport-key-v1',proofId:observed.verifiedEventId,
  issuedAt:now,expiresAt:now+60_000,
});
const signature = sign(
  null,encodeAgentReceiptStatement(statement),privateKey,
).toString('base64url');
const frame = await host.accept({
  receipt:normalized,attestation:{statement,signature},
});
~~~

**Strict Host obligations:** the verified size event is bound to the exact
current Run/request/attempt and is observed through a trusted transport, not
invented by model text. Sign only after independently checking the provider
origin and event identity. If the Host cannot authenticate the size
observation, it **must not** forge a signed failure or make a state change; it
should retain the Pending and reconcile the provider request using its own
delivery/idempotency policy. A safe Host should configure streaming/body-size
limits up front, rather than first buffering arbitrarily large responses in
memory. Never treat \`FK_I_PROVENANCE_REJECTED\` as proof of oversize; that
generic code also covers forged, malformed and unsupported receipts.

The Host may store a large *business* output using its own configured storage
and return a **small reference** instead; FlowKit doesn't choose the storage
provider, manage the file, or expire it. The reference must itself satisfy the
declared Agent result schema and the regular disclosure/integrity rules.

**Scope of evidence:** \`tests/interactive/host-oversize.test.mjs\` exercises
the real compiler, Program, SQLite, Host Ed25519 attestation, Coordinator CAS,
bounded retry/terminal and historical Ack with a **scripted trusted transport
observation**. This does **not** prove that Codex/Claude/Grok's actual
provider/session origin is verified. M6 S13 remains a separate gate.

## Rejection and recovery

- **Unsigned/forged/replayed-across-run/expired/wrong-key/wrong-policy/wrong-
  artifact** proof: reject with `FK_I_PROVENANCE_REJECTED` before CAS. No
  checkpoint or Journal mutation occurs.
- **Disallowed input or missing DLP approval**: reject
  `FK_I_HOST_DENIED` without releasing a task or changing the run.
- **Same signed receipt retransmitted**: after a successful acceptance, the
  Coordinator returns the original `acceptedRevision` and current run view.
  A cryptographically valid, previously accepted, byte-identical receipt may
  re-ack even after proof expiry; this never authorizes a new receipt.
  Different content for the same request is rejected.
- **Lost response or Host crash**: reopen the same Host-owned Store with the
  same trust policy and approved key/Program allowlists, then `resume` or
  resend the signed original receipt; the historical Ack rule above applies.
  Do not sign a newly invented model result to evade expiry.
- **Key rotation or artifact/allowlist change** changes the policy hash for
  new Host instances and blocks existing runs. Keep the original policy
  accessible until the run drains, or design an explicit, audited migration.
- **Missing trustworthy OS separation**: do not call the environment secure.
  Quarantine the Host-only endpoints or mark the real-host security gate
  **BLOCKED**; never substitute a model-claimed `provenanceRef`.

## Validation evidence and limits

The P0-A CI uses Ubuntu/Windows × Node 22/24 for `npm run verify`,
includes tampered-signature, wrong-tenant, wrong-request, expired, malicious
Program and disclosure-negative cases, and adds a **separate Ubuntu
Node 22/24 OS isolation job**. That job launches a real unprivileged
`nobody` Node process: it must read a public task but receive access-denied
on the Host's private Ed25519 key and SQLite database. It fails if privilege
separation cannot be established. This does **not** prove Windows ACL policy,
Codex/Claude/Grok product integration, real provider billing idempotence or a
native Human approval UI; those require a separately validated Host runtime.
