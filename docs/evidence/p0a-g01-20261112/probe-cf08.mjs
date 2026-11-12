import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const repo = resolve(process.argv[2]);
const {compileInteractive} = await import(pathToFileURL(join(repo,'src/interactive/compile.mjs')));
const projectRoot = await mkdtemp(join(tmpdir(), 'flowkit-g01-cf08-'));
const file = join(projectRoot, 'cf08.workflow.js');
await writeFile(file, "import {defineWorkflow,terminal} from '@devcodex-labs/flowkit/dsl';\n" +
  "export default defineWorkflow({id:'cf08',version:'1.0.0',name:'CF08',nodes:[terminal('done',{name:'Done',status:'succeeded'})]});\n");
const opts = () => ({output:'memory',featureStage:'P0-A',projectRoot});
const control = await compileInteractive(file, opts());
const options = opts();
const pending = compileInteractive(file, options);
options.featureStage = 'P0-B';
const raced = await pending;
console.log(JSON.stringify({node:process.version, file, controlBytes:Buffer.byteLength(control.code), racedBytes:Buffer.byteLength(raced.code), diagnostics:raced.diagnostics}, null, 2));
assert.ok(control.code.length);
assert.equal(raced.code, '');
assert.ok(raced.diagnostics.some(d=>d.message.includes('P0-B')));
