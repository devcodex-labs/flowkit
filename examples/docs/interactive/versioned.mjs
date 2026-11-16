// A separate interface layer. Do not pass its frames/Store to Trusted Host APIs.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileInteractive, createSqliteInteractivePersistence, createInteractiveHostContext,
  start, complete, resume } from '@devcodex-labs/flowkit/interactive';

const namespace = 'versioned-guide';
const runtime = {
  skillResolver: { id: 'guide-skill', version: '1', mode: 'trusted-read', implementation: async () => '根据topic生成answer字符串。' },
  validateResult: { id: 'guide-schema', version: '1', mode: 'pure-local',
    implementation: (_schema, value) => typeof value?.answer === 'string' && Object.keys(value).length === 1 ? [] : ['answer required'] },
};
const policy = { id: 'guide-policy', version: '1', disclosePolicyId: 'topic-only', capabilityStage: 'P0-A',
  canonicalizationVersion: 'jcs-rfc8785-v1', bindingManifest: {
    skillResolver: { id: 'guide-skill', version: '1', mode: 'trusted-read' },
    validateResult: { id: 'guide-schema', version: '1', mode: 'pure-local' },
  } };
export async function scenario() {
  const directory = await mkdtemp(path.join(tmpdir(), 'flowkit-versioned-guide-')); await chmod(directory, 0o700);
  let persistence;
  try {
    persistence = createSqliteInteractivePersistence(path.join(directory, 'runs.sqlite'), { namespace });
    const compiled = await compileInteractive(fileURLToPath(new URL('./sample.workflow.js', import.meta.url)), { output: 'memory', featureStage: 'P0-A' });
    if (compiled.diagnostics.some(item => item.severity === 'error')) throw new Error(JSON.stringify(compiled.diagnostics));
    const program = await persistence.programRegistry.putImmutable(Buffer.from(compiled.code), compiled.programIdentity);
    // The callbacks belong to a trusted Host; these synthetic subjects are not OS identities.
    const auth = createInteractiveHostContext({ namespace, subjectId: 'guide-host',
      authorize: request => request.namespace === namespace && request.action !== 'result:read',
      authorizeTask: request => Object.keys(request.task.input).every(key => key === 'topic') });
    const options = { store: persistence.store, programRegistry: persistence.programRegistry, policy, auth };
    const waiting = await start(program, runtime, { approved: true, topic: 'FlowKit', privateNote: 'only Host' }, { ...options, startKey: 'guide-start' });
    assert.equal(waiting.pending.length, 1);
    const resumed = await resume(waiting.runId, runtime, options);
    assert.equal(resumed.pending[0].requestId, waiting.pending[0].requestId);
    // Host-only completion after an authenticated executor callback; fixed fixture here.
    const final = await complete({ kind: 'agent', runId: waiting.runId, requestId: waiting.pending[0].requestId,
      outcome: 'succeeded', result: { answer: '已生成：FlowKit' } }, runtime, options);
    assert.equal(Object.hasOwn(final, 'state'), false);
    const auditor = createInteractiveHostContext({ namespace, subjectId: 'guide-auditor',
      authorize: request => request.namespace === namespace && request.action === 'result:read', authorizeTask: () => false });
    const result = await auditor.readTerminalResult(final.resultRef, options);
    return { status: final.status, terminal: final.terminal.nodeId, pending: final.pending.length,
      samePendingOnResume: true, answer: result.state.answer };
  } finally { try { persistence?.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await scenario(), null, 2));
