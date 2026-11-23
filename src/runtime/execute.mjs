import { executionOptions, validateExecutionArguments, createRunContext } from './context.mjs';
import {contractForWorkflow} from './load.mjs';
import {validateWorkflowInput,projectWorkflowOutput} from '../shared/workflow-contract.mjs';

/** Execute a verified generated function; rejection values are deliberately left untouched. */
export async function executeWorkflow(workflow, runtime, state, suppliedOptions, artifact, checkPreparedSkills) {
  const options = executionOptions(suppliedOptions);
  if (typeof workflow !== 'function') throw new TypeError('workflow must be a function');
  validateExecutionArguments(runtime, state);
  const contract=contractForWorkflow(workflow);
  const input=validateWorkflowInput(contract,state??{});
  const ctx = createRunContext(runtime, input, options, artifact, checkPreparedSkills);
  const terminal = await workflow(ctx);
  const result = { status: terminal.status, terminal: terminal.terminal, state: ctx.state };
  if (contract?.output && terminal.status==='succeeded') result.publicOutput=projectWorkflowOutput(contract,ctx.state);
  if (Object.hasOwn(ctx, 'error')) Object.defineProperty(result, 'error',
    { value: ctx.error, enumerable: true, writable: true, configurable: true });
  return result;
}
