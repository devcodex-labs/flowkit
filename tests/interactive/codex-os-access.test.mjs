import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {createCodexOsAccess} from '../../examples/interactive/codex-os-access.mjs';
import {serveCodexOsSession} from '../../examples/interactive/codex-os-stdio.mjs';

const identity=process.platform==='win32'?'S-1-5-21-1-2-3-1001':'1001';
const bindings=[{identity,namespace:'tenant-a',role:'auditor'}];
const readCommand=JSON.stringify({action:'result:read',namespace:'tenant-a'})+'\n';
const denied={ok:false,code:'FK_I_HOST_DENIED'};

test('revoking a live audit session suppresses an in-flight result and blocks later reads',async()=>{
  const access=createCodexOsAccess(bindings);
  const input=new PassThrough(),output=new PassThrough();
  const lines=createInterface({input:output});
  const responses=lines[Symbol.asyncIterator]();
  let entered,release,session;
  const ready=new Promise(resolve=>{entered=resolve;});
  const paused=new Promise(resolve=>{release=resolve;});
  const serve=serveCodexOsSession({access,identity,input,output,async dispatch(grant){
    session=grant;
    entered();
    await paused;
    return {private:'synthetic result'};
  }});
  const next=async()=>JSON.parse((await responses.next()).value);
  try {
    input.write(readCommand);
    await ready;
    access.replaceBindings([]);
    release();
    assert.deepEqual(await next(),denied);
    access.replaceBindings(bindings);
    input.write(readCommand);
    assert.deepEqual(await next(),denied);
    assert.equal(access.authorize(access.bind(identity),'result:read','tenant-a'),true);
  } finally {
    release();
    input.end();
    await serve;
    lines.close();
    output.end();
  }
  assert.throws(()=>access.authorize(session,'result:read','tenant-a'),{code:denied.code});
});

test('oversize stdio commands are discarded and the next command can be read',async()=>{
  const access=createCodexOsAccess(bindings);
  const input=new PassThrough(),output=new PassThrough();
  const lines=createInterface({input:output});
  const responses=lines[Symbol.asyncIterator]();
  const serve=serveCodexOsSession({access,identity,input,output,dispatch:()=>({safe:true})});
  try {
    input.write(' '.repeat(8000)+readCommand+readCommand);
    assert.deepEqual(JSON.parse((await responses.next()).value),denied);
    assert.deepEqual(JSON.parse((await responses.next()).value),{ok:true,result:{safe:true}});
  } finally {
    input.end();
    await serve;
    lines.close();
    output.end();
  }
});
