# Host integration

## Contents

[First integration](#first-integration) · [Runtime methods](#runtime-methods) · [Validation and retry](#validation-and-retry) · [State and approvals](#state-and-approvals) · [Loading and cancellation](#loading-and-cancellation)

## First integration

Build the checkout and run `node examples/demo.mjs`. Then copy
[the host template](../examples/host.mjs), replacing each injected service with
your implementation. Start with one action, then add agents, approval and remote
Skills. Do not import and execute a workflow definition to compile it: pass its
`.workflow.js` or `.workflow.ts` filename to Flowkit.

The package exposes exactly six functions: `run`, `compile`, `compileSource`,
`check`, `evalWhen`, `isControlSignal`. DSL constructors come from
`@devcodex/flowkit/dsl`. Full signatures are in the packaged declarations.

## Runtime methods

| Method | Host responsibility |
|---|---|
| `isControlSignal(error)` | Required; the exported helper checks `error.control === true`; native AbortError/TimeoutError do not automatically qualify |
| `evalWhen(ctx, expression)` | Bind the exported restricted evaluator when using conditions; it is not JavaScript eval |
| `runAgent(step)` | Execute the Skill instruction and return a result object; inspect `input`, `missing`, `resultSchema`, `attempt`, `reasons`, `signal`, `runId` |
| `validateResult(schema, result)` | Synchronous complete schema validation returning an array of readable reasons; success is `[]` |
| `checkStep(step, result, ctx)` | Optional async hook; null/undefined accepts; every string, including empty string, rejects; other return types are contract errors |
| `runVerification(verifier, name, ctx)` | Return a strict boolean; false chooses the defined failure/repair path |
| `runHuman(name, ctx)` | Return boolean or `{approved:boolean, comment?:string|null}` from the current approval request |
| `runAction(action, name, ctx)` | Execute the named business action and update `ctx.state` when needed; ordinary return values do not supply state writes |
| `loadSkill(path, options)` / `loadSkillByAgent(agent)` | Optional overrides; omitted methods use the built-in loader per execution |
| `trace.start/end` | Optional synchronous hooks; hook exceptions are ignored; `end` outcome is `ok`, `error` or `control` |

Only methods required by nodes that execute are called. Runtime method `this`
remains the supplied Runtime object. `checkStep` is optional. Setting a loader
method to null does not request the default implementation; omit it instead.

## Validation and retry

The pipeline is `runAgent → validateResult → checkStep → optional verify → commit`.
Failed validation/hook/verification retries at most `retries + 1` attempts. The
default is `retries:2`, so at most three attempts; `retries:0` means one attempt.
Hook or validator exceptions propagate; they are not model retry reasons.
An ordinary model rejection is retried and may become `FK_R004`, carrying
`reasons` and a conditional `cause`. Control signals propagate immediately.

Bind an actual JSON Schema validator matching your dialect (the confirmed
contract uses object schemas and permits nested schema keywords). Convert its
errors into strings; do not silently accept unsupported keywords. The template's
small `validateExample` is limited to its documented flat schemas. A real model
and a real approval backend require consumer integration acceptance; the demo
does not provide those services.

## State and approvals

Initial state is shallow copied. Inputs select own string keys; a missing key is
present in `step.input` with value undefined and is also listed in `step.missing`.
Keys such as `__proto__` remain data properties. Successful agent results merge
own keys after validation. Optional verification sees a candidate state before
commit. This is not a transaction or deep isolation boundary.

Parallel branches share state. Declare disjoint output/write keys. `any` does not
cancel losing branches, which can finish and mutate shared state after a winner.
`all_succeeded` uses the first rejection; `any` gives a control signal priority
before success and aggregates ordinary all-failed rejections.

Human rejection executes its repair chain and requests a fresh approval. Store
approval request identity and persistence in the host service; do not reuse an old
approved response. Loop verification runs at most `maxIterations` times; the last
failure exits without one extra repair. A terminal returns `status`, `terminal`
and actual state. `error` exists only after an ordinary action catch, even if the
caught value was undefined, null or zero. Uncaught business failures reject `run`.

## Loading and cancellation

Set `projectRoot` explicitly when using external workflow files. Local Skill
references use portable relative forward-slash paths ending in `.md`; real paths
must remain within projectRoot. Remote references require HTTPS, exact allowed
host/port, and optionally one sha256/384/512 SRI digest of the original bytes.
The loader permits at most three same-origin redirects, ten seconds and 262144
bytes. Skills decode as strict UTF-8. A custom loader owns its own transport,
validation and cancellation contract.

Pass `signal` to `run`; host business services must observe `step.signal` or
`ctx.signal`. At the host boundary, mark business cancellation errors with
`control:true` or supply a predicate that recognizes your native abort errors;
otherwise an ordinary agent rejection can be retried and become FK_R004.
Flowkit does not forcibly interrupt arbitrary host promises. Remote
default loading observes abort and releases its resources. No workflow sandbox
is provided: generated JavaScript and host Runtime are trusted application code.

`run` accepts source or verified `.compiled.mjs` AOT. AOT needs its referenced
source and matching raw source/body hashes. Optional `dump` writes canonical
generated code and restores ordinary edits. Keep matching source and artifact
together; regenerate after changing source or compile options.
