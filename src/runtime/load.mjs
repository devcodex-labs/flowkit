import {loadBoundedModule} from './compilation-cache.mjs';
import {WORKFLOW_CONTRACT_MARKER,verifyWorkflowContract} from '../shared/workflow-contract.mjs';

const contracts = new WeakMap();
export const contractForWorkflow = workflow => contracts.get(workflow);

function splitBody(code) {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  let body = code.split('\n').slice(10).join('\n');
  let contract;
  if (body.startsWith(WORKFLOW_CONTRACT_MARKER)) {
    const end = body.indexOf('\n');
    contract = verifyWorkflowContract(JSON.parse(body.slice(WORKFLOW_CONTRACT_MARKER.length,end)));
    body=body.slice(end+1);
  }
  if (!body.startsWith('export async function workflow(ctx) {')) throw new Error('Invalid generated workflow text');
  return {contract,text:body.slice('export '.length, body.endsWith('\n') ? -1 : undefined)};
}

export const workflowFunctionText = code => splitBody(code).text;

export function verifyWorkflowFunction(module, code) {
  const {contract,text}=splitBody(code);
  if (typeof module.workflow !== 'function' || Function.prototype.toString.call(module.workflow) !== text) {
    throw new Error('Loaded workflow function differs from the compiled text');
  }
  if (contract) contracts.set(module.workflow,contract);
  return module.workflow;
}

/** Load the saved text and reject loader transformations before invoking business code. */
export async function loadWorkflowText(code) {
  workflowFunctionText(code);
  const module = await loadBoundedModule(code);
  return verifyWorkflowFunction(module, code);
}
