import { canonicalBytes, decodeCanonical, sha256Bytes, assertSHA256 } from './canonical.mjs';

const outcomes = new Set(['applied', 'no-effect']);

function conflict(message) {
  return Object.assign(new Error('FK_I_OPERATION_CONFLICT: ' + message), {code:'FK_I_OPERATION_CONFLICT'});
}

export function prepareOperationLedger(db, namespace, { transaction, assertDispatch,assertCompensable }) {
  const select = db.prepare(`
    SELECT * FROM fk_i_operations WHERE namespace = ? AND run_id = ? AND operation_key = ?
  `);
  const insert = db.prepare(`
    INSERT INTO fk_i_operations (namespace, run_id, operation_key, request_id, input_hash, business_key, compensation_plan, read_only)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const businessOperation=db.prepare(`
    SELECT request_id,input_hash,compensation_plan,effect FROM fk_i_operations
    WHERE namespace=? AND run_id=? AND business_key=?
  `);
  const operationsByRun=db.prepare(`
    SELECT * FROM fk_i_operations WHERE namespace=? AND run_id=? ORDER BY request_id,operation_key
  `);
  const update = db.prepare(`
    UPDATE fk_i_operations SET effect = ?, evidence_hash = ?, result_json = ?, result_hash = ?
    WHERE namespace = ? AND run_id = ? AND operation_key = ? AND effect IS NULL
  `);
  const registerCompensation=db.prepare(`
    UPDATE fk_i_operations SET compensation_key=?
    WHERE namespace=? AND run_id=? AND operation_key=? AND compensation_key IS NULL
  `);
  const recordUnexecuted=db.prepare(`
    INSERT INTO fk_i_compensation_attempts (namespace,run_id,operation_key,attempt_key,no_effect_evidence)
    VALUES (?,?,?,?,?)
  `);
  const rotateCompensation=db.prepare(`
    UPDATE fk_i_operations SET compensation_key=? WHERE namespace=? AND run_id=? AND operation_key=?
  `);
  const confirmCompensation=db.prepare(`
    UPDATE fk_i_operations SET compensation_evidence_hash=?
    WHERE namespace=? AND run_id=? AND operation_key=? AND compensation_evidence_hash IS NULL
  `);

  function record(row) {
    if (!row) return null;
    return {
      requestId:row.request_id, inputHash:row.input_hash,
      ...(row.read_only?{readOnly:true}:{}),
      ...(row.business_key?{businessKey:row.business_key}:{}),
      ...(row.compensation_plan?{compensationPlan:JSON.parse(row.compensation_plan)}:{}),
      ...(row.compensation_key?{compensation:{key:row.compensation_key,
        idempotencyKey:compensationIdentity(row),evidenceHash:row.compensation_evidence_hash}}:{}),
      settlement:row.effect === null ? null : {
        effect:row.effect, evidenceHash:row.evidence_hash,
        result:decodeCanonical(row.result_json,row.result_hash),
      },
    };
  }

  function compensationIdentity(row) {
    return sha256Bytes(canonicalBytes([namespace,row.run_id,row.operation_key,row.compensation_plan,'compensation']));
  }

  return Object.freeze({
    claim({ runId, requestId, operationKey, inputHash, businessKey, compensationPlan }) {
      assertSHA256(operationKey);
      assertSHA256(inputHash);
      if (businessKey!==undefined) assertSHA256(businessKey);
      let plan;
      if (compensationPlan!==undefined) {
        if (!compensationPlan || typeof compensationPlan.capabilityId!=='string'
          || !compensationPlan.capabilityId || compensationPlan.capabilityId.length>256
          || Object.keys(compensationPlan).length!==2) throw new TypeError('Compensation capability and input hash are required');
        assertSHA256(compensationPlan.inputHash);
        plan=canonicalBytes(compensationPlan).toString('utf8');
      }
      return transaction('write', () => {
        const {readOnly}=assertDispatch(runId,requestId,inputHash,operationKey,businessKey,compensationPlan);
        const row=select.get(namespace,runId,operationKey);
        const existing = record(row);
        if (existing) {
          if (existing.inputHash !== inputHash || existing.businessKey!==businessKey || row.compensation_plan!==(plan??null)) {
            throw conflict('operation key is bound to different input or effect');
          }
          if (existing.requestId !== requestId) throw conflict('operation key belongs to a different Pending');
          return {claimed:false, ...existing};
        }
        if (businessKey && businessOperation.all(namespace,runId,businessKey).some(previous=>
          previous.effect!=='no-effect' || previous.request_id===requestId
          || previous.input_hash!==inputHash || previous.compensation_plan!==(plan??null))) {
          throw conflict('business effect has an active, applied or conflicting operation');
        }
        insert.run(namespace,runId,operationKey,requestId,inputHash,businessKey??null,plan??null,Number(readOnly));
        return {claimed:true, ...record(select.get(namespace,runId,operationKey))};
      });
    },
    load({ runId, operationKey }) {
      assertSHA256(operationKey);
      return record(select.get(namespace,runId,operationKey));
    },
    list({runId}) {
      return operationsByRun.all(namespace,runId).map(row=>({operationKey:row.operation_key,...record(row)}));
    },
    claimCompensation({runId,operationKey}) {
      assertSHA256(operationKey);
      return transaction('write',()=>{
        const saved=select.get(namespace,runId,operationKey);
        if (saved?.effect!=='applied' || !saved.compensation_plan) throw conflict('compensation requires an applied operation and a pinned plan');
        assertCompensable(runId,saved.request_id);
        if (saved.compensation_key) return {claimed:false,...record(saved)};
        const key=compensationIdentity(saved);
        registerCompensation.run(key,namespace,runId,operationKey);
        return {claimed:true,...record(select.get(namespace,runId,operationKey))};
      });
    },
    recoverCompensation({runId,operationKey,compensationKey,evidenceHash}) {
      assertSHA256(operationKey);
      assertSHA256(compensationKey);
      assertSHA256(evidenceHash);
      return transaction('write',()=>{
        const saved=select.get(namespace,runId,operationKey);
        if (!saved?.compensation_plan || saved.compensation_key!==compensationKey || saved.compensation_evidence_hash) {
          throw conflict('recovery requires the current unsettled compensation attempt');
        }
        assertCompensable(runId,saved.request_id);
        // The Host proves the old worker has stopped and the external effect did not occur.
        // Keep that evidence and rotate the settlement credential in the same transaction.
        recordUnexecuted.run(namespace,runId,operationKey,compensationKey,evidenceHash);
        const nextKey=sha256Bytes(canonicalBytes([compensationKey,evidenceHash,'compensation-recovery']));
        rotateCompensation.run(nextKey,namespace,runId,operationKey);
        return {claimed:true,...record(select.get(namespace,runId,operationKey))};
      });
    },
    settleCompensation({runId,operationKey,compensationKey,evidenceHash}) {
      assertSHA256(operationKey);
      assertSHA256(compensationKey);
      assertSHA256(evidenceHash);
      return transaction('write',()=>{
        const saved=select.get(namespace,runId,operationKey);
        if (saved?.compensation_key!==compensationKey) throw conflict('no matching compensation claim');
        if (saved.compensation_evidence_hash && saved.compensation_evidence_hash!==evidenceHash) {
          throw conflict('compensation evidence changed');
        }
        confirmCompensation.run(evidenceHash,namespace,runId,operationKey);
        return record(select.get(namespace,runId,operationKey));
      });
    },
    settle({ runId, operationKey, inputHash, effect, evidenceHash, result }) {
      assertSHA256(operationKey);
      assertSHA256(inputHash);
      assertSHA256(evidenceHash);
      if (!outcomes.has(effect)) throw new TypeError('Invalid operation settlement');
      const bytes = canonicalBytes(result);
      const resultHash = sha256Bytes(bytes);
      return transaction('write', () => {
        const existing = select.get(namespace,runId,operationKey);
        if (!existing || existing.input_hash !== inputHash) throw conflict('no matching operation claim');
        if (existing.read_only && effect!=='no-effect') throw conflict('read-only operation cannot report an applied effect');
        if (existing.effect !== null) {
          if (existing.effect !== effect || existing.evidence_hash !== evidenceHash || existing.result_hash !== resultHash) {
            throw conflict('operation has a different settlement');
          }
          return record(existing);
        }
        update.run(effect,evidenceHash,bytes.toString('utf8'),resultHash,namespace,runId,operationKey);
        return record(select.get(namespace,runId,operationKey));
      });
    },
  });
}
