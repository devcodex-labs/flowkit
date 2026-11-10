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
checkStep; constructing a string \`provenanceRef\` or JSON
\`{kind:"human",approved:true}\` grants no approval.

## Host provisioning

1. Compile using the trusted FlowKit compiler and approve the **exact**
   \`artifactHash\` in a private build/deployment manifest. A SHA-256 hash only
   proves identity, **not compiler authenticity**; never automatically add
   model-supplied hashes to the allowlist.
2. Generate an Ed25519 key pair in the **Host/transport trust domain**.
   Store the private key in a restricted OS account, secret manager or KMS, not
   in a model-visible folder, prompt, shell argument, environment, or callback.
   Distribute only the public key to the Host verifier.
3. Configure an explicit \`allowedInputKeys\` allowlist and an affirmative
   \`authorizeDisclosure\` callback. The default allowlist is empty, so any
   undeclared Agent input blocks publication to the model.
4. Place the SQLite Store in a Host-only directory; keep WAL mode and FULL
   synchronization enabled and do not give model tools access to its files.
5. Use separate OS users/process isolation for the untrusted model worker.
   A shared-UID shell agent must not be treated as a trusted approval origin.

## Minimal Host-side integration

~~~js
import {
  createTrustedInteractiveHost,
  createAgentReceiptStatement,
  encodeAgentReceiptStatement,
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

In this example, \`trustedModelTransport\` and \`trustedDlpAllows\` are
**Host-provided integrations**, not FlowKit-owned network clients or
model-controlled callbacks. A model-submitted \`receipt\` does not become
trusted just because the Host signed it: the Host must independently verify
the actual provider/session origin before issuing the signature.

The signed statement uses canonical JSON bytes, versioned domain
\`flowkit.host-agent-receipt.v1\`, and binds the exact namespace, run ID,
request ID, node ID, attempt, submission kind, canonical result digest,
artifact identity, pinned policy identity, proof ID and issuance/expiry times.
Only Ed25519 is accepted, with canonical base64url signatures. The default
maximum proof lifetime is five minutes, with five seconds of clock skew.

## Rejection and recovery

- **Unsigned/forged/replayed-across-run/expired/wrong-key/wrong-policy/wrong-
  artifact** proof: reject with \`FK_I_PROVENANCE_REJECTED\` before CAS. No
  checkpoint or Journal mutation occurs.
- **Disallowed input or missing DLP approval**: reject
  \`FK_I_HOST_DENIED\` without releasing a task or changing the run.
- **Same signed receipt retransmitted**: after a successful acceptance, the
  Coordinator returns the original \`acceptedRevision\` and current run view;
  different content for the same request is rejected.
- **Lost response or Host crash**: reopen the same Host-owned Store with the
  same trust policy and approved key/Program allowlists, then \`resume\` or
  resend a still-valid signed receipt. Do not sign a newly invented model
  result to evade expiry.
- **Key rotation or artifact/allowlist change** changes the policy hash for
  new Host instances and blocks existing runs. Keep the original policy
  accessible until the run drains, or design an explicit, audited migration.
- **Missing trustworthy OS separation**: do not call the environment secure.
  Quarantine the Host-only endpoints or mark the real-host security gate
  **BLOCKED**; never substitute a model-claimed \`provenanceRef\`.

## Validation evidence and limits

The P0-A CI uses Ubuntu/Windows × Node 22/24 for \`npm run verify\`,
includes tampered-signature, wrong-tenant, wrong-request, expired, malicious
Program and disclosure-negative cases, and adds a **separate Ubuntu
Node 22/24 OS isolation job**. That job launches a real unprivileged
\`nobody\` Node process: it must read a public task but receive access-denied
on the Host's private Ed25519 key and SQLite database. It fails if privilege
separation cannot be established. This does **not** prove Windows ACL policy,
Codex/Claude/Grok product integration, real provider billing idempotence or a
native Human approval UI; those require a separately validated Host runtime.
