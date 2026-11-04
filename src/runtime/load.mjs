/** Load the compiler-owned snapshot and reject loader transformations before invoking business code. */
export async function loadWorkflowText(code) {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  const body = code.split('\n').slice(10).join('\n');
  if (!body.startsWith('export async function workflow(ctx) {')) throw new Error('Invalid generated workflow text');
  const expected = body.slice('export '.length, body.endsWith('\n') ? -1 : undefined);
  const module = await import('data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64'));
  if (typeof module.workflow !== 'function' || Function.prototype.toString.call(module.workflow) !== expected) {
    throw new Error('Loaded workflow function differs from the compiled text');
  }
  return module.workflow;
}
