import { fixture, context } from './author-host-fixture.mjs';

// A parent-owned disposable worker stops after a durable reservation, before any Provider call.
process.stdin.resume();
const f = await fixture(process.argv[2]);
const draft = await f.start();
f.options.execution.request = async () => {
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid, draftId: draft.id, stateVersion: draft.stateVersion }) + '\n');
  return new Promise(() => {});
};
await f.host.advanceTurn({ draftId: draft.id, expectedStateVersion: draft.stateVersion, turnId: 'crash-turn', input: 'Inspect' }, context);
