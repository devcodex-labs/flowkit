import { executionOptions, validateExecutionArguments, createRunContext } from './context.mjs';

/** Execute a verified generated function; rejection values are deliberately left untouched. */
export async function executeWorkflow(workflow, runtime, state, suppliedOptions) {
  const options = executionOptions(suppliedOptions);
  if (typeof workflow !== 'function') throw new TypeError('workflow must be a function');
  validateExecutionArguments(runtime, state);
  const ctx = createRunContext(runtime, state, options);
  const terminal = await workflow(ctx);
  const result = { status: terminal.status, terminal: terminal.terminal, state: ctx.state };
  if (Object.hasOwn(ctx, 'error')) Object.defineProperty(result, 'error',
    { value: ctx.error, enumerable: true, writable: true, configurable: true });
  return result;
}
