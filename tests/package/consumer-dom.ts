import { compile, run, isControlSignal } from '@devcodex-labs/flowkit';
import { createWorkflowAuthorHost } from '@devcodex-labs/flowkit/host';
import type { AuthorHostOptions } from '@devcodex-labs/flowkit/host';
declare const authorOptions: AuthorHostOptions;
void createWorkflowAuthorHost(authorOptions);
import type { FlowkitMcpOptions, FlowkitMcpServer } from '@devcodex-labs/flowkit/mcp';
declare const mcpOptions: FlowkitMcpOptions;
declare const mcpServer: FlowkitMcpServer;
void [mcpOptions, mcpServer];
import type { FlowkitOptions, RunResult } from '@devcodex-labs/flowkit';
import { compileInteractive, createTrustedInteractiveHost } from '@devcodex-labs/flowkit/interactive';
import type {
  InteractiveCompileOptions, InteractiveTerminalResultRef, PublicInteractiveTerminalFrame,
  TrustedInteractiveHostOptions,
} from '@devcodex-labs/flowkit/interactive';
const options: FlowkitOptions = { fetch, signal: new AbortController().signal };
const result: Promise<RunResult> = run('sample.workflow.ts', { isControlSignal }, {}, options);
void [compile('sample.workflow.ts'), result];

declare const hostOptions: TrustedInteractiveHostOptions;
const host=createTrustedInteractiveHost(hostOptions);
const compileOptions: InteractiveCompileOptions={output:'memory',featureStage:'P0-A'};
void compileInteractive('sample.workflow.ts',compileOptions);
async function readTerminal() {
  const frame: PublicInteractiveTerminalFrame=await host.getPublicTerminalFrame({runId:'run'});
  const ref: InteractiveTerminalResultRef=frame.resultRef;
  // @ts-expect-error the public projection does not expose private State
  void frame.state;
  // @ts-expect-error a different projection protocol version is invalid
  void host.readTrustedTerminalResult({resultRef:{...ref,projectionVersion:2}});
  return host.readTrustedTerminalResult({resultRef:ref});
}
void readTerminal;
