import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileInteractive, createSqliteCheckpointStore, createTrustedInteractiveHost,
  normalizeHostAgentReceipt, createAgentReceiptStatement, encodeAgentReceiptStatement } from '@devcodex-labs/flowkit/interactive';

const file = fileURLToPath(new URL('./sample.workflow.js', import.meta.url));
const namespace = 'guide-tenant';
export async function scenario(kind = 'approved') {
  assert.ok(['approved', 'closed', 'retry'].includes(kind));
  const compiled = await compileInteractive(file, { output: 'memory', featureStage: 'P0-A' });
  if (compiled.diagnostics.some(item => item.severity === 'error')) throw new Error(JSON.stringify(compiled.diagnostics));
  const directory = await mkdtemp(path.join(tmpdir(), 'flowkit-interactive-guide-'));
  await chmod(directory, 0o700);
  let store;
  try {
    store = createSqliteCheckpointStore(path.join(directory, 'runs.sqlite'), { namespace });
    // One-use demonstration keys remain in this Host process; never export privateKey.
    const keys = generateKeyPairSync('ed25519');
    const runtime = {
      async skillResolver(descriptor) {
        assert.equal(descriptor.skill, 'skills/writer.md');
        return readFile(new URL('./skills/writer.md', import.meta.url), 'utf8');
      },
      validateResult(_schema, result) {
        return result && typeof result === 'object' && !Array.isArray(result)
          && typeof result.answer === 'string' && Object.keys(result).length === 1 ? [] : ['需要且仅允许answer字符串'];
      },
    };
    // Role is a Host-owned fixture, not a model/user supplied identity assertion.
    const forRole = role => createTrustedInteractiveHost({ store, runtime,
      trustedPublicKeys: { guide: keys.publicKey }, trustedArtifacts: [compiled.programIdentity.artifactHash],
      allowedInputKeys: ['topic'], disclosurePolicyId: 'guide-topic-only',
      authorizeDisclosure: request => request.namespace === namespace
        && Object.keys(request.task.input).every(key => key === 'topic'),
      authorizeTerminalAccess: request => request.namespace === namespace
        && (request.action === 'run:read' || role === 'auditor'),
    });
    const host = forRole('operator');
    let modelCalls = 0, signatureVerified = false;
    let frame = await host.start({ programBytes: Buffer.from(compiled.code), programIdentity: compiled.programIdentity,
      startKey: 'guide-' + kind, state: { approved: kind !== 'closed', topic: 'FlowKit', privateNote: 'only Host' } });
    // A real transport sends only this authorized task to its separate Model worker.
    while (frame.status === 'waiting') {
      assert.ok(modelCalls < 2);
      const task = await host.getPublicAgentTask({ runId: frame.runId });
      assert.deepEqual(Object.keys(task.input), ['topic']);
      assert.ok(!JSON.stringify(task).includes('only Host'));
      if (task.attempt > 1) assert.ok(task.reasons.length > 0);
      modelCalls++;
      // Fixed response: this is not a Codex/OS authentication or isolation test.
      const result = kind === 'retry' && modelCalls === 1 ? { answer: 0 } : { answer: '已生成：' + task.input.topic };
      // The Host observed this fixture call. In production bind these identifiers
      // to the trusted transport's actual start/callback observations before signing.
      const receipt = normalizeHostAgentReceipt({ runId: task.runId, requestId: task.requestId,
        nodeId: task.nodeId, attempt: task.attempt, kind: 'agent-result', result });
      const issuedAt = Date.now();
      const statement = createAgentReceiptStatement({ run: store.load(frame.runId), receipt,
        keyId: 'guide', proofId: 'guide-call-' + modelCalls, issuedAt, expiresAt: issuedAt + 60000 });
      const bytes = encodeAgentReceiptStatement(statement);
      const signature = sign(null, bytes, keys.privateKey).toString('base64url');
      signatureVerified = verify(null, bytes, keys.publicKey, Buffer.from(signature, 'base64url'));
      assert.equal(signatureVerified, true);
      frame = await host.accept({ receipt, attestation: { statement, signature } });
    }
    const publicFrame = await host.getPublicTerminalFrame({ runId: frame.runId });
    assert.equal(Object.hasOwn(publicFrame, 'state'), false);
    const auditResult = await forRole('auditor').readTrustedTerminalResult({ resultRef: publicFrame.resultRef });
    assert.equal(auditResult.state.privateNote, 'only Host');
    return { status: publicFrame.status, terminal: publicFrame.terminal.nodeId, modelCalls, signatureVerified,
      ...(auditResult.state.answer === undefined ? {} : { answer: auditResult.state.answer }) };
  } finally {
    try { store?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(process.argv[2] ?? 'approved'), null, 2));
