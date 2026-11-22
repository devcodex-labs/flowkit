import { canonicalBytes, decodeCanonical, sha256Bytes, assertSHA256 } from './canonical.mjs';

const outcomes = new Set(['applied', 'no-effect']);

function conflict(message) {
  return Object.assign(new Error('FK_I_OPERATION_CONFLICT: ' + message), {code:'FK_I_OPERATION_CONFLICT'});
}

export function prepareOperationLedger(db, namespace, { transaction, assertDispatch }) {
  const select = db.prepare(`
    SELECT * FROM fk_i_operations WHERE namespace = ? AND run_id = ? AND operation_key = ?
  `);
  const insert = db.prepare(`
    INSERT INTO fk_i_operations (namespace, run_id, operation_key, request_id, input_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE fk_i_operations SET effect = ?, evidence_hash = ?, result_json = ?, result_hash = ?
    WHERE namespace = ? AND run_id = ? AND operation_key = ? AND effect IS NULL
  `);

  function record(row) {
    if (!row) return null;
    return {
      requestId:row.request_id, inputHash:row.input_hash,
      settlement:row.effect === null ? null : {
        effect:row.effect, evidenceHash:row.evidence_hash,
        result:decodeCanonical(row.result_json,row.result_hash),
      },
    };
  }

  return Object.freeze({
    claim({ runId, requestId, operationKey, inputHash }) {
      assertSHA256(operationKey);
      assertSHA256(inputHash);
      return transaction('write', () => {
        assertDispatch(runId,requestId,inputHash,operationKey);
        const existing = record(select.get(namespace,runId,operationKey));
        if (existing) {
          if (existing.inputHash !== inputHash) throw conflict('operation key is bound to different input');
          if (existing.requestId !== requestId) throw conflict('operation key belongs to a different Pending');
          return {claimed:false, ...existing};
        }
        insert.run(namespace,runId,operationKey,requestId,inputHash);
        return {claimed:true,requestId,inputHash,settlement:null};
      });
    },
    load({ runId, operationKey }) {
      assertSHA256(operationKey);
      return record(select.get(namespace,runId,operationKey));
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
