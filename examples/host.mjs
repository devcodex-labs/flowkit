import { evalWhen, isControlSignal } from '@devcodex/flowkit';

/** Bind real model, JSON Schema, approval and business services at the host boundary. */
export function createRuntime({ agent, validate, approve, verify, act, trace }) {
  for (const [name, method] of Object.entries({ agent, validate, approve, verify, act })) {
    if (typeof method !== 'function') throw new TypeError(`${name} must be a function`);
  }
  return {
    isControlSignal, evalWhen,
    runAgent(step) { return agent(step); },
    // Use a complete validator for your schema dialect. Return [] or readable reasons.
    validateResult(schema, result) { return validate(schema, result); },
    runHuman(name, ctx) { return approve(name, ctx); },
    runVerification(verifier, name, ctx) { return verify(verifier, name, ctx); },
    runAction(action, name, ctx) { return act(action, name, ctx); },
    ...(trace === undefined ? {} : { trace }),
  };
}

/** Demo-only validator for the flat object schemas in these examples; rejects other schemas. */
export function validateExample(schema, result) {
  if (schema.type !== 'object' || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key)) ||
      Object.values(schema.properties ?? {}).some(value => Object.keys(value).some(key => key !== 'type') || !['string', 'boolean'].includes(value.type))) {
    throw new TypeError('The example validator supports only flat string/boolean object schemas');
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return ['Expected object'];
  const reasons = [];
  for (const key of schema.required ?? []) if (!Object.hasOwn(result, key)) reasons.push(`Missing ${key}`);
  for (const key of Object.keys(result)) {
    const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties[key] : undefined;
    if (!property) { if (schema.additionalProperties === false) reasons.push(`Unknown ${key}`); }
    else if (typeof result[key] !== property.type) reasons.push(`Invalid ${key}`);
  }
  return reasons;
}
