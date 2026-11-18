import { readFile } from 'node:fs/promises';
import { createFlowkitMcpServer } from '@devcodex-labs/flowkit/mcp';
import type { FlowkitMcpOptions, FlowkitMcpServer } from '@devcodex-labs/flowkit/mcp';
import { createApiAgentAdapter } from '@devcodex-labs/flowkit/host';
import type { ApiHostOptions } from '@devcodex-labs/flowkit/host';
import { createWorkflowAuthorHost } from '@devcodex-labs/flowkit/host';
import type { AuthorHostOptions, WorkflowAuthorHost, AuthorRequestContext } from '@devcodex-labs/flowkit/host';
declare const authorOptions: AuthorHostOptions;
declare const authorContext: AuthorRequestContext;
async function authorConsumer(): Promise<WorkflowAuthorHost> {
  const author = await createWorkflowAuthorHost(authorOptions);
  await author.start({ collectionId: 'team', requestId: 'id', goal: 'Inspect' }, authorContext);
  return author;
}
void authorConsumer;
declare const apiHostOptions: ApiHostOptions;
void createApiAgentAdapter(apiHostOptions);
declare const mcpOptions: FlowkitMcpOptions;
const mcpServer: FlowkitMcpServer = createFlowkitMcpServer(mcpOptions);
void mcpServer;
import { compile, run, isControlSignal } from '@devcodex-labs/flowkit';
import type { Runtime, RunResult, FlowkitOptions } from '@devcodex-labs/flowkit';
import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';
const definition = defineWorkflow({ id: 'typed', version: '1.0.0', name: 'Typed', nodes: [action('a', { name: 'A', action: 'save', next: 'done' }), terminal('done', { name: 'Done', status: 'succeeded' })] });
const host: Runtime = { isControlSignal };
const options: FlowkitOptions = { fetch, signal: new AbortController().signal };
const result: Promise<RunResult> = run('sample.workflow.ts', host, {}, options);
void [definition, result, compile('sample.workflow.ts'), readFile('sample.workflow.ts')];
