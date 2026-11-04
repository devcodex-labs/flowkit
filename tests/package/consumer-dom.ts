import { compile, run, isControlSignal } from '@devcodex/flowkit';
import type { FlowkitOptions, RunResult } from '@devcodex/flowkit';
const options: FlowkitOptions = { fetch, signal: new AbortController().signal };
const result: Promise<RunResult> = run('sample.workflow.ts', { isControlSignal }, {}, options);
void [compile('sample.workflow.ts'), result];
