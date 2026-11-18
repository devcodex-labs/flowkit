import { fixture, context } from './author-host-fixture.mjs';
import path from 'node:path';

// A parent-owned disposable worker stops after a durable reservation, before any Provider call.
process.stdin.resume();
const publishing = process.argv[3] === 'publication'; let publication;
const f = await fixture(process.argv[2], publishing ? { discovery: { root: path.join(path.dirname(process.argv[2]), 'owned'),
  async readMapping() { process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, publication }) + '\n'); return new Promise(() => {}); },
  async compareAndSetMapping() {} } } : {});
if (publishing) {
  await f.register(); const initial = await f.start();
  const ready = await f.host.advanceTurn({ draftId: initial.id, expectedStateVersion: initial.stateVersion, turnId: 'turn', input: 'Inspect' }, context);
  f.approvals.set('approved', ready.candidate.hash);
  const approved = await f.host.recordApproval({ draftId: ready.id, expectedStateVersion: ready.stateVersion,
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'approved' }, context);
  publication = { draftId: ready.id, expectedStateVersion: approved.stateVersion, publicationId: 'killed-after-save',
    candidateHash: ready.candidate.hash, previousHash: null, reviewRef: ready.reviewReceipt.reviewRef, approvalRef: 'approved' };
  await f.host.publish(publication, context);
} else {
const draft = await f.start();
f.options.execution.request = async () => {
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, draftId: draft.id, stateVersion: draft.stateVersion }) + '\n');
  return new Promise(() => {});
};
await f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'crash-turn', input: 'Inspect' }, context);
}
