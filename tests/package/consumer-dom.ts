import { compile, run, isControlSignal } from '@devcodex-labs/flowkit';
import type { FlowkitOptions, RunResult } from '@devcodex-labs/flowkit';
const options: FlowkitOptions = { fetch, signal: new AbortController().signal };
const result: Promise<RunResult> = run('sample.workflow.ts', { isControlSignal }, {}, options);
void [compile('sample.workflow.ts'), result];
