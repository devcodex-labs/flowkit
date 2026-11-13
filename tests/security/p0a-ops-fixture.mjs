import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {compileInteractive} from '../../src/interactive/index.mjs';

export async function compileOpsWorkflow(directory,{fileHandoff=false}={}) {
  const file=path.join(directory,'ops.workflow.js');
  const properties=fileHandoff?"{artifact:{type:'object'}}":"{answer:{type:'string'}}";
  await writeFile(file,`import {defineWorkflow,node,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'p0a-ops',version:'1.0.0',name:'P0-A operations',nodes:[
node('agent',{name:'Agent',agent:'writer',inputs:['question'],output:{type:'object',properties:${properties}},retries:1,next:'done'}),
terminal('done',{name:'Done',status:'succeeded'})]});`,{flag:'wx'});
  const compiled=await compileInteractive(file,{output:'memory',featureStage:'P0-A',skillCheck:false});
  assert.ok(compiled.programIdentity,JSON.stringify(compiled.diagnostics));
  return {programBytes:Buffer.from(compiled.code),programIdentity:compiled.programIdentity};
}

export const opsRuntime={
  skillResolver:async()=> 'Follow the current task and submit the requested answer.',
  validateResult(_schema,result) {return result?.answer==='ready'?[]:['Expected ready'];},
};

export const opsStart=(program,startKey)=>({...program,startKey,state:{question:'Return ready.'}});
