import { run, compile, compileSource, check, evalWhen, isControlSignal } from '@devcodex/flowkit';
import type { CompileResult, Diagnostic, FlowkitOptions, Ctx } from '@devcodex/flowkit';

const options: FlowkitOptions = { trace: false, mermaid: true, skillCheck: false };
const compiled: Promise<CompileResult> = compile('sample.workflow.ts', options);
const virtual: Promise<CompileResult> = compileSource('', { filename: 'sample.workflow.js' });
const diagnostics: Promise<Diagnostic[]> = check('sample.workflow.ts');
void [compiled, virtual, diagnostics];
const running = run('sample.workflow.ts', { isControlSignal });
void running;
// @ts-expect-error A control predicate is required on the host Runtime.
run('sample.workflow.ts', {});
declare const ctx: Ctx;
const boolean: boolean = evalWhen(ctx, 'true');
const control: boolean = isControlSignal(null);
void [boolean, control];
// @ts-expect-error Internal modules are not public subpaths.
import { writeArtifacts } from '@devcodex/flowkit/compiler/output';
// @ts-expect-error compileSource requires a filename.
compileSource('', {});
// @ts-expect-error filename is not a compile option.
compile('sample.workflow.ts', { filename: 'other.workflow.ts' });
// @ts-expect-error Null is not a boolean option.
check('sample.workflow.ts', { mermaid: null });
