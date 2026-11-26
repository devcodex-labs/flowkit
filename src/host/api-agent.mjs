import { setTimeout as delay } from 'node:timers/promises';
import { canonicalBytes } from '../interactive/canonical.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { during } from '../runtime/tasks.mjs';

function fail(code, message, sideEffectStatus) {
  throw Object.assign(new Error(message), { code, sideEffectStatus });
}

function effectWithFailure(observed, reported) {
  if (observed === 'unknown' || reported === 'unknown') return 'unknown';
  if (observed === 'known' || reported === 'known') return 'known';
  return 'none';
}

function sized(value, maximum, label) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > maximum) fail('size-limit', `${label} exceeds the configured JSON budget`);
  return text;
}

function waitForCleanup(signal, cancel) {
  const pending = Promise.resolve().then(cancel);
  pending.catch(() => {});
  return during(signal, () => pending);
}

async function readResponse(response, maximum, signal) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await during(signal, () => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maximum) fail('size-limit', 'Provider response exceeds the configured budget');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await waitForCleanup(signal, () => reader.cancel()).catch(() => {});
  }
}

/** A Host API adapter. Its request port supplies credentials and the actual Provider endpoint. */
export function createApiAgentAdapter({ scope, model, request, tools = [], authorizeTool,
  supportsTools = true, requiresTools = () => false, ledger = new Map(), limits = {}, retryDelaysMs = [100, 250] }) {
  if (typeof scope !== 'string' || !scope || typeof model !== 'string' || !model || typeof request !== 'function' ||
    typeof requiresTools !== 'function' || typeof supportsTools !== 'boolean') throw new TypeError('API adapter needs an explicit Host scope, model and request port');
  const budget = { maxRequests: 4, maxToolCalls: 8, maxInputBytes: 262144, maxOutputBytes: 262144,
    maxToolResultBytes: 65536, maxArgumentBytes: 65536, maxOutputTokens: 1024,
    maxLedgerEntries: 128, timeoutMs: 30000, ...limits };
  if (!Object.values(budget).every(value => Number.isSafeInteger(value) && value > 0) ||
    !Array.isArray(retryDelaysMs) || retryDelaysMs.some(value => !Number.isSafeInteger(value) || value < 0 || value > 2147483647)) {
    throw new TypeError('API limits and retry delays must be finite positive budgets');
  }
  const selected = new Map();
  for (const tool of tools) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || selected.has(tool.name) ||
      typeof tool.execute !== 'function' || typeof tool.validate !== 'function' || !['read', 'write'].includes(tool.sideEffect) ||
      tool.sideEffect === 'write' && typeof tool.operationKey !== 'function') throw new TypeError('Invalid or duplicate Host tool binding');
    selected.set(tool.name, Object.freeze({ ...tool, parameters: structuredClone(tool.parameters) }));
  }
  if (selected.size && typeof authorizeTool !== 'function') throw new TypeError('Tools require Host authorization');
  const wireTools = supportsTools ? [...selected.values()].map(({ name, description, parameters }) =>
    ({ type: 'function', name, description, parameters, strict: false })) : [];

  return Object.freeze({
    async runAgentTask(prepared, context = {}) {
      const started = Date.now();
      const deadline = Math.min(started + budget.timeoutMs, context.deadlineMs ?? Infinity, prepared.task.execution.deadlineMs ?? Infinity);
      const timer = AbortSignal.timeout(Math.max(1, Math.min(2147483647, deadline - started)));
      const signal = context.signal ? AbortSignal.any([timer, context.signal]) : timer;
      const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, toolCalls: 0 };
      const observations = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let usageResponses = 0;
      const events = [];
      let sideEffects = 'none';
      let httpRequests = 0;
      const replayedCalls = new Map();
      const task = prepared.task;
      function check() {
        signal.throwIfAborted();
        context.budget?.check();
        if (Date.now() >= deadline) fail('deadline-exceeded', 'API task deadline exceeded', sideEffects);
      }
      const remainingTokens = () => (budget.maxTotalTokens ?? Infinity) - usage.inputTokens - usage.outputTokens;
      function canContinue() {
        check();
        if (remainingTokens() <= 0) fail('token-limit', 'API task token budget exhausted', sideEffects);
        if (budget.maxTotalTokens !== undefined &&
            (observations.inputTokens !== usageResponses || observations.outputTokens !== usageResponses)) {
          fail('token-usage-unknown', 'Host token budget requires observed input and output usage before continuing', sideEffects);
        }
      }
      function finalUsage() {
        const tokenCoverage = Object.fromEntries(Object.entries(observations).map(([name, count]) =>
          [name, count === 0 ? 'unknown' : count === usageResponses ? 'known' : 'partial']));
        return { ...usage, providerRequests: httpRequests, durationMs: Date.now() - started, tokenCoverage };
      }

      try {
        check();
        if (!supportsTools && requiresTools(prepared)) fail('capability-unavailable', 'This task needs tools that the Provider cannot call');
        let body = { model, input: [{ role: 'user', content: 'Return a JSON object matching the supplied output schema. ' +
          'Use only the tools provided by this Host. Task and prepared resources follow.\n' +
          sized({ task, descriptionResources: prepared.descriptionResources, skills: prepared.skills }, budget.maxInputBytes, 'Prepared task') }],
        text: { format: { type: 'json_object' } }, tools: wireTools, parallel_tool_calls: false, max_output_tokens: budget.maxOutputTokens };
        for (let round = 0; ; round++) {
          canContinue();
          body.max_output_tokens = Math.min(budget.maxOutputTokens, remainingTokens());
          sized(body, budget.maxInputBytes, 'API request');
          let response;
          for (let retry = 0; ; retry++) {
            check();
            if (httpRequests >= budget.maxRequests) fail('request-limit', 'API request budget exhausted', sideEffects);
            if (context.budget?.dispatchProvider) await during(signal, () => context.budget.dispatchProvider({
              operationId:`${task.execution.requestId}:provider:${httpRequests}`}));
            httpRequests++;
            response = await during(signal, () => request(body, { signal, idempotencyKey: `${scope}:${task.execution.requestId}:${round}` }));
            events.push({ type: 'provider-response', request: httpRequests, status: response.status });
            if (![429, 500, 502, 503, 504].includes(response.status) || retry >= retryDelaysMs.length) break;
            await waitForCleanup(signal, () => response.body?.cancel());
            await delay(retryDelaysMs[retry], undefined, { signal });
          }
          const result = await readResponse(response, budget.maxOutputBytes, signal);
          if (!response.ok) fail('provider-error', `Provider returned HTTP ${response.status}`, sideEffects);
          const tokens = result.usage ?? {};
          usageResponses++;
          for (const [name, source, key] of [
            ['inputTokens', tokens, 'input_tokens'],
            ['outputTokens', tokens, 'output_tokens'],
            ['cachedInputTokens', tokens.input_tokens_details, 'cached_tokens']
          ]) {
            if (!source || !Object.hasOwn(source, key)) continue;
            const value = source[key];
            if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(usage[name] + value)) {
              fail('invalid-usage', 'Provider returned invalid token usage', sideEffects);
            }
            usage[name] += value;
            observations[name]++;
          }
          check();
          if (remainingTokens() < 0) fail('token-limit', 'API task token budget exceeded', sideEffects);
          if (result.status !== 'completed' || !Array.isArray(result.output)) fail('invalid-result', 'Provider did not complete the task', sideEffects);
          const calls = result.output.filter(item => item.type === 'function_call');
          if (calls.length === 0) {
            const text = result.output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
              .filter(item => item.type === 'output_text').map(item => item.text).join('');
            const value = JSON.parse(text);
            if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid-result', 'Agent result must be a JSON object', sideEffects);
            return { status: 'succeeded', result: value, sideEffectStatus: sideEffects, usage: finalUsage(), events };
          }
          if (!supportsTools) fail('capability-unavailable', 'Provider attempted an unavailable tool');
          const outputs = [];
          for (const call of calls) {
            canContinue();
            if (usage.toolCalls >= budget.maxToolCalls) fail('tool-limit', 'Tool call budget exhausted', sideEffects);
            usage.toolCalls++;
            const tool = selected.get(call.name);
            if (!tool || typeof call.call_id !== 'string' || !call.call_id || typeof call.arguments !== 'string' ||
              Buffer.byteLength(call.arguments) > budget.maxArgumentBytes) fail('invalid-tool-call', 'Provider requested an invalid Host tool', sideEffects);
            const args = JSON.parse(call.arguments);
            const errors = tool.validate(args);
            if (!Array.isArray(errors) || errors.length) fail('invalid-tool-arguments', 'Tool arguments failed Host validation', sideEffects);
            if (await during(signal, () => authorizeTool({ scope, task, name: call.name, args, signal })) !== true) {
              fail('tool-access-denied', 'Host denied the tool invocation', sideEffects);
            }
            const fingerprint = artifactDigest(canonicalBytes({ name: call.name, args }, budget.maxArgumentBytes));
            const previous = replayedCalls.get(call.call_id);
            if (previous && previous !== fingerprint) fail('tool-call-conflict', 'A repeated call ID changed its tool or arguments', sideEffects);
            replayedCalls.set(call.call_id, fingerprint);
            const operationId = tool.sideEffect === 'write' ? await during(signal, () => tool.operationKey(args, task)) : `${task.execution.requestId}:${call.call_id}`;
            if (typeof operationId !== 'string' || !operationId) fail('invalid-operation-key', 'Host tool operation key is missing', sideEffects);
            if (tool.sideEffect==='write' && ['P0-B','P1','P2'].includes(task.workflow.implementedStage)) {
              const {controller,auth}=context.interactiveOperations??{};
              if (!controller || !auth) fail('durable-operation-required','Interactive tool write requires the durable operation controller',sideEffects);
              const {runId}=task.run;
              const {requestId}=task.execution;
              const businessKey=artifactDigest(canonicalBytes(operationId));
              const operationKey=artifactDigest(canonicalBytes([requestId,businessKey]));
              const compensationPlan=tool.compensationPlan
                ? await during(signal,()=>tool.compensationPlan(args,task)) : undefined;
              const claim=await controller.claim({runId,requestId,operationKey,inputHash:fingerprint,businessKey,
                ...(compensationPlan?{compensationPlan}:{})},auth);
              let output;
              if (claim.claimed) {
                sideEffects='unknown';
                const value=await during(signal,()=>tool.execute(args,{signal,operationId,task}));
                output=sized(value,budget.maxToolResultBytes,'Tool result');
                await controller.settle({runId,operationKey,inputHash:fingerprint,effect:'applied',
                  evidenceHash:artifactDigest(canonicalBytes([operationKey,output])),result:output},auth);
              } else if (claim.settlement?.effect==='applied' && typeof claim.settlement.result==='string') {
                output=claim.settlement.result;
                if (Buffer.byteLength(output)>budget.maxToolResultBytes) fail('size-limit','Stored tool output exceeds budget','known');
              } else {
                fail('tool-outcome-unknown','Reconcile the earlier operation before retrying it','unknown');
              }
              sideEffects='known';
              events.push({type:'tool-result',name:tool.name,callId:call.call_id,operationId,replayed:!claim.claimed});
              outputs.push({type:'function_call_output',call_id:call.call_id,output});
              continue;
            }
            const key = JSON.stringify([scope, task.run.runId, task.node.id, tool.name, operationId]);
            let entry = ledger.get(key);
            if (entry && entry.fingerprint !== fingerprint) fail('tool-operation-conflict', 'An operation key was reused for different arguments', sideEffects);
            if (entry && entry.status !== 'completed') fail('tool-outcome-unknown', 'Reconcile the earlier operation before retrying it', 'unknown');
            if (entry && tool.sideEffect === 'write') sideEffects = 'known';
            if (!entry) {
              if (ledger.size >= budget.maxLedgerEntries) fail('ledger-limit', 'Host tool receipt budget exhausted', sideEffects);
              entry = { fingerprint, status: 'pending' };
              ledger.set(key, entry);
              if (tool.sideEffect === 'write') sideEffects = 'unknown';
              try {
                entry.output = sized(await during(signal, () => tool.execute(args, { signal, operationId, task })),
                  budget.maxToolResultBytes, 'Tool result');
                entry.status = 'completed';
                if (tool.sideEffect === 'write') sideEffects = 'known';
              } catch (error) {
                if (tool.sideEffect === 'read') ledger.delete(key);
                throw error;
              }
            }
            events.push({ type: 'tool-result', name: tool.name, callId: call.call_id, operationId, replayed: !!previous });
            outputs.push({ type: 'function_call_output', call_id: call.call_id, output: entry.output });
          }
          if (typeof result.id !== 'string' || !result.id) fail('invalid-result', 'Provider continuation identity is missing', sideEffects);
          body = { ...body, previous_response_id: result.id, input: outputs };
        }
      } catch (error) {
        const effect = effectWithFailure(sideEffects, error?.sideEffectStatus);
        if (context.signal?.aborted) return { status: 'cancelled', reason: 'Host cancelled the API task',
          sideEffectStatus: effect, usage: finalUsage(), events };
        return { status: 'failed', failure: { code: signal.aborted ? 'deadline-exceeded' : typeof error?.code === 'string' ? error.code : 'api-task-failed',
          message: String(error?.message ?? error), retryable: false, sideEffectStatus: effect }, usage: finalUsage(), events };
      }
    }
  });
}
