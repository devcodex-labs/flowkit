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
  const mergeOwn = (target, source) => { for (const key of Object.keys(source)) writeOwn(target, key, source[key]); return target; };
  const runStep = async (s) => {
    // Allocate before any await: parallel declarations keep deterministic overview numbers.
    const step = ++stepNo;
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
    for (let attempt = 1; attempt <= s.retries + 1; attempt++) {
      let result;
      try {
        result = await runAgent({ id: s.id, name: s.name, instruction, input, missing, resultSchema: s.output,
          attempt, reasons, ...(s.overview ? { overview: { step } } : {}), signal: ctx.signal, runId: ctx.runId });
        threw = false;
      } catch (error) {
        if (isControlSignal(error)) throw error;
        threw = true;
        cause = error;
        reasons = [`runAgent threw: ${error?.message ?? String(error)}`];
        continue;
      }
      reasons = validateResult(s.output, result);
      if (reasons.length === 0 && checkStep) {
        const why = await checkStep({ id: s.id, name: s.name, attempt }, result, ctx);
        if (typeof why === "string") reasons = [why];
        else if (why != null) throw Object.assign(new Error(`FK_R002 ${s.name} checkStep returned an invalid value`), { code: "FK_R002" });
      }
      if (reasons.length === 0 && s.verify != null) {
        const candidate = mergeOwn(mergeOwn({}, ctx.state), result);
        if (!(await verifyStep(s.id, s.verify, s.name, { ...ctx, state: candidate }))) reasons = [`verify ${s.verify} failed`];
      }
      if (reasons.length === 0) { mergeOwn(ctx.state, result); return; }
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

function body(fn) {
  const source = fn.toString().replaceAll('\r\n', '\n');
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}')).trim().split('\n')
    .map(line => line.startsWith('  ') ? line.slice(2) : line).join('\n');
}

/** Select actual template dependencies; trace=off has no trace binding or instrumentation. */
export function emitHelpers(nodes, trace, actionCatches) {
  const agent = nodes.some(node => node.type === 'agent');
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
  for (const method of methods) lines.push(`const ${method} = (...args) => runtime.${method}(...args);`);
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
  }
  if (human) {
    lines.push(body(humanTemplate));
    lines.push(`const askHuman = async (id, name) => { const result = await ${tracing ? 'traced(id, name, () => humanResult(name))' : 'humanResult(name)'}; writeOwn(ctx.state, id, result); return result.approved; };`);
  }
  return { code: lines.join('\n'), tracing };
}
