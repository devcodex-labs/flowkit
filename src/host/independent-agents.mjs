import { during } from '../runtime/tasks.mjs';

const nonempty = value => typeof value === 'string' && value.length > 0;

/** Consume Host-selected execution subjects without creating an Agent registry or sessions. */
export function createIndependentAgentAdapter({ scope, select, authorize, independentFrom = () => null,
  limits = {} }) {
  if (!nonempty(scope) || typeof select !== 'function' || typeof authorize !== 'function' || typeof independentFrom !== 'function') {
    throw new TypeError('Independent Agent routing requires a Host scope, selector and authorization');
  }
  const { maxConcurrent = 4, maxSessions = 64, timeoutMs = 30000 } = limits;
  if (![maxConcurrent, maxSessions, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Host execution limits must be positive integers');
  }
  const sessions = new Map();
  const activeRuns = new Map();
  let active = 0;
  const runKey = (artifactHash, runId) => JSON.stringify([scope, artifactHash, runId]);

  return Object.freeze({
    async runAgentTask(prepared, context = {}) {
      const task = prepared.task;
      const artifactHash = task.workflow.artifactHash;
      const runId = task.run.runId;
      const nodeId = task.node.id;
      const owner = runKey(artifactHash, runId);
      const deadline = Math.min(task.execution.deadlineMs ?? Infinity, context.deadlineMs ?? Infinity, Date.now() + timeoutMs);
      const timer = AbortSignal.timeout(Math.max(1, Math.min(2147483647, deadline - Date.now())));
      const signal = context.signal ? AbortSignal.any([timer, context.signal]) : timer;
      const events = [];
      let started = false;
      let released = false;
      let binding;
      let physical;
      let selection;
      let cancellation;
      const useBinding = operation => {
        physical = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return operation();
        });
        return during(signal, () => physical);
      };
      const release = () => {
        if (released) return;
        released = true;
        active--;
        const count = activeRuns.get(owner) - 1;
        if (count === 0) activeRuns.delete(owner);
        else activeRuns.set(owner, count);
      };
      if (active >= maxConcurrent) return { status: 'failed', failure: { code: 'agent-capacity',
        message: 'Host execution capacity is occupied', retryable: false, sideEffectStatus: 'none' }, events };
      active++;
      activeRuns.set(owner, (activeRuns.get(owner) ?? 0) + 1);
      try {
        signal.throwIfAborted();
        if (![artifactHash, runId, nodeId].every(nonempty)) throw new Error('Task execution identity is incomplete');
        const selected = useBinding(() => select({ scope, artifactHash, runId, nodeId, prepared, signal }));
        selection = physical;
        binding = await selected;
        if (!binding || !['subjectId', 'sessionId', 'workspaceRef', 'permissionRef'].every(key => nonempty(binding[key])) ||
          typeof binding.runAgentTask !== 'function' || binding.artifactHash !== artifactHash || binding.runId !== runId || binding.nodeId !== nodeId) {
          throw new Error('Host returned an incomplete or mismatched execution binding');
        }
        const other = await useBinding(() => independentFrom(prepared));
        if (other && (binding.subjectId === other.subjectId || binding.sessionId === other.sessionId || binding.workspaceRef === other.workspaceRef)) {
          throw new Error('An independent review execution subject, session and workspace are required');
        }
        if (await useBinding(() => authorize({ scope, artifactHash, runId, nodeId,
          subjectId: binding.subjectId, sessionId: binding.sessionId, workspaceRef: binding.workspaceRef, permissionRef: binding.permissionRef, signal })) !== true) {
          throw new Error('Host denied the selected execution binding');
        }
        const session = JSON.stringify([scope, binding.sessionId]);
        const previous = sessions.get(session);
        if (previous !== undefined && previous !== owner) throw new Error('The selected Host session belongs to a different Run or Artifact');
        if (previous === undefined && sessions.size >= maxSessions) throw new Error('Host session binding budget is exhausted');
        sessions.set(session, owner);
        signal.throwIfAborted();
        events.push({ type: 'host-execution-bound', subjectId: binding.subjectId, sessionId: binding.sessionId,
          workspaceRef: binding.workspaceRef, permissionRef: binding.permissionRef, artifactHash, runId, nodeId });
        const result = await useBinding(() => {
          started = true;
          return binding.runAgentTask(prepared, { ...context, signal });
        });
        signal.throwIfAborted();
        if (!result || !Array.isArray(result.events) || !['succeeded', 'failed', 'cancelled'].includes(result.status)) {
          throw new Error('Host execution returned an invalid Agent result');
        }
        return { ...result, events: [...events, ...result.events] };
      } catch (error) {
        if (signal.aborted && (!binding || typeof binding.cancel === 'function')) {
          cancellation = (binding ? Promise.resolve(binding) : selection)?.then(selected => selected?.cancel?.());
        }
        if (context.signal?.aborted) return { status: 'cancelled', reason: 'Host cancelled the routed task',
          sideEffectStatus: started ? 'unknown' : 'none', events };
        return { status: 'failed', failure: { code: signal.aborted ? 'agent-deadline' : 'agent-binding-rejected',
          message: String(error?.message ?? error), retryable: false, sideEffectStatus: started ? 'unknown' : 'none' }, events };
      } finally {
        // Logical cancellation can precede a resource-owning selector or the binding cleanup.
        if (signal.aborted && cancellation) Promise.allSettled([physical, cancellation]).then(release);
        else if (signal.aborted && physical) physical.then(release, release);
        else release();
      }
    },
    releaseRun(artifactHash, runId) {
      const owner = runKey(artifactHash, runId);
      if (activeRuns.has(owner)) throw new Error('Host executions for this Run are still active');
      for (const [session, current] of sessions) if (current === owner) sessions.delete(session);
    },
    status() { return { activeExecutions: active, sessionBindings: sessions.size }; }
  });
}
