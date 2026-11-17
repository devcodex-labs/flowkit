import { DatabaseSync } from 'node:sqlite';
import { verifiedCollectionPlan } from './collections.mjs';
import { checkProfessionalSkill } from './professional-skills.mjs';
import { checkCandidate } from './standard-artifact.mjs';

function checkPublishedSkill(candidate) {
  if (candidate.manifest.kind === 'professional') checkProfessionalSkill(candidate);
  else checkCandidate(candidate);
}

/** A Host-owned local store. Consumers read a complete version through one database snapshot. */
export function openLocalSkillStore(file, authorizePublication, authorizeCollectionChange) {
  if (typeof authorizePublication !== 'function') throw new TypeError('Host publication verifier is required');
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `);
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw new Error('Use a file-backed Skill store with WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS fk_author_collections (
        collection_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fk_author_versions (
        collection_id TEXT NOT NULL, skill_id TEXT NOT NULL, candidate_hash TEXT NOT NULL,
        version TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (collection_id, skill_id, candidate_hash), UNIQUE (collection_id, skill_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fk_author_active (
        collection_id TEXT NOT NULL, skill_id TEXT NOT NULL, name TEXT NOT NULL, candidate_hash TEXT NOT NULL,
        PRIMARY KEY (collection_id, skill_id), UNIQUE (collection_id, name),
        FOREIGN KEY (collection_id, skill_id, candidate_hash) REFERENCES fk_author_versions (collection_id, skill_id, candidate_hash)
      ) STRICT;
    `);
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

    function writeTransaction(operation) {
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
      readCollectionMetadata(collectionId) {
        const collection=db.prepare('SELECT payload FROM fk_author_collections WHERE collection_id=?').get(collectionId);
        if(!collection)return null;
        const skills=db.prepare(`SELECT active.collection_id,active.skill_id,active.name,active.candidate_hash,
          versions.version,json_extract(versions.payload,'$.manifest.kind') AS kind
          FROM fk_author_active AS active JOIN fk_author_versions AS versions USING(collection_id,skill_id,candidate_hash)
          WHERE active.collection_id=? ORDER BY active.name`).all(collectionId).map(row=>({hash:row.candidate_hash,
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
