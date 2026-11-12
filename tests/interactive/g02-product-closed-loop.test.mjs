/**
 * G02 product closed loop: a Grok-generated Workflow DSL is compiled by the
 * real FlowKit compiler into JavaScript, then executed on two layers.
 *
 * Standard layer: official compile/check/run() of Agent/Condition/Terminal.
 * Interactive P0-A layer: compileInteractive, immutable JS Program, published
 * Pending, Trusted Host receipts, SQLite close/reopen recovery.
 *
 * Model evidence is M-level. source=grok-model records result consumption
 * bound to an exact Pending (6 uses, 5 distinct authored bodies, 1 reused
 * body rebound to a new requestId/taskDigest). source=scripted-invalid is a
 * deliberate fixture, not a model turn. Local Ed25519 receipts and Node/CLI
 * execution are not native secure Host provenance and must not be graded N-PASS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generateKeyPairSync, sign} from 'node:crypto';
import {compile, check, run, isControlSignal, evalWhen} from '../../src/index.mjs';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {createAgentReceiptStatement, encodeAgentReceiptStatement}
  from '../../src/interactive/host-attestation.mjs';
import {canonicalBytes, sha256Bytes} from '../../src/interactive/canonical.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflowFile = fileURLToPath(new URL(
  '../../examples/g02/feature-review.workflow.js', import.meta.url));
const compiledFile = fileURLToPath(new URL(
  '../../examples/g02/feature-review.compiled.mjs', import.meta.url));
const interactiveFile = fileURLToPath(new URL(
  '../../examples/g02/feature-review.interactive.mjs', import.meta.url));
const mermaidFile = fileURLToPath(new URL(
  '../../examples/g02/feature-review.mmd', import.meta.url));
const editorialFile = fileURLToPath(new URL(
  '../../examples/editorial.workflow.js', import.meta.url));
const skillsRoot = 'examples/g02/skills';
const successFixtureFile = fileURLToPath(new URL(
  '../fixtures/g02/turns-success-retry.json', import.meta.url));
const rejectFixtureFile = fileURLToPath(new URL(
  '../fixtures/g02/turns-review-false.json', import.meta.url));
const REQUEST = '为 FlowKit 维护者增加一条只读的工作流运行摘要查看能力：在不修改现有 Standard Root 六个 API、不引入独立 FlowKit Server 的前提下，允许受信 Host 读取一次运行的终态状态（succeeded/failed/errored）、terminal 节点和公开投影，便于排障。不在本阶段实现 adminTerminate，也不改变 Interactive P0-A 的节点范围。';
const NOW = 1794500000000;
const NAMESPACE = 'g02-feature-review';
const POLICY = {
  deploymentId: 'g02-feature-review-20261112',
  bindingVersions: {skill: 'g02-v1', validator: 'g02-v1'},
};
const compileOptions = {skillsRoot, projectRoot: repoRoot, mermaid: true};

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function validateG02Result(schema, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return ['Agent result must be object'];
  }
  const props = schema.properties ?? {};
  const required = schema.required ?? Object.keys(props);
  for (const key of required) {
    if (!Object.hasOwn(output, key)) return ['missing ' + key];
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(output)) {
      if (!Object.hasOwn(props, key)) return ['unknown ' + key];
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(output, key)) continue;
    if (typeof output[key] !== spec.type) return [key + ' must be ' + spec.type];
    if (spec.type === 'string' && output[key].length < 80) {
      return [key + ' must be at least 80 characters'];
    }
  }
  return [];
}

function assertNoControlChoice(result) {
  const text = JSON.stringify(result);
  assert.equal(Object.hasOwn(result, 'next'), false);
  assert.equal(Object.hasOwn(result, 'nextNode'), false);
  assert.equal(Object.hasOwn(result, 'toBlockId'), false);
  assert.equal(text.includes('"accepted"') && Object.hasOwn(result, 'next'), false);
  assert.match(text, /./);
}

async function loadSkills() {
  const names = ['analyze', 'design', 'review'];
  const skills = {};
  for (const name of names) {
    skills[name] = await readFile(new URL(
      '../../examples/g02/skills/' + name + '.md', import.meta.url), 'utf8');
  }
  return skills;
}

test('G02 Standard compile/check matches checked-in JS artifact and Program is real JavaScript', async () => {
  const compiled = await compile(workflowFile, compileOptions);
  assert.equal(compiled.diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(compiled.diagnostics));
  assert.match(compiled.code, /export async function workflow\(ctx\)/);
  assert.match(compiled.code, /evalWhen\(ctx, "materialsReady"\)/);
  assert.match(compiled.code, /evalWhen\(ctx, "reviewApproved"\)/);
  assert.match(compiled.code, /runStep\(/);
  assert.equal(compiled.code.includes('Mermaid'), false);
  const existing = await readFile(compiledFile);
  assert.equal(sha256(existing), sha256(Buffer.from(compiled.code, 'utf8')));
  const mermaid = await readFile(mermaidFile, 'utf8');
  assert.ok(mermaid.includes('flowchart'));
  const diagnostics = await check(workflowFile, compileOptions);
  assert.equal(diagnostics.some(d => d.severity === 'error'), false,
    JSON.stringify(diagnostics));
});

test('G02 Interactive compile matches checked-in Program bytes and identity hash', async () => {
  const compiled = await compileInteractive(workflowFile, {
    output: 'memory', featureStage: 'P0-A', skillsRoot, skillCheck: true,
    projectRoot: repoRoot,
  });
  assert.equal(compiled.diagnostics.length, 0, JSON.stringify(compiled.diagnostics));
  assert.match(compiled.code, /export const interactiveProgram/);
  assert.match(compiled.code, /export function advance\(/);
  assert.equal(compiled.programIdentity.workflowId, 'g02-feature-review');
  assert.equal(compiled.programIdentity.implementedStage, 'P0-A');
  assert.equal(compiled.programIdentity.artifactHash,
    'sha256:' + sha256(Buffer.from(compiled.code, 'utf8')));
  const existing = await readFile(interactiveFile);
  assert.equal(sha256(existing), sha256(Buffer.from(compiled.code, 'utf8')));
  assert.equal(compiled.programIdentity.artifactHash,
    'sha256:8d811766fd1d58456ce4e58cc2a2f04c4d1e36dd683f86496c2df946cb15eded');
});

test('G02 Standard run covers success, gate-false, review-false and scripted retry; Program chooses branches', async () => {
  const success = JSON.parse(await readFile(successFixtureFile, 'utf8'));
  const rejected = JSON.parse(await readFile(rejectFixtureFile, 'utf8'));
  const payload = {
    analyze: success.turns[0].result,
    designSuccess: success.turns[1].result,
    reviewInvalid: success.turns[2].result,
    reviewApproved: success.turns[3].result,
    designRejected: rejected.turns[1].result,
    reviewRejected: rejected.turns[2].result,
  };
  assert.equal(success.turns[2].source, 'scripted-invalid');
  assert.equal(success.turns[0].source, 'grok-model');
  assert.equal(success.turns[3].source, 'grok-model');
  assert.equal(rejected.turns[2].source, 'grok-model');
  assert.equal(rejected.turns[2].result.reviewApproved, false);

  function runtimeFor(plan) {
    const calls = [];
    return {
      calls,
      isControlSignal,
      evalWhen,
      validateResult: validateG02Result,
      async runAgent(step) {
        calls.push({id: step.id, attempt: step.attempt, missing: step.missing});
        assert.equal(Object.hasOwn(step, 'state'), false);
        const result = plan({id: step.id, attempt: step.attempt});
        assertNoControlChoice(result);
        return result;
      },
    };
  }

  const successRuntime = runtimeFor(({id, attempt}) => {
    if (id === 'analyze') return payload.analyze;
    if (id === 'design') return payload.designSuccess;
    if (id === 'review' && attempt === 1) return payload.reviewInvalid;
    if (id === 'review' && attempt === 2) return payload.reviewApproved;
    throw new Error('unexpected Standard agent call ' + id + ' #' + attempt);
  });
  const successResult = await run(workflowFile, successRuntime, {
    materialsReady: true, request: REQUEST, hostSecret: 'CANARY',
  }, {skillsRoot, projectRoot: repoRoot});
  assert.equal(successResult.status, 'succeeded');
  assert.equal(successResult.terminal, 'accepted');
  assert.equal(successResult.state.reviewApproved, true);
  assert.equal(successResult.state.hostSecret, 'CANARY');
  assert.deepEqual(successRuntime.calls.map(c => [c.id, c.attempt]),
    [['analyze', 1], ['design', 1], ['review', 1], ['review', 2]]);

  const gateRuntime = runtimeFor(() => {
    throw new Error('gate-false must not call runAgent');
  });
  const gateResult = await run(workflowFile, gateRuntime, {
    materialsReady: false, request: REQUEST, hostSecret: 'CANARY',
  }, {skillsRoot, projectRoot: repoRoot});
  assert.equal(gateResult.status, 'failed');
  assert.equal(gateResult.terminal, 'rejected');
  assert.equal(gateRuntime.calls.length, 0);
  assert.equal(gateResult.state.reviewApproved, undefined);

  const rejectRuntime = runtimeFor(({id, attempt}) => {
    if (id === 'analyze') return payload.analyze;
    if (id === 'design') return payload.designRejected;
    if (id === 'review' && attempt === 1) return payload.reviewRejected;
    throw new Error('unexpected reject-path call ' + id + ' #' + attempt);
  });
  const rejectResult = await run(workflowFile, rejectRuntime, {
    materialsReady: true, request: REQUEST, hostSecret: 'CANARY',
  }, {skillsRoot, projectRoot: repoRoot});
  assert.equal(rejectResult.status, 'failed');
  assert.equal(rejectResult.terminal, 'rejected');
  assert.equal(rejectResult.state.reviewApproved, false);
  assert.deepEqual(rejectRuntime.calls.map(c => [c.id, c.attempt]),
    [['analyze', 1], ['design', 1], ['review', 1]]);
});

async function runInteractiveScenario(fixture, {materialsReady = true} = {}) {
  const compiled = await compileInteractive(workflowFile, {
    output: 'memory', featureStage: 'P0-A', skillsRoot, skillCheck: true,
    projectRoot: repoRoot,
  });
  assert.equal(compiled.diagnostics.length, 0);
  const skills = await loadSkills();
  const dir = await mkdtemp(path.join(tmpdir(), 'g02-loop-'));
  const file = path.join(dir, 'run.sqlite');
  const keys = generateKeyPairSync('ed25519');
  const route = [];
  let store;
  try {
    const hostFor = (s) => createTrustedInteractiveHost({
      store: s,
      runtime: {
        skillResolver: async ({agent}) => {
          assert.equal(typeof skills[agent], 'string');
          return skills[agent];
        },
        validateResult: validateG02Result,
      },
      policy: POLICY,
      trustedPublicKeys: {'g02-host': keys.publicKey},
      trustedArtifacts: [compiled.programIdentity.artifactHash],
      allowedInputKeys: ['request', 'requirementSummary', 'designSummary'],
      disclosurePolicyId: 'g02-public-inputs',
      authorizeDisclosure: async ({task}) =>
        ['analyze', 'design', 'review'].includes(task?.nodeId)
        && task?.runId === fixture.runId,
      now: () => NOW,
    });
    store = createSqliteCheckpointStore(file, {namespace: NAMESPACE});
    let host = hostFor(store);
    let frame = await host.start({
      programBytes: Buffer.from(compiled.code, 'utf8'),
      programIdentity: compiled.programIdentity,
      runId: fixture.runId,
      startKey: fixture.startKey,
      state: {materialsReady, request: REQUEST, hostSecret: 'CANARY'},
    });
    const applied = [];
    for (let index = 0; index < fixture.turns.length; index++) {
      assert.equal(frame.status, 'waiting');
      const pending = await host.getPublicAgentTask({runId: fixture.runId});
      assert.ok(pending);
      assert.equal(JSON.stringify(pending).includes('CANARY'), false);
      assert.equal(Object.hasOwn(pending, 'hostSecret'), false);
      assert.equal(Object.hasOwn(pending, 'state'), false);
      const taskDigest = sha256Bytes(canonicalBytes(pending));
      const recorded = fixture.turns[index];
      assert.equal(recorded.nodeId, pending.nodeId);
      assert.equal(recorded.attempt, pending.attempt);
      assert.equal(recorded.requestId, pending.requestId);
      assert.equal(recorded.taskDigest, taskDigest);
      if (recorded.source === 'grok-model') {
        assert.equal(validateG02Result(pending.resultSchema, recorded.result).length, 0);
        assertNoControlChoice(recorded.result);
      } else {
        assert.equal(recorded.source, 'scripted-invalid');
        assert.ok(validateG02Result(pending.resultSchema, recorded.result).length > 0);
      }
      const receipt = {
        runId: fixture.runId,
        requestId: pending.requestId,
        nodeId: pending.nodeId,
        attempt: pending.attempt,
        kind: 'agent-result',
        result: recorded.result,
      };
      const statement = createAgentReceiptStatement({
        run: store.load(fixture.runId), receipt, keyId: 'g02-host',
        proofId: 'g02-' + fixture.scenario + '-turn-' + index,
        issuedAt: NOW - 1000, expiresAt: NOW + 30000,
      });
      const attestation = {
        statement,
        signature: sign(null, encodeAgentReceiptStatement(statement), keys.privateKey)
          .toString('base64url'),
      };
      store.close();
      store = createSqliteCheckpointStore(file, {namespace: NAMESPACE});
      host = hostFor(store);
      const recovered = await host.load({runId: fixture.runId});
      assert.equal(recovered.status, 'waiting');
      assert.equal((await host.getPublicAgentTask({runId: fixture.runId})).requestId,
        pending.requestId);
      frame = await host.accept({receipt, attestation});
      route.push({
        nodeId: pending.nodeId,
        attempt: pending.attempt,
        source: recorded.source,
        statusAfter: frame.status,
        next: frame.pending?.nodeId ?? frame.terminal?.nodeId,
      });
      applied.push(frame);
    }
    return {frame, route, store, compiled};
  } finally {
    store?.close();
    await rm(dir, {recursive: true, force: true});
  }
}

test('G02 Interactive success path binds Grok results, retries scripted invalid review, Program routes to accepted', async () => {
  const fixture = JSON.parse(await readFile(successFixtureFile, 'utf8'));
  const {frame, route} = await runInteractiveScenario(fixture);
  assert.equal(frame.status, 'succeeded');
  assert.equal(frame.terminal.nodeId, 'accepted');
  assert.equal(frame.terminal.status, 'succeeded');
  assert.equal(frame.state.hostSecret, 'CANARY');
  assert.equal(frame.state.reviewApproved, true);
  assert.deepEqual(route.map(r => [r.nodeId, r.attempt, r.source, r.next]), [
    ['analyze', 1, 'grok-model', 'design'],
    ['design', 1, 'grok-model', 'review'],
    ['review', 1, 'scripted-invalid', 'review'],
    ['review', 2, 'grok-model', 'accepted'],
  ]);
  assert.equal(route.length, 4);
  assert.equal(frame.pending ?? null, null);
  assert.equal(Object.hasOwn(fixture.turns[3].result, 'next'), false);
});

test('G02 Interactive reviewApproved=false is routed by the Program to rejected', async () => {
  const fixture = JSON.parse(await readFile(rejectFixtureFile, 'utf8'));
  const {frame, route} = await runInteractiveScenario(fixture);
  assert.equal(frame.status, 'failed');
  assert.equal(frame.terminal.nodeId, 'rejected');
  assert.equal(frame.state.reviewApproved, false);
  assert.equal(fixture.turns.at(-1).result.reviewApproved, false);
  assert.equal(Object.hasOwn(fixture.turns.at(-1).result, 'next'), false);
  assert.equal(route.at(-1).next, 'rejected');
  assert.equal(route.length, 3);
  assert.equal(frame.pending ?? null, null);
});

test('G02 Interactive materialsReady=false never publishes a Pending; Program goes to rejected', async () => {
  const compiled = await compileInteractive(workflowFile, {
    output: 'memory', featureStage: 'P0-A', skillsRoot, skillCheck: true,
    projectRoot: repoRoot,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'g02-gate-'));
  const file = path.join(dir, 'run.sqlite');
  const keys = generateKeyPairSync('ed25519');
  const skills = await loadSkills();
  let store;
  try {
    store = createSqliteCheckpointStore(file, {namespace: NAMESPACE});
    const host = createTrustedInteractiveHost({
      store,
      runtime: {
        skillResolver: async ({agent}) => skills[agent],
        validateResult: validateG02Result,
      },
      policy: POLICY,
      trustedPublicKeys: {'g02-host': keys.publicKey},
      trustedArtifacts: [compiled.programIdentity.artifactHash],
      allowedInputKeys: ['request', 'requirementSummary', 'designSummary'],
      disclosurePolicyId: 'g02-public-inputs',
      authorizeDisclosure: async () => false,
      now: () => NOW,
    });
    const frame = await host.start({
      programBytes: Buffer.from(compiled.code, 'utf8'),
      programIdentity: compiled.programIdentity,
      runId: 'g02-gate-false-20261112',
      startKey: 'g02-gate-false-start',
      state: {materialsReady: false, request: REQUEST, hostSecret: 'CANARY'},
    });
    assert.equal(frame.status, 'failed');
    assert.equal(frame.terminal.nodeId, 'rejected');
    assert.equal(frame.pending ?? null, null);
    assert.equal(await host.getPublicAgentTask({runId: 'g02-gate-false-20261112'}), null);
    assert.equal(frame.state.hostSecret, 'CANARY');
    assert.equal(Object.hasOwn(frame.state, 'requirementSummary'), false);
  } finally {
    store?.close();
    await rm(dir, {recursive: true, force: true});
  }
});


test('G02 fixtures record six grok-model uses, five distinct bodies, and one rebound reuse', async () => {
  const success = JSON.parse(await readFile(successFixtureFile, 'utf8'));
  const rejected = JSON.parse(await readFile(rejectFixtureFile, 'utf8'));
  const all = [...success.turns, ...rejected.turns];
  assert.equal(all.length, 7);
  const grok = all.filter((turn) => turn.source === 'grok-model');
  const scripted = all.filter((turn) => turn.source === 'scripted-invalid');
  assert.equal(grok.length, 6);
  assert.equal(scripted.length, 1);
  const bodyKey = (result) => JSON.stringify(result);
  const distinct = new Set(grok.map((turn) => bodyKey(turn.result)));
  assert.equal(distinct.size, 5);
  const analyzeSuccess = success.turns[0];
  const analyzeReuse = rejected.turns[0];
  assert.equal(analyzeSuccess.nodeId, 'analyze');
  assert.equal(analyzeReuse.nodeId, 'analyze');
  assert.deepEqual(analyzeReuse.result, analyzeSuccess.result);
  assert.notEqual(analyzeReuse.requestId, analyzeSuccess.requestId);
  assert.notEqual(analyzeReuse.taskDigest, analyzeSuccess.taskDigest);
  assert.equal(analyzeReuse.originalAuthoredAt, analyzeSuccess.authoredAt);
  assert.equal(analyzeReuse.reusedAt, analyzeReuse.authoredAt);
  assert.equal(analyzeReuse.reusedFrom.requestId, analyzeSuccess.requestId);
  assert.equal(success.modelResponseUses, 6);
  assert.equal(success.distinctAuthoredBodies, 5);
  assert.equal(success.reusedBodies, 1);
  assert.equal(rejected.modelResponseUses, 6);
  assert.equal(rejected.distinctAuthoredBodies, 5);
  assert.equal(rejected.reusedBodies, 1);
});

test('G02 workflow is a P0-A subset and differs from the editorial Standard golden in node kinds', async () => {
  const g02 = await readFile(workflowFile, 'utf8');
  const editorial = await readFile(editorialFile, 'utf8');
  for (const banned of ["action(", "parallel(", "loop(", "human(", "verification("]) {
    assert.equal(g02.includes(banned), false, 'G02 DSL unexpectedly contains ' + banned);
  }
  for (const required of ["action(", "parallel(", "loop(", "human(", "verification(", "condition(", "node(", "terminal("]) {
    assert.equal(editorial.includes(required), true, 'editorial golden missing ' + required);
  }
});
