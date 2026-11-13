import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {link,mkdir,mkdtemp,rename,rm,symlink,truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createFileHandoff} from '../../examples/interactive/codex-file-handoff.mjs';
import {canonicalBytes,MAX_INLINE_AGENT_RESULT_BYTES,sha256Bytes} from '../../src/interactive/canonical.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'flowkit-file-'));
  const inbox=path.join(dir,'inbox');
  await mkdir(inbox,{mode:0o700});
  const database=path.join(dir,'private.sqlite');
  let timestamp=1;
  const options={database,inbox,now:()=>timestamp,
    validateArtifact:value=>Object.keys(value).length===1 && typeof value.answer==='string'};
  const handoff=createFileHandoff(options);
  t.after(async()=>{handoff.close();await rm(dir,{recursive:true,force:true});});
  const binding={namespace:'tenant-a',runId:'run-a',requestId:'req-a',nodeId:'agent',attempt:1,
    threadId:'thread-a',turnId:'turn-a',programHash:'sha256:'+'1'.repeat(64),policyHash:'sha256:'+'2'.repeat(64)};
  const pending={runId:binding.runId,requestId:binding.requestId,attempt:1,nodeId:'agent'};
  let current={namespace:binding.namespace,runId:binding.runId,status:'waiting',pending,
    artifactHash:binding.programHash,policyHash:binding.policyHash};
  let signs=0,accepts=0;
  function call(ref,overrides={}) {
    return {tool:'flowkit_submit_file',callId:'call-a',threadId:binding.threadId,turnId:binding.turnId,
      arguments:ref,...overrides};
  }
  const operation=(ref,overrides={})=>handoff.consume({
    started:call(ref),callback:call(ref),
    loadPending:()=>current,async signAndAccept() {signs++;accepts++;return {acceptedRevision:7};},
    ...overrides,
  });
  async function put(bytes) {
    const sourceId=randomUUID(),source=path.join(inbox,sourceId+'.json');
    await writeFile(source,bytes,{flag:'wx'});
    return {source,request:{sourceId,binding,byteLength:bytes.length,sha256:sha256Bytes(bytes)}};
  }
  return {handoff,operation,call,put,options,counts:()=>({signs,accepts}),
    expire:()=>{timestamp=130000;},setPending:next=>{current={...current,pending:next};}};
}

test('file fallback consumes the persisted original after ingress is replaced or deleted',async t=>{
  for (const size of [256*1024,2*1024*1024-4096]) {
    const f=await fixture(t);
    const bytes=canonicalBytes({answer:'a'.repeat(size-13)});
    const {source,request}=await f.put(bytes);
    const ref=await f.handoff.stage(request);
    const replacement=source+'.replacement';
    await writeFile(replacement,Buffer.alloc(size,122));
    await rm(source);
    await rename(replacement,source);
    const reader=createFileHandoff(f.options);
    try {
      const saved=reader.readSnapshot(ref.id);
      assert.deepEqual(saved.bytes,bytes);
      saved.bytes[0]=0;
    } finally {reader.close();}
    await rm(source);
    await f.operation(ref,{async signAndAccept({artifact,binding,callId,pending}) {
      assert.deepEqual(artifact,{id:ref.id,byteLength:size,sha256:request.sha256});
      assert.equal(binding.requestId,pending.requestId);
      assert.equal(callId,'call-a');
      return {acceptedRevision:7};
    }});
    assert.equal(f.handoff.readSnapshot(ref.id).state,'acked');
    assert.deepEqual(f.handoff.readSnapshot(ref.id).bytes,bytes);
    await assert.rejects(f.operation(ref),{code:'FK_FILE_CONSUMED'});
    console.log('FLOWKIT_FILE_FALLBACK '+JSON.stringify({size,sha256:request.sha256,
      originalRetained:true,sourceRemoved:true,duplicateRejected:true,acceptedRevision:7}));
  }
});

test('file fallback rejects changed, truncated, oversize and invalid bytes before signing',async t=>{
  const f=await fixture(t);
  const bytes=canonicalBytes({answer:'hello'});
  const changed=await f.put(bytes);
  const replacement=changed.source+'.replacement';
  await writeFile(replacement,canonicalBytes({answer:'other'}));
  await rm(changed.source);
  await rename(replacement,changed.source);
  await assert.rejects(f.handoff.stage(changed.request),{code:'FK_FILE_DIGEST'});
  const short=await f.put(bytes);
  await truncate(short.source,short.request.byteLength-1);
  await assert.rejects(f.handoff.stage(short.request),{code:'FK_FILE_LENGTH'});
  const big=await f.put(Buffer.alloc(MAX_INLINE_AGENT_RESULT_BYTES+1));
  await assert.rejects(f.handoff.stage(big.request),{code:'FK_FILE_LIMIT'});
  await assert.rejects(f.handoff.stage({...big.request,byteLength:bytes.length}),{code:'FK_FILE_LIMIT'});
  for(const candidate of [Buffer.from('{"answer":"x","answer":"y"}'),Buffer.from([0xff])]) {
    const invalid=await f.put(candidate);
    await assert.rejects(f.handoff.stage(invalid.request),{code:'FK_FILE_JSON'});
  }
  const wrongSchema=await f.put(canonicalBytes({answer:1}));
  await assert.rejects(f.handoff.stage(wrongSchema.request),{code:'FK_FILE_SCHEMA'});
  assert.deepEqual(f.counts(),{signs:0,accepts:0});
});

test('file fallback rejects hard links and symbolic links before staging',async t=>{
  const f=await fixture(t);
  const bytes=canonicalBytes({answer:'hello'});
  const hardLinked=await f.put(bytes);
  await link(hardLinked.source,hardLinked.source+'.link');
  await assert.rejects(f.handoff.stage(hardLinked.request),{code:'FK_FILE_SOURCE'});

  const redirected=await f.put(bytes);
  const target=redirected.source+'.target';
  await rename(redirected.source,target);
  try {
    await symlink(target,redirected.source,'file');
  } catch (error) {
    if (process.platform!=='win32' || !['EPERM','EACCES'].includes(error.code)) throw error;
    // An unelevated Windows runner may only be able to create a junction.
    const directory=target+'-directory';
    await mkdir(directory);
    await symlink(directory,redirected.source,'junction');
    t.diagnostic('File symlinks require privileges on this Windows runner. Tested a junction.');
  }
  await assert.rejects(f.handoff.stage(redirected.request),{code:'FK_FILE_SOURCE'});

  // All inputs share a request. A regular file can still stage it after both rejections.
  const regular=await f.put(bytes);
  const ref=await f.handoff.stage(regular.request);
  assert.deepEqual(f.handoff.readSnapshot(ref.id).bytes,bytes);
});

test('file fallback rejects wrong request, wrong session, missing observation and competing consumers',async t=>{
  const f=await fixture(t);
  const input=await f.put(canonicalBytes({answer:'hello'}));
  const ref=await f.handoff.stage(input.request);
  await assert.rejects(f.operation({...ref,requestId:'wrong'}),{code:'FK_FILE_BINDING'});
  const wrongSession=f.call(ref,{turnId:'wrong'});
  await assert.rejects(f.operation(ref,{started:wrongSession,callback:wrongSession}),{code:'FK_FILE_BINDING'});
  await assert.rejects(f.operation(ref,{started:null}),{code:'FK_FILE_OBSERVATION'});
  await assert.rejects(f.operation(ref,{callback:f.call(ref,{callId:'wrong'})}),{code:'FK_FILE_OBSERVATION'});
  f.setPending({requestId:'different',attempt:2});
  await assert.rejects(f.operation(ref),{code:'FK_FILE_PENDING'});
  assert.deepEqual(f.counts(),{signs:0,accepts:0});
  f.setPending({requestId:'req-a',attempt:1,nodeId:'agent'});
  const results=await Promise.allSettled([f.operation(ref),f.operation(ref)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'FK_FILE_CONSUMED');
  assert.deepEqual(f.counts(),{signs:1,accepts:1});
});

test('expired references can be purged and uncertain claims cannot sign again after reopen',async t=>{
  const f=await fixture(t);
  const {request}=await f.put(canonicalBytes({answer:'hello'}));
  const first=await f.handoff.stage(request);
  f.expire();
  await assert.rejects(f.operation(first),{code:'FK_FILE_EXPIRY'});
  assert.equal(f.handoff.purgeExpired(),1);
  const second=await f.handoff.stage(request);
  await assert.rejects(f.operation(second,{async signAndAccept(){throw new Error('uncertain');}}),/uncertain/);
  const reopened=createFileHandoff(f.options);
  try {
    assert.equal(reopened.readSnapshot(second.id).state,'claimed');
    await assert.rejects(reopened.consume({started:f.call(second),callback:f.call(second),
      loadPending:()=>assert.fail('must not read Pending again'),signAndAccept:()=>assert.fail('must not re-sign')}),
      {code:'FK_FILE_CONSUMED'});
  } finally {reopened.close();}
});
