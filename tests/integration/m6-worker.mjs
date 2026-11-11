/** M6 deterministic external worker fixture — NOT an AI model provider. */
import {readFile} from 'node:fs/promises';
import process from 'node:process';

const chunks=[];
let total=0;
for await (const chunk of process.stdin) {
  total+=chunk.length;
  if(total>512*1024) throw new RangeError('Public task exceeds worker limit');
  chunks.push(chunk);
}
const task=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const allowed=new Set([
  'schemaVersion','kind','id','nodeId','runId','requestId','attempt',
  'name','instruction','input','missing','resultSchema','reasons','overview',
]);
if (!task || task.schemaVersion!==1 || task.kind!=='agent'
  || typeof task.runId!=='string' || typeof task.requestId!=='string'
  || typeof task.nodeId!=='string' || typeof task.instruction!=='string'
  || Object.keys(task).some(key=>!allowed.has(key))
  || JSON.stringify(task).includes('HOST_PRIVATE_SENTINEL')
  || Object.keys(task.input).some(key=>key!=='message')
  || task.missing.some(key=>key!=='message')) {
  throw new Error('MODEL_VIEW_LEAK_OR_INVALID_TASK');
}
for(const secretPath of process.argv.slice(2)) {
  let denied=false;
  try {await readFile(secretPath)} catch(error) {
    denied=['EACCES','EPERM'].includes(error.code);
  }
  if(!denied) throw new Error('MODEL_CAN_READ_HOST_PRIVATE_FILE');
}
const message=task.input.message;
if(typeof message!=='string') throw new TypeError('Public task must have string message');
const output={requestId:task.requestId,kind:'agent-result',result:{
  answer:'external-worker-processed:'+message,
}};
process.stdout.write(JSON.stringify(output)+'\n');
