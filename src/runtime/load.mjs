export function workflowFunctionText(code) {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  const body = code.split('\n').slice(10).join('\n');
  if (!body.startsWith('export async function workflow(ctx) {')) throw new Error('Invalid generated workflow text');
  return body.slice('export '.length, body.endsWith('\n') ? -1 : undefined);
}

export function verifyWorkflowFunction(module, code) {
  const expected = workflowFunctionText(code);
  if (typeof module.workflow !== 'function' || Function.prototype.toString.call(module.workflow) !== expected) {
    throw new Error('Loaded workflow function differs from the compiled text');
  }
  return module.workflow;
}

/** Load the saved text and reject loader transformations before invoking business code. */
export async function loadWorkflowText(code) {
  workflowFunctionText(code);
  const module = await import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64'));
  return verifyWorkflowFunction(module, code);
}
