import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evalWhen, isControlSignal } from '@devcodex/flowkit';
import { executeSource } from '../../src/runtime/source.mjs';

const imports = "import {defineWorkflow,node,action,condition,verification,loop,human,parallel,terminal} from '@devcodex/flowkit/dsl';";
export const end = (id = 'done', status = 'succeeded') => `terminal('${id}',{name:'${id}',status:'${status}'})`;
export const source = nodes => `${imports}\nexport default defineWorkflow({id:'runtime',version:'1.0.0',name:'Runtime',nodes:[${nodes.join(',')}]});\n`;
export const host = methods => ({ isControlSignal, evalWhen, ...methods });
export const settled = promise => promise.then(value => ({ fulfilled: true, value }), error => ({ fulfilled: false, error }));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function fixture(t, nodes) {
  const base = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(base, 'flowkit-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), base);
    assert.ok(path.basename(directory).startsWith('flowkit-runtime-'));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'source.workflow.js');
  await writeFile(file, source(nodes));
  return { directory, file, run: (runtime, state, options) => executeSource(file, runtime, state, options) };
}
