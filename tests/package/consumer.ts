import { readFile } from 'node:fs/promises';
import { compile, run, isControlSignal } from '@devcodex/flowkit';
import type { Runtime, RunResult, FlowkitOptions } from '@devcodex/flowkit';
import { defineWorkflow, action, terminal } from '@devcodex/flowkit/dsl';
const definition = defineWorkflow({ id: 'typed', version: '1.0.0', name: 'Typed', nodes: [action('a', { name: 'A', action: 'save', next: 'done' }), terminal('done', { name: 'Done', status: 'succeeded' })] });
const host: Runtime = { isControlSignal };
const options: FlowkitOptions = { fetch, signal: new AbortController().signal };
const result: Promise<RunResult> = run('sample.workflow.ts', host, {}, options);
void [definition, result, compile('sample.workflow.ts'), readFile('sample.workflow.ts')];
