import { hasTaskSpec } from '../shared/task-spec.mjs';

/** These bodies are compiler-owned templates, never called in the compiler process. */
function booleanTemplate() {
  const asBool = (value, name) => {
    if (typeof value !== "boolean") throw Object.assign(new Error(`FK_R002 ${name} must return boolean`), { code: "FK_R002" });
    return value;
  };
}

function ownTemplate() {
  const writeOwn = (target, key, value) => Object.defineProperty(target, key,
    { value, enumerable: true, writable: true, configurable: true });
}

function traceTemplate() {
  const trace = runtime.trace;
  const hook = (fn, ...args) => { try { fn?.apply(trace, args); } catch { /* Trace hook failures are ignored. */ } };
  const traced = async (id, name, operation) => {
    hook(trace?.start, id, name);
    try {
      const result = await operation();
      hook(trace?.end, id, name, "ok");
      return result;
    } catch (error) {
      if (isControlSignal(error)) { hook(trace?.end, id, name, "control"); throw error; }
      hook(trace?.end, id, name, "error");
      throw error;
    }
  };
}

function agentTemplate() {
  let stepNo = 0;
  const invocationId = globalThis.crypto.randomUUID();
  // Diagnostic text must not change retry behavior or replace the original rejection cause.
  const rejectionText = (error) => {
    try { return String(error?.message ?? error); }
    catch { return "<unprintable rejection>"; }
  };
  const mergeOwn = (target, source) => { for (const key of Object.keys(source)) writeOwn(target, key, source[key]); return target; };
  const runStep = async (s) => {
    // Allocate before any await: parallel declarations keep deterministic overview numbers.
    const step = ++stepNo;
    const activationId = JSON.stringify([invocationId, s.id, step]);
    const requestIdFor = attempt => JSON.stringify([activationId, attempt]);
    const instruction = await s.skill();
    const input = {};
    const missing = [];
    for (const key of s.inputs) {
      writeOwn(input, key, Object.hasOwn(ctx.state, key) ? ctx.state[key] : undefined);
      if (!Object.hasOwn(ctx.state, key)) missing.push(key);
    }
    let reasons = [];
    let threw = false;
    let cause;
    const authorizeRetry = async attempt => {
      if (attempt > s.retries) return;
      ctx.signal?.throwIfAborted();
      const proof = await runtime.authorizeLegacyRetry?.({
        runId: ctx.runId, nodeId: s.id, step, attempt, activationId, requestId: requestIdFor(attempt),
        reasons: [...reasons], signal: ctx.signal
      });
      ctx.signal?.throwIfAborted();
      if (proof?.authorized !== true || proof.sideEffectStatus !== "none") {
        throw Object.assign(new Error(`FK_R004 ${s.name} redispatch requires Host authorization and observed no side effect`),
          threw ? { cause } : undefined, { code: "FK_R004", kind: "retry-not-authorized", reasons });
      }
    };
    for (let attempt = 1; attempt <= s.retries + 1; attempt++) {
      let result;
      try {
        ctx.signal?.throwIfAborted();
        result = await runAgent({ id: s.id, name: s.name, instruction, input, missing, resultSchema: s.output,
          attempt, activationId, requestId: requestIdFor(attempt), reasons,
          ...(s.overview ? { overview: { step } } : {}), signal: ctx.signal, runId: ctx.runId });
        threw = false;
      } catch (error) {
        ctx.signal?.throwIfAborted();
        if (isControlSignal(error)) throw error;
        threw = true;
        cause = error;
        reasons = [`runAgent threw: ${rejectionText(error)}`];
        await authorizeRetry(attempt);
        continue;
      }
      reasons = validateResult(s.output, result);
      if (!Array.isArray(reasons)) {
        throw Object.assign(new Error(`FK_R004 ${s.name} validateResult must return validation messages`), { code: "FK_R004" });
      }
      for (let index = 0; index < reasons.length; index++) {
        if (!Object.hasOwn(reasons, index) || typeof reasons[index] !== "string") {
          throw Object.assign(new Error(`FK_R004 ${s.name} validateResult must return validation messages`), { code: "FK_R004" });
        }
      }
      if (reasons.length === 0 && checkStep) {
        const why = await checkStep({ id: s.id, name: s.name, attempt }, result, ctx);
        if (typeof why === "string") reasons = [why];
        else if (why != null) throw Object.assign(new Error(`FK_R002 ${s.name} checkStep returned an invalid value`), { code: "FK_R002" });
      }
      if (reasons.length === 0 && s.verify != null) {
        const candidate = mergeOwn(mergeOwn({}, ctx.state), result);
        if (!(await verifyStep(s.id, s.verify, s.name, { ...ctx, state: candidate }))) reasons = [`verify ${s.verify} failed`];
      }
      ctx.signal?.throwIfAborted();
      if (reasons.length === 0) { mergeOwn(ctx.state, result); return; }
      await authorizeRetry(attempt);
    }
    throw Object.assign(new Error(`FK_R004 ${s.name}: ${reasons.join("; ")}`, threw ? { cause } : undefined), { code: "FK_R004", reasons });
  };
}

function humanTemplate() {
  const humanResult = async (name) => {
    const result = await runHuman(name, ctx);
    const object = typeof result === "object" && result !== null;
    const approved = asBool(object ? result.approved : result, name);
    const comment = object && result.comment != null ? result.comment : null;
    if (comment !== null && typeof comment !== "string") throw Object.assign(new Error(`FK_R002 ${name} comment must be a string`), { code: "FK_R002" });
    return { approved, comment };
  };
}

function humanDecisionTemplate() {
  const reviewHuman=async (id,name) => {
    const value=await runHuman(name,ctx);
    const decision=value&&Object.getOwnPropertyDescriptor(value,'decision');
    const comment=value&&Object.getOwnPropertyDescriptor(value,'comment');
    if (typeof value!=='object' || !['approve','revise','decline'].includes(decision?.value)
      || Reflect.ownKeys(value).some(key=>!['decision','comment'].includes(key))
      || comment && (!Object.hasOwn(comment,'value') || comment.value!=null && typeof comment.value!=='string')) {
      throw Object.assign(new TypeError('FK_R002 Invalid Human decision'),{code:'FK_R002'});
    }
    writeOwn(ctx.state,id,{decision:decision.value,comment:comment?.value??null});
    return decision.value;
  };
}

function body(fn) {
  const source = fn.toString().replaceAll('\r\n', '\n');
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim().split('\n')
    .map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n');
}

/** Select actual template dependencies; trace=off has no trace binding or instrumentation. */
export function emitHelpers(nodes, trace, actionCatches) {
  const agent = nodes.some(node => node.type === 'agent');
  const prepared = nodes.some(node => node.type === 'agent' && hasTaskSpec(node));
  const human = nodes.some(node => node.type === 'human');
  const verification = nodes.some(node => node.type === 'verification' || node.type === 'agent' && node.verify != null);
  const calls = nodes.some(node => ['agent', 'human', 'verification', 'action', 'parallel'].includes(node.type));
  const tracing = trace && calls;
  const methods = new Set();
  if (agent) for (const key of ['runAgent', 'validateResult', 'loadSkill', 'loadSkillByAgent']) methods.add(key);
  if (human) methods.add('runHuman');
  if (verification) methods.add('runVerification');
  if (nodes.some(node => node.type === 'action')) methods.add('runAction');
  if (nodes.some(node => node.type === 'condition')) methods.add('evalWhen');
  if (agent || tracing || actionCatches || nodes.some(node => node.type === 'parallel' && node.join.strategy === 'any')) methods.add('isControlSignal');
  const lines = methods.size || agent ? ['const runtime = ctx.runtime;'] : [];
  for (const method of methods) lines.push(['loadSkill', 'loadSkillByAgent'].includes(method)
    ? `const ${method} = (...args) => runtime.${method} === undefined ? ctx.skillLoader.${method}(...args) : runtime.${method}(...args);`
    : `const ${method} = (...args) => runtime.${method}(...args);`);
  if (agent || human || actionCatches || nodes.some(node => node.type === 'verification' && node.onSuccess === undefined)) lines.push(body(ownTemplate));
  if (human || verification) lines.push(body(booleanTemplate));
  if (tracing) lines.push(body(traceTemplate));
  if (verification) lines.push(`const verifyStep = async (id, verifier, name, target = ctx) => ${tracing
    ? 'traced(id, name, async () => asBool(await runVerification(verifier, name, target), name))'
    : 'asBool(await runVerification(verifier, name, target), name)'};`);
  if (agent) {
    lines.push('const checkStep = runtime.checkStep && ((...args) => runtime.checkStep(...args));');
    // A literal null verify never calls this unused fallback; keeping it local avoids a second runtime.
    if (!verification) lines.push('const verifyStep = undefined;');
    lines.push(body(agentTemplate));
    if (prepared) {
      lines.push('const runPreparedStep = s => ctx.runPreparedAgent(s, ++stepNo, checkStep, verifyStep);');
    }
  }
  if (human) {
    lines.push(body(humanTemplate));
    lines.push(`const askHuman = async (id, name) => { const result = await ${tracing ? 'traced(id, name, () => humanResult(name))' : 'humanResult(name)'}; writeOwn(ctx.state, id, result); return result.approved; };`);
    if (nodes.some(node=>node.type==='human'&&node.onDecline)) lines.push(body(humanDecisionTemplate));
  }
  return { code: lines.join('\n'), tracing };
}
