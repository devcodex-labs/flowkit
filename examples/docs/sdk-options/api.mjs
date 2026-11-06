import { compile, compileSource, check, run, evalWhen, isControlSignal } from '@devcodex/flowkit';
import { readFile } from 'node:fs/promises';
const source = 'sample.workflow.js';
const compiled = await compile(source, { trace: true });
if (compiled.diagnostics.some(item => item.severity === 'error')) throw new Error(JSON.stringify(compiled.diagnostics));
const diagnostics = await check(source, { trace: true });
const text = await readFile(source, 'utf8');
// filename 决定输出路径；compileSource不要求该源文件先存在。
const fromText = await compileSource(text, { filename: 'text.workflow.js', mermaid: false });
const events = [];
const runtime = { isControlSignal, async runAction(action, name, ctx) { ctx.state.saved = true; }, trace: { start(id) { events.push(`start:${id}`); }, end(id, name, outcome) { events.push(`end:${id}:${outcome}`); } } };
const result = await run(source, runtime, {}, { trace: true, runId: 'sdk-demo', dump: 'dump' });
console.log(JSON.stringify({ diagnostics, fromTextErrors: fromText.diagnostics.length, result, condition: evalWhen({ runtime, state: result.state }, 'saved === true'), control: isControlSignal({ control: true }), events }, null, 2));
