import {randomUUID} from 'node:crypto';
import {closeSync,constants,openSync} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes,sha256Bytes,assertSHA256,MAX_INLINE_AGENT_RESULT_BYTES}
  from '../../src/interactive/canonical.mjs';

const MAX_BYTES=MAX_INLINE_AGENT_RESULT_BYTES;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TOOL='flowkit_submit_file';
const fail=code=>Object.assign(new Error(code),{code});
const validId=value=>typeof value==='string' && UUID.test(value);
const label=value=>typeof value==='string' && value.length>0 && value.length<=256 && !/[\u0000-\u001f\u007f]/.test(value);
const sameFile=(a,b)=>a.dev===b.dev && a.ino===b.ino;

function bindingOf(value) {
  const {namespace,runId,requestId,nodeId,attempt,threadId,turnId,programHash,policyHash}=value;
  if (![namespace,runId,requestId,nodeId,threadId,turnId].every(label) || !Number.isSafeInteger(attempt) || attempt<1) {
    throw fail('FK_FILE_BINDING');
  }
  assertSHA256(programHash);
  assertSHA256(policyHash);
  return {namespace,runId,requestId,nodeId,attempt,threadId,turnId,programHash,policyHash};
}

async function capture(file,size,hash) {
  const entry=await lstat(file,{bigint:true});
  if (!entry.isFile() || entry.nlink!==1n) throw fail('FK_FILE_SOURCE');
  const flags=constants.O_RDONLY | (process.platform==='win32'?0:(constants.O_NOFOLLOW??0))
    | (constants.O_NONBLOCK??0);
  const handle=await open(file,flags);
  try {
    const before=await handle.stat({bigint:true});
    const named=await lstat(file,{bigint:true});
    if (!before.isFile() || !named.isFile() || before.nlink!==1n
      || !sameFile(entry,before) || !sameFile(named,before)) throw fail('FK_FILE_SOURCE');
    if (before.size>BigInt(MAX_BYTES)) throw fail('FK_FILE_LIMIT');
    if (before.size!==BigInt(size)) throw fail('FK_FILE_LENGTH');
    const bytes=Buffer.alloc(size+1);
    let length=0;
    while(length<bytes.length) {
      const {bytesRead}=await handle.read(bytes,length,bytes.length-length,null);
      if(!bytesRead) break;
      length+=bytesRead;
    }
    const after=await handle.stat({bigint:true});
    if (length!==size || after.size!==before.size) throw fail('FK_FILE_LENGTH');
    if (after.mtimeNs!==before.mtimeNs || after.ctimeNs!==before.ctimeNs) throw fail('FK_FILE_CHANGED');
    const snapshot=bytes.subarray(0,length);
    if (sha256Bytes(snapshot)!==hash) throw fail('FK_FILE_DIGEST');
    return snapshot;
  } finally {await handle.close();}
}

function parseArtifact(bytes,validate,binding) {
  let value;
  try {
    value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
    if (!value || Array.isArray(value) || typeof value!=='object'
      || !canonicalBytes(value).equals(bytes)) throw fail('FK_FILE_JSON');
  } catch {throw fail('FK_FILE_JSON');}
  if (validate(value,binding)!==true) throw fail('FK_FILE_SCHEMA');
}

function observedCall(started,callback) {
  if (!started || !callback || started.tool!==TOOL || callback.tool!==TOOL
    || !['threadId','turnId','callId'].every(key=>label(started[key]) && started[key]===callback[key])) {
    throw fail('FK_FILE_OBSERVATION');
  }
  let args;
  try {
    const observed=canonicalBytes(started.arguments,2048);
    if (!observed.equals(canonicalBytes(callback.arguments,2048))) throw fail('FK_FILE_OBSERVATION');
    args=JSON.parse(observed);
  } catch {throw fail('FK_FILE_OBSERVATION');}
  if (!args || Object.keys(args).length!==2 || !validId(args.id) || !label(args.requestId)) {
    throw fail('FK_FILE_REFERENCE');
  }
  return {...args,threadId:started.threadId,turnId:started.turnId,callId:started.callId};
}

/** Host-only adapter. The provisioner owns the private DB and the ingress directory. */
export function createFileHandoff({database,inbox,validateArtifact,now=Date.now}) {
  if (!path.isAbsolute(database) || !path.isAbsolute(inbox) || typeof validateArtifact!=='function'
    || typeof now!=='function') throw new TypeError('Host file handoff configuration required');
  try {closeSync(openSync(database,'wx',0o600));}
  catch(error) {
    if (error.code!=='EEXIST') throw error;
    // A reopened database is allowed only inside the protected Host directory.
  }
  const db=new DatabaseSync(database);
  try {
    db.exec(`
      PRAGMA busy_timeout=15000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS file_handoff (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, run_id TEXT NOT NULL,
        request_id TEXT NOT NULL, binding TEXT NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        bytes BLOB NOT NULL, state TEXT NOT NULL CHECK(state IN ('staged','claimed','acked')),
        call_id TEXT, accepted_revision INTEGER,
        UNIQUE(namespace,run_id,request_id)
      ) STRICT;
    `);
    if (db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'
      || db.prepare('PRAGMA synchronous').get().synchronous!==2) throw fail('FK_FILE_STORE');
  } catch(error) {db.close();throw error;}
  const insert=db.prepare(`INSERT INTO file_handoff
    (id,namespace,run_id,request_id,binding,sha256,size,expires_at,bytes,state)
    VALUES (?,?,?,?,?,?,?,?,?,'staged')`);
  const read=db.prepare('SELECT * FROM file_handoff WHERE id=?');
  const claim=db.prepare(`UPDATE file_handoff SET state='claimed',call_id=?
    WHERE id=? AND state='staged' AND expires_at>?`);
  const ack=db.prepare(`UPDATE file_handoff SET state='acked',accepted_revision=?
    WHERE id=? AND state='claimed' AND call_id=?`);
  const purge=db.prepare("DELETE FROM file_handoff WHERE expires_at<=? AND state='staged'");

  return Object.freeze({
    close:()=>db.close(),
    purgeExpired:()=>purge.run(now()).changes,
    readSnapshot(id) {
      if (!validId(id)) throw fail('FK_FILE_REFERENCE');
      const saved=read.get(id);
      if (!saved) return null;
      const bytes=Buffer.from(saved.bytes);
      if (bytes.length!==saved.size || sha256Bytes(bytes)!==saved.sha256) throw fail('FK_FILE_STORE');
      return {bytes,sha256:saved.sha256,byteLength:saved.size,state:saved.state,acceptedRevision:saved.accepted_revision};
    },
    // Only a trusted ingress producer may declare the expected original bytes.
    async stage({sourceId,binding:inputBinding,byteLength,sha256,ttlMs=120000}) {
      if (!validId(sourceId)) throw fail('FK_FILE_SOURCE');
      if (!Number.isSafeInteger(byteLength) || byteLength<1 || byteLength>MAX_BYTES) throw fail('FK_FILE_LIMIT');
      assertSHA256(sha256);
      if (!Number.isSafeInteger(ttlMs) || ttlMs<1 || ttlMs>300000) throw fail('FK_FILE_EXPIRY');
      const binding=Object.freeze(bindingOf(inputBinding));
      const expiresAt=now()+ttlMs;
      const bytes=await capture(path.join(inbox,sourceId+'.json'),byteLength,sha256);
      parseArtifact(bytes,validateArtifact,binding);
      if (expiresAt<=now()) throw fail('FK_FILE_EXPIRY');
      const id=randomUUID();
      insert.run(id,binding.namespace,binding.runId,binding.requestId,JSON.stringify(binding),
        sha256,byteLength,expiresAt,bytes);
      return {id,requestId:binding.requestId};
    },
    async consume({started,callback,loadPending,signAndAccept}) {
      const call=observedCall(started,callback);
      const saved=read.get(call.id);
      if (!saved) throw fail('FK_FILE_REFERENCE');
      if (saved.state!=='staged') throw fail('FK_FILE_CONSUMED');
      if (saved.expires_at<=now()) throw fail('FK_FILE_EXPIRY');
      const binding=Object.freeze(JSON.parse(saved.binding));
      if (['threadId','turnId','requestId'].some(key=>call[key]!==binding[key])) throw fail('FK_FILE_BINDING');
      const current=loadPending(binding.runId);
      if (!current || current.status!=='waiting' || current.namespace!==binding.namespace || current.runId!==binding.runId
        || current.artifactHash!==binding.programHash || current.policyHash!==binding.policyHash
        || current.pending?.requestId!==binding.requestId || current.pending.nodeId!==binding.nodeId
        || current.pending.attempt!==binding.attempt) {
        throw fail('FK_FILE_PENDING');
      }
      const bytes=Buffer.from(saved.bytes);
      if (bytes.length!==saved.size || sha256Bytes(bytes)!==saved.sha256) throw fail('FK_FILE_STORE');
      if (claim.run(call.callId,call.id,now()).changes!==1) throw fail('FK_FILE_CONSUMED');
      const artifact=Object.freeze({id:call.id,byteLength:saved.size,sha256:saved.sha256});
      // A persisted claim never re-signs after an ambiguous or failed attempt.
      const result=await signAndAccept({binding,callId:call.callId,artifact,pending:current.pending});
      if (!Number.isSafeInteger(result?.acceptedRevision) || result.acceptedRevision<1
        || ack.run(result.acceptedRevision,call.id,call.callId).changes!==1) throw fail('FK_FILE_UNCERTAIN');
      return result;
    },
  });
}
