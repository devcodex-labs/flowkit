import {createPublicKey,randomUUID,sign} from 'node:crypto';
import {closeSync,openSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
import {sqliteHostTrust} from '../../src/interactive/sqlite-store.mjs';
import {
  createAgentReceiptStatement,encodeAgentReceiptStatement,normalizeHostAgentReceipt,MAX_AGENT_RECEIPT_BYTES,
} from '../../src/interactive/host-attestation.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const identifier=value=>typeof value==='string' && value.length>0 && value.length<=256
  && !/[\u0000-\u001f\u007f]/.test(value);

function decode(bytes,limit) {
  const saved=Buffer.from(bytes);
  const value=JSON.parse(saved.toString('utf8'));
  if (!canonicalBytes(value,limit).equals(saved)) throw fail('FK_OUTBOX_CORRUPT');
  return value;
}

/** A dedicated SQLite file in an operator-protected Host directory. */
export function openCodexOutbox({database,store,host,handoff,now=Date.now,
  maxBytes=64*1024*1024,maxRecords=4096,retentionMs=30*24*60*60*1000,
  authorizeCleanup,onCapacity=({records,bytes,maxRecords,maxBytes})=>{
    process.emitWarning(`Outbox capacity: ${records}/${maxRecords} records, ${bytes}/${maxBytes} bytes`,
      {code:'FK_OUTBOX_CAPACITY'});
  }}) {
  if (!path.isAbsolute(database)) throw new TypeError('Outbox requires an absolute database path');
  if (![maxBytes,maxRecords,retentionMs].every(value=>Number.isSafeInteger(value) && value>0)
    || typeof onCapacity!=='function' || (authorizeCleanup!==undefined && typeof authorizeCleanup!=='function')) {
    throw new TypeError('Invalid Outbox retention configuration');
  }
  try {closeSync(openSync(database,'wx',0o600));}
  catch (error) {if (error.code!=='EEXIST') throw error;}
  const db=new DatabaseSync(database);
  try {
    db.exec(
      'PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      + "CREATE TABLE IF NOT EXISTS delivery (proof_id TEXT PRIMARY KEY, namespace TEXT NOT NULL,"
      + " run_id TEXT NOT NULL, request_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,"
      + " call_id TEXT NOT NULL, observation BLOB NOT NULL, receipt BLOB NOT NULL, receipt_hash TEXT NOT NULL,"
      + " statement BLOB, signature BLOB, accepted_revision INTEGER,"
      + " state TEXT NOT NULL CHECK(state IN ('OBSERVED','SIGNED','ACKED','CONFLICT','BLOCKED')),"
      + ' recorded_at INTEGER NOT NULL, acked_at INTEGER, reserved_bytes INTEGER NOT NULL,'
      + ' UNIQUE(thread_id,turn_id,call_id)) STRICT;'
      + 'CREATE TABLE IF NOT EXISTS cleanup_audit (operation_id TEXT PRIMARY KEY, namespace TEXT NOT NULL,'
      + ' subject_id TEXT NOT NULL, reason_code TEXT NOT NULL, at INTEGER NOT NULL, deleted_count INTEGER NOT NULL) STRICT;'
      + 'CREATE TABLE IF NOT EXISTS snapshot_cleanup (proof_id TEXT PRIMARY KEY, namespace TEXT NOT NULL,'
      + ' run_id TEXT NOT NULL, request_id TEXT NOT NULL, artifact TEXT NOT NULL, call_id TEXT NOT NULL,'
      + ' accepted_revision INTEGER NOT NULL) STRICT;'
    );
    if (db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'
      || db.prepare('PRAGMA synchronous').get().synchronous!==2) throw fail('FK_OUTBOX_DURABILITY');
  } catch (error) {db.close();throw error;}
  const get=db.prepare('SELECT * FROM delivery WHERE proof_id=? AND namespace=?');
  const insert=db.prepare("INSERT INTO delivery VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,'OBSERVED',?,NULL,?)");
  const save=db.prepare("UPDATE delivery SET statement=?,signature=?,state='SIGNED' WHERE proof_id=? AND state='OBSERVED'");
  const finish=db.prepare("UPDATE delivery SET state=?,accepted_revision=?,acked_at=? WHERE proof_id=? AND state='SIGNED'");
  const signed=db.prepare("SELECT proof_id FROM delivery WHERE namespace=? AND run_id=? AND state='SIGNED' ORDER BY rowid");
  const usage=db.prepare(`SELECT COUNT(*) AS records,COALESCE(SUM(bytes),0) AS bytes FROM (
    SELECT reserved_bytes AS bytes FROM delivery UNION ALL
    SELECT length(artifact)+length(call_id)+length(request_id)+length(run_id)+length(namespace)+128
    FROM snapshot_cleanup)`);
  const eligible=db.prepare("SELECT proof_id,run_id,request_id,receipt_hash,accepted_revision,observation"
    +" FROM delivery WHERE namespace=? AND state='ACKED' AND acked_at<=? ORDER BY acked_at");
  const remove=db.prepare("DELETE FROM delivery WHERE proof_id=? AND namespace=? AND state='ACKED'");
  const audit=db.prepare('INSERT INTO cleanup_audit VALUES (?,?,?,?,?,?)');
  const queueSnapshot=db.prepare('INSERT INTO snapshot_cleanup VALUES (?,?,?,?,?,?,?)');
  const pendingSnapshots=db.prepare('SELECT * FROM snapshot_cleanup WHERE namespace=? ORDER BY rowid');
  const removeSnapshotJob=db.prepare('DELETE FROM snapshot_cleanup WHERE proof_id=? AND namespace=?');
  const trust=store[sqliteHostTrust];

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result=work();
      db.exec('COMMIT');
      return result;
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }

  function checkResult(tool,args,result,binding,callId) {
    if (tool==='flowkit_submit_file' && handoff && Object.keys(result??{}).length===1
      && result.artifact && Object.keys(result.artifact).length===3 && result.artifact.id===args?.id) {
      handoff.verifyClaim(result.artifact,binding,callId);
      return;
    }
    if (tool!=='flowkit_submit' || typeof args?.answer!=='string'
      || Object.keys(result??{}).length!==1 || result.answer!==args.answer) throw fail('FK_OUTBOX_OBSERVATION');
  }

  async function record({task,started,callback,modelPid},receipt,key,
    {keyId='proof',ttlMs=120000,afterObserve}={}) {
    const normalized=normalizeHostAgentReceipt(receipt);
    const cp=store.load(normalized.runId);
    if (!cp || cp.policyHash!==host.policyHash) throw fail('FK_OUTBOX_OBSERVATION');
    trust?.assertActive(cp.policyHash);
    const {threadId,turnId,callId,tool,args}=callback;
    if (![threadId,turnId,callId].every(identifier) || normalized.kind!=='agent-result'
      || !Number.isSafeInteger(modelPid) || modelPid<2
      || ['threadId','turnId','callId','tool'].some(field=>started?.[field]!==callback[field])
      || !canonicalBytes(started?.args,4096).equals(canonicalBytes(args,4096))
      || args.requestId!==normalized.requestId
      || cp?.status!=='waiting' || cp.namespace!==store.namespace || task.runId!==normalized.runId
      || task.requestId!==normalized.requestId || cp.pending?.requestId!==normalized.requestId
      || cp.pending?.nodeId!==normalized.nodeId || cp.pending?.attempt!==normalized.attempt) {
      throw fail('FK_OUTBOX_OBSERVATION');
    }
    checkResult(tool,args,normalized.result,{...normalized,namespace:cp.namespace,threadId,turnId,
      programHash:cp.artifactHash,policyHash:cp.policyHash},callId);
    const proofId=randomUUID();
    const receiptBytes=canonicalBytes(normalized,MAX_AGENT_RECEIPT_BYTES);
    const receiptHash=sha256Bytes(receiptBytes);
    const observation=canonicalBytes({modelPid,threadId,turnId,callId,tool,namespace:cp.namespace,
      runId:normalized.runId,requestId:normalized.requestId,nodeId:normalized.nodeId,attempt:normalized.attempt,
      artifactHash:cp.artifactHash,policyHash:cp.policyHash,taskDigest:sha256Bytes(canonicalBytes(task)),
      toolInputDigest:sha256Bytes(canonicalBytes(args,4096)),receiptHash,source:'HOST_OBSERVED'},4096);
    const reserved=observation.byteLength+receiptBytes.byteLength+4096+64;
    try {
      transaction(()=>{
        const current=usage.get();
        if (current.records>=maxRecords || reserved>maxBytes-current.bytes) throw fail('FK_OUTBOX_CAPACITY');
        insert.run(proofId,cp.namespace,normalized.runId,normalized.requestId,threadId,turnId,callId,
          observation,receiptBytes,receiptHash,now(),reserved);
      });
    } catch(error) {
      if (error.code==='FK_OUTBOX_CAPACITY') {
        try {onCapacity({namespace:store.namespace,...usage.get(),maxBytes,maxRecords});} catch {}
      }
      throw error;
    }
    if (afterObserve) await afterObserve(describe(proofId));
    const issuedAt=now();
    const statement=createAgentReceiptStatement({run:cp,receipt:normalized,keyId,
      proofId,issuedAt,expiresAt:issuedAt+ttlMs});
    const statementBytes=encodeAgentReceiptStatement(statement);
    const signReceipt=()=>sign(null,statementBytes,key);
    const signature=trust
      ? trust.sign(cp.policyHash,sha256Bytes(createPublicKey(key).export({type:'spki',format:'der'})),signReceipt)
      : signReceipt();
    if (save.run(statementBytes,signature,proofId).changes!==1) throw fail('FK_OUTBOX_STATE');
    return proofId;
  }

  function describe(proofId) {
    const row=get.get(proofId,store.namespace);
    if (!row) throw fail('FK_OUTBOX_STATE');
    return {proofId,state:row.state,receiptHash:row.receipt_hash,acceptedRevision:row.accepted_revision,
      ...(row.statement?{statementHash:sha256Bytes(row.statement),signatureHash:sha256Bytes(row.signature),
        expiresAt:decode(row.statement,4096).expiresAt}:{})};
  }

  async function deliver(proofId,{afterAccept}={}) {
    const row=get.get(proofId,store.namespace);
    if (!row || !['SIGNED','ACKED'].includes(row.state)) throw fail('FK_OUTBOX_STATE');
    const receipt=decode(row.receipt,MAX_AGENT_RECEIPT_BYTES);
    const statement=decode(row.statement,4096);
    const observation=decode(row.observation,4096);
    if (statement.proofId!==proofId || statement.namespace!==store.namespace
      || receipt.runId!==row.run_id || receipt.requestId!==row.request_id
      || statement.receiptHash!==row.receipt_hash || sha256Bytes(row.receipt)!==row.receipt_hash
      || observation.receiptHash!==row.receipt_hash || observation.callId!==row.call_id
      || observation.threadId!==row.thread_id || observation.turnId!==row.turn_id) throw fail('FK_OUTBOX_CORRUPT');
    const artifact=observation.tool==='flowkit_submit_file'?receipt.result?.artifact:null;
    if (observation.tool==='flowkit_submit_file') {
      if (!handoff) throw fail('FK_OUTBOX_OBSERVATION');
      handoff.verifyClaim(artifact,{...receipt,namespace:statement.namespace,threadId:row.thread_id,
        turnId:row.turn_id,programHash:statement.artifactHash,policyHash:statement.policyHash},row.call_id);
    }
    const indexed=()=>store.getReceipt(row.run_id,row.request_id);
    const matching=ack=>ack?.digest===row.receipt_hash && ack.nodeId===receipt.nodeId && ack.attempt===receipt.attempt;
    const existing=indexed();
    if (!matching(existing) && now()>=statement.expiresAt) {
      finish.run('BLOCKED',null,null,proofId);
      throw fail('FK_OUTBOX_EXPIRED');
    }
    let frame;
    try {
      frame=await host.accept({receipt,attestation:{statement,signature:Buffer.from(row.signature).toString('base64url')}});
    } catch (error) {
      if (error.code==='FK_I_RECEIPT_CONFLICT') finish.run('CONFLICT',null,null,proofId);
      throw error;
    }
    const ack=indexed();
    if (!matching(ack) || ack.acceptedRevision!==frame.acceptedRevision) throw fail('FK_OUTBOX_ACK');
    if (afterAccept) await afterAccept(ack);
    if (artifact) handoff.acknowledge(artifact.id,row.call_id,ack.acceptedRevision);
    finish.run('ACKED',ack.acceptedRevision,now(),proofId);
    const final=describe(proofId);
    if (final.state!=='ACKED' || final.acceptedRevision!==ack.acceptedRevision) throw fail('FK_OUTBOX_ACK');
    return frame;
  }

  async function cleanup({namespace,subjectId,reasonCode}={}) {
    if (!authorizeCleanup || namespace!==store.namespace || !identifier(subjectId)
      || typeof reasonCode!=='string' || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(reasonCode)) throw fail('FK_OUTBOX_DENIED');
    let decision;
    try { decision=await authorizeCleanup(Object.freeze({action:'outbox:cleanup',namespace,subjectId,reasonCode})); } catch {}
    // The Host's retention authority supplies the protected Runs for this operation.
    if (decision?.allowed!==true || !Array.isArray(decision.heldRunIds)
      || !decision.heldRunIds.every(identifier)
      || (decision.canDeleteSnapshot!==undefined && typeof decision.canDeleteSnapshot!=='function')) {
      throw fail('FK_OUTBOX_DENIED');
    }
    const held=new Set(decision.heldRunIds);
    const result=transaction(()=>{
      const at=now();
      let deleted=0;
      for (const row of eligible.all(namespace,at-retentionMs)) {
        if (held.has(row.run_id)) continue;
        const cp=store.load(row.run_id);
        if (!cp || !['succeeded','failed','errored','cancelled'].includes(cp.status)) continue;
        const observation=decode(row.observation,4096);
        const indexed=store.getReceipt(row.run_id,row.request_id);
        if (indexed?.digest!==row.receipt_hash || indexed.acceptedRevision!==row.accepted_revision
          || indexed.nodeId!==observation.nodeId || indexed.attempt!==observation.attempt) continue;
        if (observation.tool==='flowkit_submit_file') {
          // Keep the proof available until the operator confirms the snapshot is safe to reclaim.
          const evidence=get.get(row.proof_id,namespace);
          const receipt=decode(evidence.receipt,MAX_AGENT_RECEIPT_BYTES);
          const artifact=receipt.result?.artifact;
          if (!handoff || !artifact) continue;
          queueSnapshot.run(row.proof_id,namespace,row.run_id,row.request_id,
            canonicalBytes(artifact,2048).toString('utf8'),evidence.call_id,row.accepted_revision);
        }
        deleted+=remove.run(row.proof_id,namespace).changes;
      }
      const operationId=randomUUID();
      if (deleted) audit.run(operationId,namespace,subjectId,reasonCode,at,deleted);
      return {operationId:deleted?operationId:null,deleted};
    });
    let snapshotsReclaimed=0;
    for (const row of pendingSnapshots.all(namespace)) {
      if (held.has(row.run_id) || !handoff || !decision.canDeleteSnapshot) continue;
      const artifact=Object.freeze(JSON.parse(row.artifact));
      const checkpoint=store.load(row.run_id);
      if (decision.canDeleteSnapshot(Object.freeze({
        namespace,runId:row.run_id,requestId:row.request_id,artifact,checkpoint,
      }))!==true) continue;
      handoff.reclaimAcknowledged(artifact,{namespace,runId:row.run_id,requestId:row.request_id,
        callId:row.call_id,acceptedRevision:row.accepted_revision});
      snapshotsReclaimed+=removeSnapshotJob.run(row.proof_id,namespace).changes;
    }
    return {...result,snapshotsReclaimed};
  }

  return Object.freeze({record,describe,deliver,cleanup,usage:()=>usage.get(),close:()=>db.close(),
    async recover(runId) {
      const results=[];
      for (const {proof_id:proofId} of signed.all(store.namespace,runId)) {
        try {await deliver(proofId);}
        catch (error) {
          if (!['FK_OUTBOX_EXPIRED','FK_I_RECEIPT_CONFLICT'].includes(error.code)) throw error;
        }
        results.push(describe(proofId));
      }
      return results;
    },
  });
}
