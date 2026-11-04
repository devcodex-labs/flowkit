import { compile, compileSource, check } from '@devcodex/flowkit';
import type { CompileResult, Diagnostic, FlowkitOptions } from '@devcodex/flowkit';

const options: FlowkitOptions = { trace: false, mermaid: true, skillCheck: false };
const compiled: Promise<CompileResult> = compile('sample.workflow.ts', options);
const virtual: Promise<CompileResult> = compileSource('', { filename: 'sample.workflow.js' });
const diagnostics: Promise<Diagnostic[]> = check('sample.workflow.ts');
void [compiled, virtual, diagnostics];
// @ts-expect-error Runtime entry is not implemented or exported in this compiler batch.
import { run } from '@devcodex/flowkit';
// @ts-expect-error Runtime helper is not yet exported by the compiler entry.
import { evalWhen } from '@devcodex/flowkit';
// @ts-expect-error Control helper is not yet exported by the compiler entry.
import { isControlSignal } from '@devcodex/flowkit';
// @ts-expect-error Internal modules are not public subpaths.
import { writeArtifacts } from '@devcodex/flowkit/compiler/output';
// @ts-expect-error compileSource requires a filename.
compileSource('', {});
// @ts-expect-error filename is not a compile option.
compile('sample.workflow.ts', { filename: 'other.workflow.ts' });
// @ts-expect-error Null is not a boolean option.
check('sample.workflow.ts', { mermaid: null });
