# FlowKit Interactive — Stage 2 integration contracts

> Internal / P0-A only. This document is about static compilation and Host binding
> compatibility, not a new Context module, artifact store, model service or Stage extension.

## Project roots and Skill static validation

`compileInteractive(file, {output:'memory'|'file',featureStage:'P0-A'})`
reuses the **original Standard analyzer** for static diagnostics. Its
project root is now discovered from the nearest ancestor `package.json`, as in
Standard `compile` and `check`. A Host may explicitly override this with
`projectRoot`, resolved against the process working directory.

The Interactive compile options are deliberately restricted to the relevant
subset of the Standard static configuration contract:

| Option | Behavior |
| --- | --- |
| `projectRoot` | Nearest ancestor `package.json` by default, else explicit root |
| `skillsRoot` | Default `skills`; used for `agent` → local Skill reference |
| `skillCheck` | Default true; false skips local file-existence checks only |
| `remoteSkillHosts` | Default empty allowlist for HTTPS Skill references |
| `outDir` | Optional output location for Interactive compiled Program |
| `output` | `memory` or `file` |
| `featureStage` | Strictly `P0-A` |
| `targetVersion` | Optional `interactive-state-machine-v1` |

No remote Skill is downloaded by the compiler. Integrity/allowlist diagnostics
are inherited directly from Standard's static Skill checker. Options that
have no Interactive compile-time meaning (such as Standard tracing,
`mermaid`, live `fetch` callbacks) are rejected instead of silently ignored.
`flowkit.config.mjs` is still a **CLI-level** configuration convention:
the SDK does not silently execute a project configuration file.

Example:

```js
const program = await compileInteractive('workflows/review.workflow.js', {
  output: 'memory',
  featureStage: 'P0-A',
  skillsRoot: 'skills',
  remoteSkillHosts: ['skills.example.test'],
});
```

A Host can also set `projectRoot`, or disable local existence checking in
environments where the trusted Host resolves Skills outside the compile machine.
Disabling `skillCheck` never authorizes unknown remote hosts or missing
Integrity requirements.

## Host callback binding identity (existing policyHash contract)

Interactive P0-A supports two Agent runtime bindings:
`runtime.skillResolver` and synchronous, pure `runtime.validateResult`.
These are Host code, not serialized inside the Program.

The Coordinator already fingerprints the **entire Host-supplied `policy`**
as `policyHash`, persists that fingerprint at start, and rejects any
`resume` / `complete` / `load` under a different policy **before a
Checkpoint CAS**. No new SDK API or additional runtime is needed for binding
versions. The recommended Host policy is:

```js
const policy = {
  deploymentId: 'approved-host-2026-11',
  bindingVersions: {
    'runtime.skillResolver': 'writer-package@2.3.0/sha256-<approved-digest>',
    'runtime.validateResult': 'validator@1.5.0/sha256-<approved-digest>',
  },
};
const coordinator=createInteractiveCoordinator({store,runtime,policy});
```

**Host obligations:**

1. Derive each declared version from an approved deployment or immutable
   resource manifest, including relevant Skill bytes, validator logic,
   dependencies and externally loaded configuration.
2. Keep the actual implementation and referenced bytes consistent with the
   declared version for the lifetime of an active Run. If a dependency changes
   in a way that could change execution, bump its binding version **before**
   the new Host attempts to resume.
3. Keep the original Host policy/implementation accessible until that Run
   completes, or explicitly arrange a reviewed and audited migration.
4. Never treat an unchanged string version as cryptographic proof of unchanged
   behavior. FlowKit does **not** introspect arbitrary JS closures, network
   dependencies, or mutable files to discover their semantic identity.
5. `policy.bindingVersions` is **recommended and Host-maintained**, not yet
   mandatory for legacy P0-A runs. Introducing a strict mandatory flag would
   break already deployed Agent runs; it requires a separate compatibility
   decision. P0-A relies on the Host to supply truthful version identities.

Negative tests exercise changed version → `FK_I_POLICY_MISMATCH`, with the
Checkpoint and Journal unchanged, and the original version → successful
resume. It protects against **declared** policy drift, not undocumented
in-place changes in a Host callback.

## Shared checkStep callback

A generic Standard Host may expose `runtime.checkStep`. Presence alone
is harmless when the verified P0-A Program has **no Agent bindings** (for
example Condition → Terminal); the callback is never invoked.

For an Agent Program, P0-A still rejects a non-undefined `checkStep`
rather than silently skipping a validation function it does not implement.
Agent verification and external `checkStep` remain reserved for P0-B.
The error is `FK_I_UNSUPPORTED_GRAPH` and no Run is created.

## Program-load cost and bounded verified cache

The initial sampled benchmark on Ubuntu Node 24.22.1 measured a 15,908-byte
immutable Program across 16 Condition nodes: repeated verified loader
median **5.386 ms**, p90 **9.068 ms** (28 warm samples), with **34**
artifact reads and **147.468 ms** full Run time. These are
single-run diagnostic samples, **not a production SLA**.

Because per-phase loader re-parsing is meaningful relative to the overall
execution time, the Coordinator now maintains a **per-instance, 4-entry LRU**
of *already-verified immutable Program objects*. It never stores the Program
in an external or global cache. At **every stage, including cache hits**,
FlowKit still reads the Host-owned Store, verifies the full Program byte hash
and manifest identity, checks the current policy, runtime binding requirements,
and legal Checkpoint phase. A changed/missing Store artifact rejects even
with a warm cache; this is covered by explicit negative tests.

`node scripts/bench-interactive-load.mjs` measures the same workflow without
latency thresholds. The precise Stage 2 PR CI evidence records both before
and after results; timings vary by OS/Node and must not be treated as SLA.

## Exit gate

Keep all Standard six root API functions, Program ABI V1, signed M5 provenance,
S07 Checkpoint/receipt guarantees and stage gates unchanged. M6's S13 real
model Host execution remains separate and blocked until native evidence exists.
