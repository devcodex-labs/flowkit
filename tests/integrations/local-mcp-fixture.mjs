import { materializePlan } from '../../src/author/workflow-plan.mjs';

const definition = [
  { id: 'input', kind: 'verification', name: 'Check input', options: { verifier: 'check-input', onSuccess: 'copy', onFailure: 'failed' } },
  { id: 'copy', kind: 'action', name: 'Create copy', options: { action: 'write-copy', next: 'verify' } },
  { id: 'verify', kind: 'verification', name: 'Verify copy', options: { verifier: 'check-copy', onSuccess: 'done', onFailure: 'failed' } },
  { id: 'done', kind: 'terminal', name: 'Deliver', options: { status: 'succeeded' } },
  { id: 'failed', kind: 'terminal', name: 'Report failure', options: { status: 'failed' } }
];

const structured=[
  {id:'outer',kind:'parallel',name:'Check independent inputs',options:{branchMode:'subflow',
    branches:['input','review'],join:{strategy:'all_succeeded',next:'done'}}},
  {id:'input',kind:'verification',name:'Check input',options:{verifier:'check-input',onSuccess:'done',onFailure:'invalid-input'}},
  {id:'review',kind:'parallel',name:'Review alternatives',options:{branchMode:'subflow',
    branches:['copy','original'],join:{strategy:'any',next:'done'}}},
  {id:'copy',kind:'verification',name:'Verify copy',options:{verifier:'check-copy',onSuccess:'done',onFailure:'invalid-copy'}},
  {id:'original',kind:'verification',name:'Verify original',options:{verifier:'check-original',onSuccess:'done',onFailure:'invalid-original'}},
  {id:'done',kind:'terminal',name:'Deliver',options:{status:'succeeded'}},
  ...['input','copy','original'].map(id=>({id:'invalid-'+id,kind:'terminal',name:'Reject '+id,options:{status:'failed'}}))
];

export function monthlyTimesheetModel({interactive=false}={}) {
  const reviewRequests = new Set();
  const intent = { effective: { intents: [{ id: 'timesheet', goal: '月度工时', children: [], constraints: [] }],
    constraints: [{ id: 'verify-copy', text: interactive?'输入与任一复核分支均通过才结束。':'输入或副本校验失败时结束。',
      kind: 'requirement', scope: { type: 'global' } }],
    relations: [], coverage: 'complete', unresolved: [] }, turn: { changes: [], facts: {} }, issues: [], inferences: [], evidence: [] };
  const nodes=interactive?structured:definition;
  const proposalInput = {
    entryNodeId: nodes[0].id, nodes,
    coverage: [
      { intentId: 'timesheet', status: 'covered', coveredBy: nodes.map(node => node.id) },
      { intentId: 'verify-copy', status: 'covered', coveredBy: interactive?['input','review','done']:['input','verify','failed'] }
    ] };
  let plan;
  return {
    execution: {
      async request({ prepared, flowkitIntent }) {
        if (flowkitIntent) return intent;
        const id = prepared.task.node.id;
        if (interactive && id === 'proposal') {
          const proposal = { ...proposalInput, edges: [
            { from: 'outer', to: 'input' },
            { from: 'review', to: 'copy', kind: 'branch' }
          ] };
          return { status: 'succeeded', result: { rawText: JSON.stringify(proposal) }, events: [] };
        }
        if (interactive && ['plan-repair','dsl-source','dsl-repair'].includes(id)) {
          throw new Error('The immutable P2 graph should materialize from the initial Plan options');
        }
        plan ??= materializePlan({ target: { name: 'monthly-timesheet', version: '1.0.0' },
          choices:{executionMode:interactive?'interactive-p2':'standard'} }, proposalInput,
          { filename: 'monthly-timesheet.workflow.js' });
        const { source, proposal, diagnostics } = await plan;
        if (diagnostics) throw new Error(JSON.stringify(diagnostics));
        if (id === 'semantic-review') reviewRequests.add(prepared.task.execution.requestId);
        const result = ['proposal','plan-repair'].includes(id) ? { rawText: JSON.stringify(proposal) } :
          id === 'semantic-review' ? { passed: true, findings: [] } : { rawText: source };
        return { status: 'succeeded', result, events: [] };
      },
      async createSession(ports) {
        return { intentRuntime: { parse: flowkitIntent => ports.request({ flowkitIntent }) },
          runtime: { validateResult: () => [], runAgentTask: prepared => ports.request({ prepared }) } };
      }
    },
    async observeReview({ task }) {
      const request = task.execution.requestId;
      return reviewRequests.delete(request) ? { passed: true, subjectId: 'test-review', executionId: request } : null;
    }
  };
}

export async function browserIdentity(service) {
  const response = await fetch(service.operatorUrl, { redirect: 'manual' });
  if (response.status !== 303) throw new Error('Could not establish the test operator session');
  return response.headers.get('set-cookie').split(';')[0];
}

export async function confirmInTestBrowser(url, cookie) {
  const origin = new URL(url).origin;
  const response = await fetch(url, { headers: { cookie } });
  const html = await response.text();
  const challenge = html.match(/name="challenge" value="([^"]+)"/)?.[1];
  if (!challenge) throw new Error('Candidate has no confirmation control: ' + html.slice(0, 300));
  const confirmed = await fetch(url + '/confirm', {
    method: 'POST', headers: { cookie, origin }, body: new URLSearchParams({ challenge })
  });
  if (!confirmed.ok) throw new Error('Test confirmation failed: ' + await confirmed.text());
  return confirmed;
}
