import {DatabaseSync} from 'node:sqlite';
import {Buffer} from 'node:buffer';
import {
  MAX_CHECKPOINT_BYTES, MAX_JOURNAL_BYTES, assertSHA256,
  canonicalBytes, decodeCanonical, safeJSONSnapshot, sha256Bytes,
} from './canonical.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'errored']);
const STATUSES = new Set(['running', 'waiting', 'paused', ...TERMINAL]);

function failure(code, detail) {
  return Object.assign(new Error(code + ': ' + detail), {code});
}
function identifier(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(name + ' must be a nonempty, bounded identifier');
  }
  return value;
}
function assertCheckpoint(value, namespace, runId, revision, artifactHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.namespace !== namespace
    || value.runId !== runId || value.revision !== revision
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw failure('FK_I_INVALID_CHECKPOINT', 'namespace/run/revision/schema mismatch');
  }
  assertSHA256(value.artifactHash);
  if (artifactHash !== undefined && value.artifactHash !== artifactHash) {
    throw failure('FK_I_PROGRAM_MISMATCH', 'run artifact is immutable');
  }
  if (!STATUSES.has(value.status)
    || typeof value.blockId !== 'string' || !value.blockId
    || typeof value.phase !== 'string' || !value.phase
    || !value.blockId.endsWith('::' + value.phase)
    || !value.state || typeof value.state !== 'object' || Array.isArray(value.state)
    || !Array.isArray(value.controlStack)) {
    throw failure('FK_I_INVALID_CHECKPOINT', 'incomplete state-machine checkpoint');
  }
  if (revision > 0) {
    identifier(value.startKey, 'checkpoint.startKey');
    assertSHA256(value.startIntentHash);
  }
}
function immutableIdentity(previous, next) {
  for (const key of ['namespace', 'runId', 'schemaVersion', 'artifactHash', 'startKey', 'startIntentHash', 'policyHash']) {
    if (previous[key] !== next[key]) {
      throw failure('FK_I_INVALID_CHECKPOINT', 'immutable field changed: ' + key);
    }
  }
}
function journalDigest(namespace, runId, revision, transitionId, previousHash, checkpointHash, entry) {
  return sha256Bytes(canonicalBytes({
    namespace, runId, revision, transitionId, previousHash, checkpointHash, entry,
  }, MAX_JOURNAL_BYTES));
}

/**
 * Host-owned, synchronous P0-A SQLite persistence. No model/skill calls here.
 * Each run is fully scoped to the constructor's namespace. Node's DatabaseSync
 * is experimental on Node 22; the CI matrix tests it as an explicit boundary.
 */
export function createSqliteCheckpointStore(file, {namespace} = {}) {
  identifier(file, 'SQLite file');
  identifier(namespace, 'namespace');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 15000');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    // Neither a storage driver nor an in-memory database may silently weaken durability.
    const journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
    const synchronous = db.prepare('PRAGMA synchronous').get()?.synchronous;
    const foreignKeys = db.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
    if (journalMode !== 'wal' || synchronous !== 2 || foreignKeys !== 1) {
      throw failure('FK_I_STORE_UNSAFE', 'WAL, synchronous FULL and foreign keys are required');
    }
    db.exec([
      'CREATE TABLE IF NOT EXISTS fk_i_artifacts (',
      ' namespace TEXT NOT NULL, artifact_hash TEXT NOT NULL, source_hash TEXT NOT NULL,',
      ' identity_json TEXT NOT NULL, program_bytes BLOB NOT NULL,',
      ' PRIMARY KEY (namespace, artifact_hash)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_runs (',
      ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, start_key TEXT NOT NULL,',
      ' start_intent_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),',
      ' artifact_hash TEXT NOT NULL, checkpoint_json TEXT NOT NULL, checkpoint_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, run_id), UNIQUE (namespace, start_key),',
      ' FOREIGN KEY (namespace, artifact_hash) REFERENCES fk_i_artifacts(namespace, artifact_hash)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_journal (',
      ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,',
      ' transition_id TEXT NOT NULL, previous_hash TEXT, checkpoint_hash TEXT NOT NULL,',
      ' entry_json TEXT NOT NULL, entry_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, run_id, revision), UNIQUE (namespace, run_id, transition_id),',
      ' FOREIGN KEY (namespace, run_id) REFERENCES fk_i_runs(namespace, run_id)',
      ') STRICT;',
    ].join('\n'));
  } catch (error) {
    db.close();
    throw error;
  }

  const read = db.prepare('SELECT * FROM fk_i_runs WHERE namespace = ? AND run_id = ?');
  const byStartKey = db.prepare('SELECT * FROM fk_i_runs WHERE namespace = ? AND start_key = ?');
  const latest = db.prepare('SELECT revision, checkpoint_hash, entry_hash FROM fk_i_journal WHERE namespace = ? AND run_id = ? ORDER BY revision DESC LIMIT 1');
  const allEntries = db.prepare('SELECT * FROM fk_i_journal WHERE namespace = ? AND run_id = ? ORDER BY revision');
  const artifact = db.prepare('SELECT * FROM fk_i_artifacts WHERE namespace = ? AND artifact_hash = ?');
  const putArtifact = db.prepare('INSERT OR IGNORE INTO fk_i_artifacts(namespace, artifact_hash, source_hash, identity_json, program_bytes) VALUES (?, ?, ?, ?, ?)');
  const insertRun = db.prepare('INSERT INTO fk_i_runs(namespace, run_id, start_key, start_intent_hash, revision, artifact_hash, checkpoint_json, checkpoint_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updateRun = db.prepare('UPDATE fk_i_runs SET revision = ?, checkpoint_json = ?, checkpoint_hash = ? WHERE namespace = ? AND run_id = ? AND revision = ?');
  const insertJournal = db.prepare('INSERT INTO fk_i_journal(namespace, run_id, revision, transition_id, previous_hash, checkpoint_hash, entry_json, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

  function transaction(mode, work) {
    db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function decodeRow(row) {
    if (!row) return null;
    const cp = decodeCanonical(row.checkpoint_json, row.checkpoint_hash, MAX_CHECKPOINT_BYTES);
    assertCheckpoint(cp, namespace, row.run_id, row.revision, row.artifact_hash);
    if (cp.startKey !== row.start_key || cp.startIntentHash !== row.start_intent_hash) {
      throw failure('FK_I_STORE_CORRUPT', 'run identity differs from checkpoint');
    }
    const tail = latest.get(namespace, row.run_id);
    if (!tail || tail.revision !== row.revision || tail.checkpoint_hash !== row.checkpoint_hash) {
      throw failure('FK_I_STORE_CORRUPT', 'journal does not match latest checkpoint');
    }
    return cp;
  }
  function appendJournal(runId, revision, transitionId, checkpointHash, previousHash, entry) {
    identifier(transitionId, 'transitionId');
    const detail = safeJSONSnapshot(entry, MAX_JOURNAL_BYTES);
    const json = canonicalBytes(detail, MAX_JOURNAL_BYTES).toString('utf8');
    const digest = journalDigest(namespace, runId, revision, transitionId, previousHash, checkpointHash, detail);
    insertJournal.run(namespace, runId, revision, transitionId, previousHash, checkpointHash, json, digest);
    return digest;
  }

  return Object.freeze({
    namespace,
    close() { db.close(); },

    /** Preserve exact compiler-produced bytes, keyed by their content hash. */
    putArtifact({programIdentity, bytes}) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Program bytes must be Uint8Array');
      if (bytes.byteLength > 4 * 1024 * 1024) {
        throw failure('FK_I_PROGRAM_MISMATCH', 'Program exceeds 4 MiB');
      }
      if (!programIdentity || typeof programIdentity !== 'object') throw new TypeError('Program identity required');
      const identity = safeJSONSnapshot(programIdentity);
      assertSHA256(identity.artifactHash);
      assertSHA256(identity.sourceHash);
      if (identity.programAbiVersion !== 1
        || identity.semanticsVersion !== 'interactive-state-machine-v1'
        || identity.implementedStage !== 'P0-A') {
        throw failure('FK_I_PROGRAM_MISMATCH', 'unsupported Program identity');
      }
      const copied = Buffer.from(bytes);
      if (copied.length > 4 * 1024 * 1024 || sha256Bytes(copied) !== identity.artifactHash) {
        throw failure('FK_I_PROGRAM_MISMATCH', 'Program bytes are not the declared artifact');
      }
      const identityJson = canonicalBytes(identity).toString('utf8');
      transaction('write', () => {
        putArtifact.run(namespace, identity.artifactHash, identity.sourceHash, identityJson, copied);
        const existing = artifact.get(namespace, identity.artifactHash);
        if (!existing || existing.identity_json !== identityJson || !Buffer.from(existing.program_bytes).equals(copied)) {
          throw failure('FK_I_PROGRAM_MISMATCH', 'artifact identity is immutable');
        }
      });
      return identity.artifactHash;
    },

    getArtifact(artifactHash) {
      assertSHA256(artifactHash);
      return transaction('read', () => {
        const record = artifact.get(namespace, artifactHash);
        if (!record) return null;
        if (record.program_bytes.byteLength > 4 * 1024 * 1024) {
          throw failure('FK_I_STORE_CORRUPT', 'artifact exceeds 4 MiB');
        }
        const copied = Buffer.from(record.program_bytes);
        if (sha256Bytes(copied) !== artifactHash) {
          throw failure('FK_I_STORE_CORRUPT', 'artifact bytes modified');
        }
        const identity = JSON.parse(record.identity_json);
        if (!canonicalBytes(identity).equals(Buffer.from(record.identity_json, 'utf8'))
          || identity.artifactHash !== artifactHash || identity.sourceHash !== record.source_hash) {
          throw failure('FK_I_STORE_CORRUPT', 'artifact metadata modified');
        }
        return {programIdentity: identity, bytes: copied};
      });
    },

    /** Deliberately refuses removal while any historical run references bytes. */
    deleteArtifact(artifactHash) {
      assertSHA256(artifactHash);
      return transaction('write', () => {
        const count = db.prepare('SELECT COUNT(*) AS n FROM fk_i_runs WHERE namespace = ? AND artifact_hash = ?').get(namespace, artifactHash).n;
        if (count !== 0) throw failure('FK_I_ARTIFACT_IN_USE', 'cannot delete referenced Program');
        return db.prepare('DELETE FROM fk_i_artifacts WHERE namespace = ? AND artifact_hash = ?').run(namespace, artifactHash).changes !== 0;
      });
    },

    /**
     * Durable idempotent start: the server computes the intent fingerprint,
     * including tenant, artifact, initial State and caller options.
     */
    createRun({startKey, startIntent = null, checkpoint}) {
      identifier(startKey, 'startKey');
      const base = safeJSONSnapshot(checkpoint);
      identifier(base?.runId, 'checkpoint.runId');
      assertCheckpoint(base, namespace, base.runId, 0);
      if (base.startKey !== undefined || base.startIntentHash !== undefined) {
        throw failure('FK_I_INVALID_CHECKPOINT', 'start identity is store-generated');
      }
      const intent = safeJSONSnapshot(startIntent);
      const startIntentHash = sha256Bytes(canonicalBytes({
        namespace, startKey, artifactHash:base.artifactHash, state:base.state,
        policyHash:base.policyHash ?? null, intent,
      }));
      const initial = {...base, startKey, startIntentHash};
      const checkpointBytes = canonicalBytes(initial);
      const checkpointHash = sha256Bytes(checkpointBytes);
      return transaction('write', () => {
        const existing = byStartKey.get(namespace, startKey);
        if (existing) {
          const current = decodeRow(existing);
          if (existing.start_intent_hash !== startIntentHash) {
            throw failure('FK_I_START_CONFLICT', 'startKey belongs to different intent');
          }
          return {created:false, checkpoint:current};
        }
        if (read.get(namespace, initial.runId)) {
          throw failure('FK_I_RUN_CONFLICT', 'runId already belongs to another start');
        }
        if (!artifact.get(namespace, initial.artifactHash)) {
          throw failure('FK_I_PROGRAM_MISMATCH', 'Program bytes must be registered first');
        }
        insertRun.run(namespace, initial.runId, startKey, startIntentHash, 0,
          initial.artifactHash, checkpointBytes.toString('utf8'), checkpointHash);
        appendJournal(initial.runId, 0, 'start:' + startIntentHash, checkpointHash, null, {kind:'created'});
        return {created:true, checkpoint:JSON.parse(checkpointBytes.toString('utf8'))};
      });
    },

    /** Linearizable checkpoint and journal-head read from one SQLite snapshot. */
    load(runId) {
      identifier(runId, 'runId');
      return transaction('read', () => decodeRow(read.get(namespace, runId)));
    },

    /** Atomic, per-phase optimistic CAS; all conflicts leave both tables unchanged. */
    compareAndSwap({runId, expectedRevision, nextCheckpoint, transitionId, journalEntry = null}) {
      identifier(runId, 'runId');
      identifier(transitionId, 'transitionId');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError('expectedRevision must be a nonnegative safe integer');
      }
      const next = safeJSONSnapshot(nextCheckpoint);
      const journal = safeJSONSnapshot(journalEntry, MAX_JOURNAL_BYTES);
      return transaction('write', () => {
        const row = read.get(namespace, runId);
        if (!row) throw failure('FK_I_RUN_NOT_FOUND', 'run is not accessible in this namespace');
        const current = decodeRow(row);
        if (row.revision !== expectedRevision) {
          return {committed:false, checkpoint:current};
        }
        if (TERMINAL.has(current.status)) {
          throw failure('FK_I_TERMINAL_IMMUTABLE', 'final checkpoint cannot advance');
        }
        if (row.revision >= Number.MAX_SAFE_INTEGER) {
          throw failure('FK_I_REVISION_EXHAUSTED', 'revision range exceeded');
        }
        assertCheckpoint(next, namespace, runId, expectedRevision + 1, row.artifact_hash);
        immutableIdentity(current, next);
        const bytes = canonicalBytes(next);
        const checkpointHash = sha256Bytes(bytes);
        const last = latest.get(namespace, runId);
        if (!last) throw failure('FK_I_STORE_CORRUPT', 'missing journal head');
        const updated = updateRun.run(next.revision, bytes.toString('utf8'), checkpointHash,
          namespace, runId, expectedRevision);
        if (updated.changes !== 1) throw failure('FK_I_CAS_CONFLICT', 'revision changed during transaction');
        appendJournal(runId, next.revision, transitionId, checkpointHash, last.entry_hash, journal);
        return {committed:true, checkpoint:JSON.parse(bytes.toString('utf8'))};
      });
    },

    /** Audit chain is verified on each read, independently of a live Coordinator. */
    listJournal(runId) {
      identifier(runId, 'runId');
      return transaction('read', () => {
        const row = read.get(namespace, runId);
        if (!row) return [];
        decodeRow(row);
        const result = [];
        let previousHash = null;
        let revision = 0;
        for (const entry of allEntries.all(namespace, runId)) {
          const detail = decodeCanonical(entry.entry_json, sha256Bytes(Buffer.from(entry.entry_json, 'utf8')), MAX_JOURNAL_BYTES);
          if (entry.revision !== revision++ || entry.previous_hash !== previousHash
            || entry.entry_hash !== journalDigest(namespace, runId, entry.revision,
              entry.transition_id, previousHash, entry.checkpoint_hash, detail)) {
            throw failure('FK_I_STORE_CORRUPT', 'invalid journal hash chain');
          }
          result.push({
            revision:entry.revision, transitionId:entry.transition_id,
            previousHash, entryHash:entry.entry_hash,
            checkpointHash:entry.checkpoint_hash, entry:detail,
          });
          previousHash = entry.entry_hash;
        }
        if (result.length !== row.revision + 1
          || result.at(-1)?.checkpointHash !== row.checkpoint_hash) {
          throw failure('FK_I_STORE_CORRUPT', 'journal is missing committed revisions');
        }
        return result;
      });
    },
  });
}
