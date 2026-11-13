import {randomUUID,sign} from 'node:crypto';
import {closeSync,openSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes,sha256Bytes} from '../../src/interactive/canonical.mjs';
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
export function openCodexOutbox({database,store,host,now=Date.now}) {
  if (!path.isAbsolute(database)) throw new TypeError('Outbox requires an absolute database path');
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
      + ' UNIQUE(thread_id,turn_id,call_id)) STRICT;'
    );
    if (db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'
      || db.prepare('PRAGMA synchronous').get().synchronous!==2) throw fail('FK_OUTBOX_DURABILITY');
  } catch (error) {db.close();throw error;}
  const get=db.prepare('SELECT * FROM delivery WHERE proof_id=? AND namespace=?');
  const insert=db.prepare("INSERT INTO delivery VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,'OBSERVED')");
  const save=db.prepare("UPDATE delivery SET statement=?,signature=?,state='SIGNED' WHERE proof_id=? AND state='OBSERVED'");
  const finish=db.prepare("UPDATE delivery SET state=?,accepted_revision=? WHERE proof_id=? AND state='SIGNED'");
  const signed=db.prepare("SELECT proof_id FROM delivery WHERE namespace=? AND run_id=? AND state='SIGNED' ORDER BY rowid");

  function record({task,started,callback,modelPid},receipt,key) {
    const normalized=normalizeHostAgentReceipt(receipt);
    const cp=store.load(normalized.runId);
    const {threadId,turnId,callId,tool,args}=callback;
    if (![threadId,turnId,callId].every(identifier) || tool!=='flowkit_submit'
      || !Number.isSafeInteger(modelPid) || modelPid<2
      || ['threadId','turnId','callId','tool'].some(field=>started?.[field]!==callback[field])
      || !canonicalBytes(started?.args,4096).equals(canonicalBytes(args,4096))
      || args.requestId!==normalized.requestId || normalized.result?.answer!==args.answer
      || cp?.status!=='waiting' || cp.namespace!==store.namespace || task.runId!==normalized.runId
      || task.requestId!==normalized.requestId || cp.pending?.requestId!==normalized.requestId
      || cp.pending?.nodeId!==normalized.nodeId || cp.pending?.attempt!==normalized.attempt) {
      throw fail('FK_OUTBOX_OBSERVATION');
    }
    const proofId=randomUUID();
    const receiptBytes=canonicalBytes(normalized,MAX_AGENT_RECEIPT_BYTES);
    const receiptHash=sha256Bytes(receiptBytes);
    const observation=canonicalBytes({modelPid,threadId,turnId,callId,tool,namespace:cp.namespace,
      runId:normalized.runId,requestId:normalized.requestId,nodeId:normalized.nodeId,attempt:normalized.attempt,
      artifactHash:cp.artifactHash,policyHash:cp.policyHash,taskDigest:sha256Bytes(canonicalBytes(task)),
      toolInputDigest:sha256Bytes(canonicalBytes(args,4096)),receiptHash,source:'HOST_OBSERVED'},4096);
    insert.run(proofId,cp.namespace,normalized.runId,normalized.requestId,threadId,turnId,callId,
      observation,receiptBytes,receiptHash);
    const issuedAt=now();
    const statement=createAgentReceiptStatement({run:cp,receipt:normalized,keyId:'proof',
      proofId,issuedAt,expiresAt:issuedAt+120000});
    const statementBytes=encodeAgentReceiptStatement(statement);
    const signature=sign(null,statementBytes,key);
    if (save.run(statementBytes,signature,proofId).changes!==1) throw fail('FK_OUTBOX_STATE');
    return proofId;
  }

  function describe(proofId) {
    const row=get.get(proofId,store.namespace);
    if (!row) throw fail('FK_OUTBOX_STATE');
    return {proofId,state:row.state,receiptHash:row.receipt_hash,acceptedRevision:row.accepted_revision,
      ...(row.statement?{statementHash:sha256Bytes(row.statement),signatureHash:sha256Bytes(row.signature)}:{})};
  }

  async function deliver(proofId) {
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
    const indexed=()=>store.getReceipt(row.run_id,row.request_id);
    const matching=ack=>ack?.digest===row.receipt_hash && ack.nodeId===receipt.nodeId && ack.attempt===receipt.attempt;
    const existing=indexed();
    if (!matching(existing) && now()>=statement.expiresAt) {
      finish.run('BLOCKED',null,proofId);
      throw fail('FK_OUTBOX_EXPIRED');
    }
    let frame;
    try {
      frame=await host.accept({receipt,attestation:{statement,signature:Buffer.from(row.signature).toString('base64url')}});
    } catch (error) {
      if (error.code==='FK_I_RECEIPT_CONFLICT') finish.run('CONFLICT',null,proofId);
      throw error;
    }
    const ack=indexed();
    if (!matching(ack) || ack.acceptedRevision!==frame.acceptedRevision) throw fail('FK_OUTBOX_ACK');
    finish.run('ACKED',ack.acceptedRevision,proofId);
    const final=describe(proofId);
    if (final.state!=='ACKED' || final.acceptedRevision!==ack.acceptedRevision) throw fail('FK_OUTBOX_ACK');
    return frame;
  }

  return Object.freeze({record,describe,deliver,close:()=>db.close(),
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
