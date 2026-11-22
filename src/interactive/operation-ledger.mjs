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
    INSERT INTO fk_i_operations (namespace, run_id, operation_key, request_id, input_hash, business_key, compensation_plan)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const businessOperation=db.prepare(`
    SELECT operation_key FROM fk_i_operations WHERE namespace=? AND run_id=? AND business_key=?
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
  const confirmCompensation=db.prepare(`
    UPDATE fk_i_operations SET compensation_evidence_hash=?
    WHERE namespace=? AND run_id=? AND operation_key=? AND compensation_evidence_hash IS NULL
  `);

  function record(row) {
    if (!row) return null;
    return {
      requestId:row.request_id, inputHash:row.input_hash,
      ...(row.business_key?{businessKey:row.business_key}:{}),
      ...(row.compensation_plan?{compensationPlan:JSON.parse(row.compensation_plan)}:{}),
      ...(row.compensation_key?{compensation:{key:row.compensation_key,evidenceHash:row.compensation_evidence_hash}}:{}),
      settlement:row.effect === null ? null : {
        effect:row.effect, evidenceHash:row.evidence_hash,
        result:decodeCanonical(row.result_json,row.result_hash),
      },
    };
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
        assertDispatch(runId,requestId,inputHash,operationKey,businessKey,compensationPlan);
        const row=select.get(namespace,runId,operationKey);
        const existing = record(row);
        if (existing) {
          if (existing.inputHash !== inputHash || existing.businessKey!==businessKey || row.compensation_plan!==(plan??null)) {
            throw conflict('operation key is bound to different input or effect');
          }
          if (existing.requestId !== requestId) throw conflict('operation key belongs to a different Pending');
          return {claimed:false, ...existing};
        }
        if (businessKey && businessOperation.get(namespace,runId,businessKey)) {
          throw conflict('business effect has already been reserved by a different operation');
        }
        insert.run(namespace,runId,operationKey,requestId,inputHash,businessKey??null,plan??null);
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
        if (saved.compensation_key) return {claimed:false,...record(saved)};
        assertCompensable(runId,saved.request_id);
        const key=sha256Bytes(canonicalBytes([namespace,runId,operationKey,saved.compensation_plan,'compensation']));
        registerCompensation.run(key,namespace,runId,operationKey);
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
