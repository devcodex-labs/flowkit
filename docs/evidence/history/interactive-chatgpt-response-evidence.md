# ChatGPT-authored response evidence for FlowKit Interactive

**Evidence tier: M-level recorded model response. This is not native S13.**

## What the experiment does

1. FlowKit compiles the Interactive workflow and durably creates a public Agent Pending in SQLite.
2. The test emits the exact `runId`, `requestId`, `taskDigest`, Program artifact hash and allowlisted task input.
3. A ChatGPT model reads that Pending evidence in the conversation and authors a structured response.
4. The response is returned through an authenticated GitHub tool action and stored as a fixture.
5. A later test run deterministically reconstructs the same Pending and rejects the fixture unless all identity fields match exactly.
6. The trusted Host validates the result, signs its own Host receipt, commits through CAS, verifies duplicate Ack and resumes the Run.

## What it proves

- A ChatGPT-authored response was produced after inspection of a real FlowKit Pending.
- The response is bound to the exact deterministic Pending by `runId/requestId/taskDigest`.
- FlowKit's actual Program, SQLite Store and Trusted Host process that recorded response.
- Host signature/CAS, duplicate receipt and same-phase SQLite close/reopen behavior.

## What it does not prove

- The ChatGPT model invoked a FlowKit-native JavaScript tool. The response is returned through a GitHub tool action, not a native FlowKit JS-tool call.
- Independent cryptographic attestation of the ChatGPT provider/session identity.
- Grok Build or Codex native tool-call provenance.
- Cross-UID / OS-level model-process isolation.
- One physical SQLite database surviving across the separate Pending-preparation and response-acceptance Actions runs. The second run reconstructs the deterministic Pending and uses its own database.

Therefore this evidence is useful for M-level real-model participation and response-binding tests, but **must not be counted as native Host S13 / C12 PASS**.

## Test execution modes

Normal CI must consume the complete committed response fixture and reach Terminal. If the fixture is absent, the test fails.

Only an explicit preparation invocation may stop at Pending:

```bash
FLOWKIT_S13_PREPARE=1 node --test tests/interactive/s13-chatgpt-tool-bridge.test.mjs
```

The preparation mode is not used by the normal CI workflow.
