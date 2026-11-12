/**
 * Maintainer helper: replay G02 Interactive fixtures through the real
 * compileInteractive Program, SQLite Store and Trusted Host.
 * Local test signatures and Node execution are not native Host provenance.
 */
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync, sign} from 'node:crypto';
import {compileInteractive} from '../../src/interactive/compile.mjs';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';
import {createTrustedInteractiveHost} from '../../src/interactive/trusted-host.mjs';
import {createAgentReceiptStatement, encodeAgentReceiptStatement}
  from '../../src/interactive/host-attestation.mjs';
import {canonicalBytes, sha256Bytes} from '../../src/interactive/canonical.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const workflow = fileURLToPath(new URL('./feature-review.workflow.js', import.meta.url));
const success = JSON.parse(await readFile(new URL(
  '../../tests/fixtures/g02/turns-success-retry.json', import.meta.url), 'utf8'));
const rejected = JSON.parse(await readFile(new URL(
  '../../tests/fixtures/g02/turns-review-false.json', import.meta.url), 'utf8'));
const skillsRoot = path.join(repoRoot, 'examples/g02/skills');
const NOW = 1794500000000;

function validate(schema, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ['Agent result must be object'];
  const props = schema.properties ?? {};
  const required = schema.required ?? Object.keys(props);
  for (const key of required) if (!Object.hasOwn(output, key)) return ['missing ' + key];
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(output)) if (!Object.hasOwn(props, key)) return ['unknown ' + key];
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(output, key)) continue;
    if (typeof output[key] !== spec.type) return [key + ' must be ' + spec.type];
    if (spec.type === 'string' && output[key].length < 80) return [key + ' must be at least 80 characters'];
  }
  return [];
}

const skills = {
  analyze: await readFile(new URL('./skills/analyze.md', import.meta.url), 'utf8'),
  design: await readFile(new URL('./skills/design.md', import.meta.url), 'utf8'),
  review: await readFile(new URL('./skills/review.md', import.meta.url), 'utf8'),
};

const compiled = await compileInteractive(workflow, {
  output: 'memory', featureStage: 'P0-A', skillsRoot, skillCheck: true, projectRoot: repoRoot,
});
if (compiled.diagnostics.some((d) => d.severity === 'error')) {
  throw new Error(JSON.stringify(compiled.diagnostics));
}

async function replay(fixture, materialsReady = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'g02-run-'));
  const file = path.join(dir, 'run.sqlite');
  const keys = generateKeyPairSync('ed25519');
  let store;
  const route = [];
  try {
    const hostFor = (s) => createTrustedInteractiveHost({
      store: s,
      runtime: {
        skillResolver: async ({agent}) => skills[agent],
        validateResult: validate,
      },
      policy: {
        deploymentId: 'g02-feature-review-20261112',
        bindingVersions: {skill: 'g02-v1', validator: 'g02-v1'},
      },
      trustedPublicKeys: {'g02-host': keys.publicKey},
      trustedArtifacts: [compiled.programIdentity.artifactHash],
      allowedInputKeys: ['request', 'requirementSummary', 'designSummary'],
      disclosurePolicyId: 'g02-public-inputs',
      authorizeDisclosure: async ({task}) =>
        ['analyze', 'design', 'review'].includes(task?.nodeId) && task?.runId === fixture.runId,
      now: () => NOW,
    });
    store = createSqliteCheckpointStore(file, {namespace: 'g02-feature-review'});
    let host = hostFor(store);
    let frame = await host.start({
      programBytes: Buffer.from(compiled.code, 'utf8'),
      programIdentity: compiled.programIdentity,
      runId: fixture.runId, startKey: fixture.startKey,
      state: {materialsReady, request: fixture.request, hostSecret: 'CANARY'},
    });
    for (let index = 0; index < (fixture.turns ?? []).length; index++) {
      const pending = await host.getPublicAgentTask({runId: fixture.runId});
      const recorded = fixture.turns[index];
      const taskDigest = sha256Bytes(canonicalBytes(pending));
      if (recorded.requestId !== pending.requestId || recorded.taskDigest !== taskDigest) {
        throw new Error('fixture does not bind to live Pending at ' + index);
      }
      const receipt = {
        runId: fixture.runId, requestId: pending.requestId, nodeId: pending.nodeId,
        attempt: pending.attempt, kind: 'agent-result', result: recorded.result,
      };
      const statement = createAgentReceiptStatement({
        run: store.load(fixture.runId), receipt, keyId: 'g02-host',
        proofId: 'g02-replay-' + fixture.scenario + '-' + index,
        issuedAt: NOW - 1000, expiresAt: NOW + 30000,
      });
      const attestation = {
        statement,
        signature: sign(null, encodeAgentReceiptStatement(statement), keys.privateKey).toString('base64url'),
      };
      store.close();
      store = createSqliteCheckpointStore(file, {namespace: 'g02-feature-review'});
      host = hostFor(store);
      frame = await host.accept({receipt, attestation});
      route.push({
        source: recorded.source, nodeId: pending.nodeId, attempt: pending.attempt,
        requestId: pending.requestId, statusAfter: frame.status,
        next: frame.pending?.nodeId ?? frame.terminal?.nodeId ?? null,
      });
    }
    return {
      layer: 'interactive-p0a',
      scenario: fixture.scenario ?? (materialsReady ? 'unknown' : 'gate-false'),
      status: frame.status,
      terminal: frame.terminal ?? null,
      reviewApproved: frame.state?.reviewApproved ?? null,
      // pendingAtEnd is the terminal frame only. publishedPendingCount is
      // measured from Pendings actually observed on this run's route.
      pendingAtEnd: (frame.pending ?? null) != null,
      publishedPendingCount: route.length,
      route,
      programHash: compiled.programIdentity.artifactHash,
      evidenceNote: 'Interactive Program + SQLite + local test receipts via Node. Not N-PASS. Not native secure Host provenance.',
    };
  } finally {
    store?.close();
    await rm(dir, {recursive: true, force: true});
  }
}

const gate = {
  scenario: 'gate-false',
  runId: 'g02-gate-false-20261112',
  startKey: 'g02-gate-false-start',
  request: success.request,
  turns: [],
};

const output = [
  await replay(success),
  await replay(gate, false),
  await replay(rejected),
];
console.log(JSON.stringify(output, null, 2));
