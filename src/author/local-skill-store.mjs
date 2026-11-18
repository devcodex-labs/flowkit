import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifiedCollectionPlan } from './collections.mjs';
import { authorIdentity } from './host-target.mjs';
import { checkProfessionalSkill } from './professional-skills.mjs';
import { checkCandidate } from './standard-artifact.mjs';

const FORMAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fk_author_collections (collection_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, payload TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS fk_author_versions (
    collection_id TEXT NOT NULL, skill_id TEXT NOT NULL, candidate_hash TEXT NOT NULL, version TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(collection_id,skill_id,candidate_hash), UNIQUE(collection_id,skill_id,version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS fk_author_active (
    collection_id TEXT NOT NULL, skill_id TEXT NOT NULL, name TEXT NOT NULL, candidate_hash TEXT NOT NULL,
    PRIMARY KEY(collection_id,skill_id), UNIQUE(collection_id,name),
    FOREIGN KEY(collection_id,skill_id,candidate_hash) REFERENCES fk_author_versions(collection_id,skill_id,candidate_hash)
  ) STRICT;`;
const AUTHOR_COLUMNS = {
  fk_author_meta: 'singleton,namespace,schema_version,store_id',
  fk_author_drafts: 'draft_id,state_version,content_revision,status,payload',
  fk_author_turns: 'draft_id,turn_id,fingerprint,status,payload',
  fk_author_collections: 'collection_id,name,payload',
  fk_author_versions: 'collection_id,skill_id,candidate_hash,version,payload',
  fk_author_active: 'collection_id,skill_id,name,candidate_hash'
};

function checkPublishedSkill(candidate) {
  if (candidate.manifest.kind === 'professional') checkProfessionalSkill(candidate);
  else checkCandidate(candidate);
}

/** A Host-owned local store. Consumers read a complete version through one database snapshot. */
export function openLocalSkillStore(file, authorizePublication, authorizeCollectionChange, { namespace } = {}) {
  if (typeof authorizePublication !== 'function') throw new TypeError('Host publication verifier is required');
  // Inspect an existing namespace database read-only, before journal/DDL pragmas can change it.
  if (namespace !== undefined) {
    if (typeof namespace !== 'string' || !namespace.trim()) throw new TypeError('A namespace is required');
    try {
      if (statSync(file).nlink > 1) throw new Error('Hard-linked Author databases cannot share a WAL safely');
      file = realpathSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      file = path.join(realpathSync(path.dirname(path.resolve(file))), path.basename(file));
    }
    try {
      if (statSync(file).size) {
        const probe = new DatabaseSync(file, { readOnly: true });
        try {
          const meta = probe.prepare('SELECT namespace, schema_version, store_id FROM fk_author_meta WHERE singleton=1').get();
          if (meta?.namespace !== namespace || meta.schema_version !== 2) throw new Error('Author namespace or schema differs');
          for (const [table, columns] of Object.entries(AUTHOR_COLUMNS)) {
            if (probe.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).join(',') !== columns) throw new Error('Author schema differs');
          }
        } finally { probe.close(); }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { closeSync(openSync(file, 'wx')); } catch (claim) { if (claim.code !== 'EEXIST') throw claim; }
    }
  }
  const db = new DatabaseSync(file);
  try {
    if (namespace !== undefined) {
      db.exec('PRAGMA busy_timeout = 15000; BEGIN IMMEDIATE');
      try {
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length && !tables.some(row => row.name === 'fk_author_meta')) throw new Error('Unowned Author database');
        db.exec(`CREATE TABLE IF NOT EXISTS fk_author_meta (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), namespace TEXT NOT NULL,
          schema_version INTEGER NOT NULL, store_id TEXT NOT NULL
        ) STRICT`);
        db.prepare('INSERT OR IGNORE INTO fk_author_meta VALUES (1, ?, 2, ?)').run(namespace, randomUUID());
        const meta = db.prepare('SELECT * FROM fk_author_meta WHERE singleton=1').get();
        if (meta.namespace !== namespace || meta.schema_version !== 2) throw new Error('Author namespace or schema differs');
        db.exec(`CREATE TABLE IF NOT EXISTS fk_author_drafts (
          draft_id TEXT PRIMARY KEY, state_version INTEGER NOT NULL, content_revision INTEGER NOT NULL,
          status TEXT NOT NULL, payload TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS fk_author_turns (
          draft_id TEXT NOT NULL, turn_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(draft_id, turn_id), FOREIGN KEY(draft_id) REFERENCES fk_author_drafts(draft_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS fk_author_draft_status ON fk_author_drafts(status);
        CREATE INDEX IF NOT EXISTS fk_author_turn_status ON fk_author_turns(status);`);
        db.exec("CREATE INDEX IF NOT EXISTS fk_author_start_request ON fk_author_drafts(json_extract(payload,'$.startRequestId'))");
        db.exec(FORMAL_SCHEMA);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `);
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('Use a file-backed Skill store with WAL');
    if (namespace === undefined) db.exec(FORMAL_SCHEMA);
    const current = db.prepare('SELECT candidate_hash FROM fk_author_active WHERE collection_id = ? AND skill_id = ?');
    const read = db.prepare('SELECT payload FROM fk_author_versions WHERE collection_id = ? AND skill_id = ? AND candidate_hash = ?');
    const active = db.prepare(`SELECT payload FROM fk_author_active JOIN fk_author_versions USING (collection_id, skill_id, candidate_hash)
      WHERE collection_id = ? AND skill_id = ?`);
    const insert = db.prepare('INSERT INTO fk_author_versions VALUES (?, ?, ?, ?, ?)');
    const update = db.prepare(`INSERT INTO fk_author_active VALUES (?, ?, ?, ?)
      ON CONFLICT (collection_id, skill_id) DO UPDATE SET name = excluded.name, candidate_hash = excluded.candidate_hash`);

    const registered = db.prepare('SELECT name FROM fk_author_collections WHERE collection_id = ?');
    const register = db.prepare('INSERT INTO fk_author_collections VALUES (?, ?, ?)');
    const rename = db.prepare('UPDATE fk_author_collections SET name = ?, payload = ? WHERE collection_id = ?');
    const snapshot = db.prepare(`SELECT collections.payload AS collection, versions.payload AS workflow
      FROM fk_author_collections AS collections
      LEFT JOIN fk_author_active AS current USING (collection_id)
      LEFT JOIN fk_author_versions AS versions USING (collection_id, skill_id, candidate_hash)
      WHERE collection_id = ? ORDER BY current.name`);

    function readCandidate(row) {
      if (!row) return null;
      const candidate = JSON.parse(row.payload);
      checkPublishedSkill(candidate);
      return candidate;
    }

    let authorTransaction = false;
    function writeTransaction(operation) {
      if (authorTransaction) return operation();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    return Object.freeze({
      /** Internal Author unit of work. Publication and its durable receipt share this connection. */
      authorTransaction(operation) {
        if (namespace === undefined || authorTransaction) throw new Error('A namespace transaction is required');
        return writeTransaction(() => {
          authorTransaction = true;
          try {
            const state = {
              meta: () => ({ ...db.prepare('SELECT * FROM fk_author_meta WHERE singleton=1').get() }),
              readDraft: id => { const row = db.prepare('SELECT payload FROM fk_author_drafts WHERE draft_id=?').get(id); return row ? JSON.parse(row.payload) : null; },
              drafts: (limit = 10001) => db.prepare('SELECT payload FROM fk_author_drafts ORDER BY draft_id LIMIT ?').all(limit).map(row => JSON.parse(row.payload)),
              activeDrafts: limit => db.prepare("SELECT payload FROM fk_author_drafts WHERE status!='expired' ORDER BY draft_id LIMIT ?").all(limit).map(row => JSON.parse(row.payload)),
              findStartRequest: requestId => { const row = db.prepare("SELECT payload FROM fk_author_drafts WHERE json_extract(payload,'$.startRequestId')=? LIMIT 1").get(requestId); return row ? JSON.parse(row.payload) : null; },
              findToolOperation: key => {
                const row = db.prepare(`SELECT turns.draft_id,turns.turn_id,operations.value AS operation
                  FROM fk_author_turns AS turns,json_each(json_extract(turns.payload,'$.budget.toolOperations')) AS operations
                  WHERE operations.key=? ORDER BY CASE json_extract(operations.value,'$.status') WHEN 'no-effect' THEN 1 WHEN 'not-sent' THEN 1 ELSE 0 END LIMIT 1`).get(key);
                return row ? { draftId: row.draft_id, turnId: row.turn_id, ...JSON.parse(row.operation) } : null;
              },
              nextPublicationSequence: collectionId => db.prepare(`SELECT coalesce(max(json_extract(operations.value,'$.sequence')),0)+1 AS sequence
                FROM fk_author_drafts AS drafts,json_each(json_extract(drafts.payload,'$.publications')) AS operations
                WHERE json_extract(drafts.payload,'$.collectionId')=?`).get(collectionId).sequence,
              findPublication: operationId => {
                if (!operationId) return null;
                const row = db.prepare(`SELECT operations.value AS operation FROM fk_author_drafts AS drafts,
                  json_each(json_extract(drafts.payload,'$.publications')) AS operations WHERE json_extract(operations.value,'$.operationId')=? LIMIT 1`).get(operationId);
                return row ? JSON.parse(row.operation) : null;
              },
              usage: () => ({ ...db.prepare(`SELECT count(*) AS drafts,
                coalesce(sum(CASE WHEN status!='expired' THEN length(CAST(payload AS BLOB)) ELSE 0 END),0) AS draftBytes,
                coalesce(sum(CASE WHEN status='expired' THEN length(CAST(payload AS BLOB)) ELSE 0 END),0) AS tombstoneBytes
                FROM fk_author_drafts`).get(),
                ...db.prepare('SELECT count(*) AS turns,coalesce(sum(length(CAST(payload AS BLOB))),0) AS receiptBytes FROM fk_author_turns').get() }),
              writeDraft(draft, expected) {
                const payload = JSON.stringify(draft);
                if (expected === null) db.prepare('INSERT INTO fk_author_drafts VALUES (?, ?, ?, ?, ?)').run(draft.id, draft.stateVersion, draft.contentRevision, draft.status, payload);
                else if (db.prepare('UPDATE fk_author_drafts SET state_version=?, content_revision=?, status=?, payload=? WHERE draft_id=? AND state_version=?')
                  .run(draft.stateVersion, draft.contentRevision, draft.status, payload, draft.id, expected).changes !== 1) throw new Error('Author state CAS conflict');
              },
              readTurn: (id, turnId) => { const row = db.prepare('SELECT payload FROM fk_author_turns WHERE draft_id=? AND turn_id=?').get(id, turnId); return row ? JSON.parse(row.payload) : null; },
              turns: (id, limit = 10001) => db.prepare('SELECT payload FROM fk_author_turns WHERE draft_id=? ORDER BY turn_id LIMIT ?').all(id, limit).map(row => JSON.parse(row.payload)),
              writeTurn: turn => db.prepare(`INSERT INTO fk_author_turns VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(draft_id, turn_id) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status,payload=excluded.payload`)
                .run(turn.draftId, turn.turnId, turn.fingerprint, turn.status, JSON.stringify(turn))
            };
            const result = operation(state);
            if (result && typeof result.then === 'function') throw new TypeError('Author transactions must be synchronous');
            return result;
          } finally { authorTransaction = false; }
        });
      },
      readCollectionMetadata(collectionId,{limit=10001}={}) {
        if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError('Metadata query requires a positive row limit');
        const collection=db.prepare('SELECT payload FROM fk_author_collections WHERE collection_id=?').get(collectionId);
        if(!collection)return null;
        const skills=db.prepare(`SELECT active.collection_id,active.skill_id,active.name,active.candidate_hash,
          versions.version,json_extract(versions.payload,'$.manifest.kind') AS kind
          FROM fk_author_active AS active JOIN fk_author_versions AS versions USING(collection_id,skill_id,candidate_hash)
          WHERE active.collection_id=? ORDER BY active.name LIMIT ?`).all(collectionId,limit).map(row=>({hash:row.candidate_hash,
            manifest:{collectionId:row.collection_id,skillId:row.skill_id,name:row.name,version:row.version,
              ...(row.kind?{kind:row.kind}:{})}}));
        return {collection:JSON.parse(collection.payload),skills};
      },
      readActive(collectionId, skillId) { return readCandidate(active.get(collectionId, skillId)); },
      readVersion(collectionId, skillId, hash) { return readCandidate(read.get(collectionId, skillId, hash)); },
      readCollection(collectionId) {
        const rows = snapshot.all(collectionId);
        if (!rows.length) return null;
        return { collection: JSON.parse(rows[0].collection),
          skills: rows.filter(row => row.workflow !== null).map(row => readCandidate({ payload: row.workflow })) };
      },
      applyCollectionPlan(proposedPlan, approvalRef) {
        const { plan, planHash } = verifiedCollectionPlan(proposedPlan);
        const { id, name } = plan.destination;
        const payload = JSON.stringify(plan.destination);
        if (typeof approvalRef !== 'string' || !approvalRef.trim() || typeof authorizeCollectionChange !== 'function') {
          throw new Error('Host approval for the collection plan is required');
        }
        return writeTransaction(() => {
          const previous = registered.get(id)?.name ?? null;
          const expected = plan.operation === 'rename' ? plan.directory[0] : null;
          if (previous !== expected) throw new Error('Collection changed after review');
          if (plan.operation === 'rename' && authorIdentity(this.readCollectionMetadata(id, { limit: 10001 })) !== plan.expectedSnapshotHash) {
            throw new Error('Collection snapshot changed after review');
          }
          if (authorizeCollectionChange({ plan, planHash, approvalRef, previous }) !== true) {
            throw new Error('Host denied the collection plan');
          }
          if (plan.operation === 'rename') rename.run(name, payload, id);
          else register.run(id, name, payload);
          return plan.destination;
        });
      },
      publishAtomically({ candidate: proposedCandidate, reviewRef, approvalRef, previousHash }) {
        const candidate = structuredClone(proposedCandidate);
        checkPublishedSkill(candidate);
        const { collectionId, skillId, name, version } = candidate.manifest;
        const payload = JSON.stringify(candidate);
        const hash = candidate.hash;
        return writeTransaction(() => {
          if (authorizePublication(Object.freeze({ collectionId, skillId, name, version,
            candidateHash: hash, previousHash, reviewRef, approvalRef })) !== true) {
            throw new Error('Host denied publication for this candidate');
          }
          const currentHash = current.get(collectionId, skillId)?.candidate_hash ?? null;
          if (hash !== currentHash) {
            if (currentHash !== previousHash) throw new Error('Active workflow changed after review');
            const previous = currentHash && readCandidate(read.get(collectionId, skillId, currentHash));
            if (previous && previous.manifest.kind !== candidate.manifest.kind) throw new Error('Cannot replace a Skill with a different kind');
            insert.run(collectionId, skillId, hash, version, payload);
            update.run(collectionId, skillId, name, hash);
          }
          return hash;
        });
      },
      close() { db.close(); }
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
