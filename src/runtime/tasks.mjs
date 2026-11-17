import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DESCRIPTION_MAX_BYTES, isSemVer } from '../shared/task-spec.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { createDescriptionResources } from './task-resources.mjs';

const failure = (kind, message, cause) => Object.assign(new Error(`FK_R004 ${message}`, { cause }),
  { code: 'FK_R004', kind });

function snapshot(value, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || active.has(value) ||
      !Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    throw failure('invalid-task', 'Task data must be serializable JSON');
  }
  active.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const read = key => {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw failure('invalid-task', 'Task data must contain own data values');
    }
    return snapshot(descriptor.value, active);
  };
  const copy = Array.isArray(value) ? Array.from({ length: value.length }, (_, index) => read(index)) :
    Object.fromEntries(Object.keys(value).map(key => [key, read(key)]));
  active.delete(value);
  return Object.freeze(copy);
}

function positive(value, fallback, label) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw failure('invalid-task', `Invalid ${label}`);
  return limit;
}

function createBudget(policy, signal) {
  const deadlineMs = positive(policy.deadlineMs, Date.now() + 600000, 'deadlineMs');
  const maxDispatches = positive(policy.maxDispatches, 1024, 'maxDispatches');
  const limits = policy.hostProfile?.resourceLimits;
  const maxResourceBytes = Math.min(positive(policy.maxResourceBytes, DESCRIPTION_MAX_BYTES, 'maxResourceBytes'),
    positive(limits?.maxResourceBytes, Number.MAX_SAFE_INTEGER, 'Host maxResourceBytes'));
  const maxTotalResourceBytes = positive(policy.maxTotalResourceBytes, 1048576, 'maxTotalResourceBytes');
  const maxTaskBytes = Math.min(positive(policy.maxTaskBytes, 1048576, 'maxTaskBytes'),
    positive(limits?.maxTaskBytes, Number.MAX_SAFE_INTEGER, 'Host maxTaskBytes'));
  let used = 0;
  function check() {
    if (signal?.aborted) throw failure('cancelled', 'Task was cancelled', signal.reason);
    if (Date.now() >= deadlineMs) throw failure('node-deadline-exceeded', 'Task deadline exceeded');
  }
  return Object.freeze({ deadlineMs, maxResourceBytes, maxTotalResourceBytes, maxTaskBytes, check,
    dispatch() {
      check();
      if (used >= maxDispatches) throw failure('dispatch-limit', 'Run dispatch limit reached');
      used++;
    } });
}

function during(signal, action) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return action();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function validateSize(value, limit, label) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > limit) throw failure('task-limit', `${label} uses ${bytes} bytes, maximum ${limit}`);
}

function validateResultEnvelope(value) {
  const result = snapshot(value);
  if (!result || !Array.isArray(result.events) || !['succeeded', 'failed', 'cancelled'].includes(result.status)) {
    throw failure('invalid-result', 'Expected an AgentExecutionResult envelope');
  }
  if (result.status === 'succeeded' && (!result.result || Array.isArray(result.result) || typeof result.result !== 'object')) {
    throw failure('invalid-result', 'Successful agent result must contain a JSON object');
  }
  if (result.status === 'failed' && (!result.failure || typeof result.failure.code !== 'string' ||
      typeof result.failure.message !== 'string' || typeof result.failure.retryable !== 'boolean' ||
      !['none', 'known', 'unknown'].includes(result.failure.sideEffectStatus))) {
    throw failure('invalid-result', 'Failed agent result must classify retry and side effects');
  }
  if (result.status === 'cancelled' && (typeof result.reason !== 'string' ||
      !['none', 'known', 'unknown'].includes(result.sideEffectStatus))) {
    throw failure('invalid-result', 'Cancelled agent result must classify its side effects');
  }
  const usage = result.usage;
  if (usage !== undefined) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
      throw failure('invalid-result', 'Usage must be an object');
    }
    for (const name of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'toolCalls', 'durationMs']) {
      if (Object.hasOwn(usage, name) && (!Number.isSafeInteger(usage[name]) || usage[name] < 0)) {
        throw failure('invalid-result', `Invalid usage value: ${name}`);
      }
    }
    if (Object.hasOwn(usage, 'cost') && (!usage.cost || !Number.isFinite(usage.cost.amount) || usage.cost.amount < 0 ||
        typeof usage.cost.currency !== 'string' || !usage.cost.currency || !['billed', 'estimated'].includes(usage.cost.basis))) {
      throw failure('invalid-result', 'Invalid cost observation');
    }
  }
  return result;
}

function writeResult(target, result) {
  for (const key of Object.keys(result)) {
    Object.defineProperty(target, key, { value: result[key], enumerable: true, writable: true, configurable: true });
  }
}

/** Host calls handle actual preparation and dispatch; compiled code retains control and business writes. */
export function createPreparedAgentRunner(ctx, options, artifact) {
  const { runtime, signal, state, runId } = ctx;
  const policy = runtime.taskPolicy ?? {};
  let sharedBudget, taskSignal;
  return async function runPreparedAgent(spec, step, checkStep, verifyStep) {
    if (!artifact || typeof runtime.runAgentTask !== 'function' || typeof runtime.validateResult !== 'function') {
      throw failure('capability-unavailable', 'Prepared task execution requires an artifact, runAgentTask and validateResult');
    }
    const budget = sharedBudget ??= createBudget(policy, signal);
    budget.check();
    if (!taskSignal) {
      const expires = AbortSignal.timeout(Math.max(1, Math.min(2147483647, budget.deadlineMs - Date.now())));
      taskSignal = signal ? AbortSignal.any([signal, expires]) : expires;
    }
    const input = snapshot(Object.fromEntries(spec.inputs.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])));
    const missing = spec.inputs.filter(key => !Object.hasOwn(state, key));
    const activationId = randomUUID();
    const descriptionResources = await during(taskSignal, () =>
      createDescriptionResources(spec.task.descriptionRefs ?? [], policy, options, budget, taskSignal));
    let reasons = [];
    let frozenManifest;
    for (let attempt = 1; attempt <= spec.retries + 1; attempt++) {
      budget.check();
      const task = snapshot({
        protocolVersion: 2,
        workflow: { ...spec.workflow, ...artifact },
        run: { runId },
        node: { id: spec.id, name: spec.name },
        task: spec.task,
        input,
        missing,
        outputSchema: spec.output,
        execution: { activationId, requestId: randomUUID(), deadlineMs: budget.deadlineMs,
          attempt, reasons, ...(spec.overview ? { overviewStep: step } : {}) }
      });
      validateSize(task, budget.maxTaskBytes, 'Task');
      const requiredSkills = spec.task.requiredSkills ?? [];
      const context = Object.freeze({ signal: taskSignal, deadlineMs: budget.deadlineMs, budget, projectRoot: policy.projectRoot,
        hostProfile: policy.hostProfile, authorizationContextRef: policy.authorizationContextRef,
        descriptionResources });
      if (requiredSkills.length && typeof runtime.prepareAgentTask !== 'function') {
        throw failure('required-skill-missing', 'Required Skills need host preparation');
      }
      const profile = policy.hostProfile;
      if (requiredSkills.length && (profile?.schemaVersion !== 1 ||
          !Array.isArray(profile.executionModes) || !profile.executionModes.includes('standard') ||
          !['nativeSkillDiscovery', 'skillResourceLoading'].some(capability => profile.capabilities?.[capability] === 'supported'))) {
        throw failure('capability-unavailable', 'Required Skill capability is unknown or unsupported for the current Host');
      }
      const prepared = snapshot(typeof runtime.prepareAgentTask === 'function' ?
        await during(taskSignal, () => runtime.prepareAgentTask(task, context)) :
        { protocolVersion: 2, task, descriptionResources, skills: [] });
      if (!prepared || prepared.protocolVersion !== 2 || !isDeepStrictEqual(prepared.task, task) ||
          !isDeepStrictEqual(prepared.descriptionResources, descriptionResources) || !Array.isArray(prepared.skills) ||
          prepared.skills.length !== requiredSkills.length ||
          requiredSkills.some((skill, index) => {
            const bound = prepared.skills[index];
            return !bound || bound.logicalId !== skill.id || !isSemVer(bound.resolvedVersion) ||
              skill.version && bound.resolvedVersion !== skill.version || !/^sha256:[0-9a-f]{64}$/.test(bound.digest);
          })) throw failure('invalid-preparation', 'Prepared task or required Skill identity differs');
      const resources = [
        ...descriptionResources.map(({ uri, role, digest, byteLength }) => ({ logicalId: uri, role, digest, byteLength })),
        ...prepared.skills.map(({ logicalId, resolvedVersion, digest }) => ({ logicalId, resolvedVersion, digest }))
      ];
      const manifestHash = artifactDigest(JSON.stringify(resources));
      if (frozenManifest !== undefined && manifestHash !== frozenManifest) {
        throw failure('invalid-preparation', 'Required resource identity changed within one activation');
      }
      frozenManifest = manifestHash;
      const dispatched = snapshot({ ...prepared, resourceManifest: { manifestId: manifestHash, manifestHash, resources } });
      validateSize(dispatched, budget.maxTaskBytes, 'Prepared task');
      budget.dispatch();
      const envelope = validateResultEnvelope(await during(taskSignal, () => runtime.runAgentTask(dispatched, context)));
      runtime.recordAgentResult?.(task, envelope);
      budget.check();
      if (envelope.status === 'cancelled') throw failure('cancelled', envelope.reason);
      if (envelope.status === 'failed') {
        const outcome = envelope.failure;
        if (!outcome.retryable || outcome.sideEffectStatus !== 'none') throw failure(outcome.code, outcome.message);
        reasons = [outcome.message];
        continue;
      }
      const result = envelope.result;
      reasons = runtime.validateResult(spec.output, result);
      if (!Array.isArray(reasons) || !reasons.every(reason => typeof reason === 'string')) {
        throw failure('invalid-result', 'validateResult must return validation messages');
      }
      if (!reasons.length && checkStep) {
        const message = await checkStep({ id: spec.id, name: spec.name, attempt }, result, ctx);
        if (typeof message === 'string') reasons = [message];
        else if (message != null) throw failure('invalid-result', 'checkStep returned an invalid value');
      }
      if (!reasons.length && spec.verify !== null) {
        const candidate = { ...state, ...result };
        if (!await verifyStep(spec.id, spec.verify, spec.name, { ...ctx, state: candidate })) reasons = [`verify ${spec.verify} failed`];
      }
      budget.check();
      if (!reasons.length) {
        // Wire snapshots are immutable, but a subsequent Action owns mutable business State.
        writeResult(state, structuredClone(result));
        return;
      }
    }
    throw failure('attempt-limit', `${spec.name}: ${reasons.join('; ')}`);
  };
}
