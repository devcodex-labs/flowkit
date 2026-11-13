import {DatabaseSync} from 'node:sqlite';
import {Buffer} from 'node:buffer';
import {closeSync,openSync} from 'node:fs';
import {
  MAX_CHECKPOINT_BYTES, MAX_ACTIVE_CHECKPOINT_BYTES, MAX_JOURNAL_BYTES, assertSHA256,
  canonicalBytes, decodeCanonical, safeJSONSnapshot, sha256Bytes,
} from './canonical.mjs';

import {checkpointPolicy,decodeCheckpoint,encodeCheckpoint} from './checkpoint.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'errored', 'cancelled']);
const STATUSES = new Set(['running', 'waiting', 'paused', ...TERMINAL]);
export const sqliteAdminTerminate=Symbol('SQLite admin terminate');
export const sqliteHostTrust=Symbol('SQLite Host trust');
const digest=value=>sha256Bytes(canonicalBytes(value));
function boundedCheckpointBytes(input) {
  try { return canonicalBytes(input); }
  catch (error) {
    if (error instanceof RangeError && /Canonical JSON exceeds maximum bytes/.test(error.message)) {
      throw failure('FK_I_CHECKPOINT_CAPACITY', 'Checkpoint exceeds 2 MiB hard limit');
    }
    throw error;
  }
}
function boundedCheckpoint(input) {
  return JSON.parse(boundedCheckpointBytes(input).toString('utf8'));
}

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
  if (digest(previous.program)!==digest(next.program) || digest(previous.policyIdentity)!==digest(next.policyIdentity)) {
    throw failure('FK_I_INVALID_CHECKPOINT','Program and policy identity are immutable');
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
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if (version!==3) {
      if (version!==0 || db.prepare("SELECT 1 FROM sqlite_schema WHERE name='fk_i_runs'").get()) {
        throw failure('FK_I_STORE_SCHEMA','initialize a new R5 SQLite store');
      }
      db.exec([
      'BEGIN IMMEDIATE;',
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
      'CREATE TABLE IF NOT EXISTS fk_i_receipt_index (',
      ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL,',
      ' node_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt >= 1),',
      ' digest TEXT NOT NULL, accepted_revision INTEGER NOT NULL CHECK(accepted_revision >= 1),',
      ' entry_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, run_id, request_id),',
      ' UNIQUE (namespace, run_id, accepted_revision),',
      ' FOREIGN KEY (namespace, run_id) REFERENCES fk_i_runs(namespace, run_id)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_journal (',
      ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,',
      ' transition_id TEXT NOT NULL, previous_hash TEXT, checkpoint_hash TEXT NOT NULL,',
      ' entry_json TEXT NOT NULL, entry_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, run_id, revision), UNIQUE (namespace, run_id, transition_id),',
      ' FOREIGN KEY (namespace, run_id) REFERENCES fk_i_runs(namespace, run_id)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_admin_events (',
      ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, transition_id TEXT NOT NULL,',
      ' admin_subject_id TEXT NOT NULL, reason_code TEXT NOT NULL, created_at TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, run_id, transition_id),',
      ' FOREIGN KEY (namespace, run_id, transition_id) REFERENCES fk_i_journal(namespace, run_id, transition_id)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_host_policy_keys (',
      ' namespace TEXT NOT NULL, policy_hash TEXT NOT NULL, key_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, policy_hash, key_hash)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_revoked_keys (',
      ' namespace TEXT NOT NULL, key_hash TEXT NOT NULL, revoked_at TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, key_hash)',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS fk_i_draining_policies (',
      ' namespace TEXT NOT NULL, policy_hash TEXT NOT NULL,',
      ' PRIMARY KEY (namespace, policy_hash)',
      ') STRICT;',
      'PRAGMA user_version = 3; COMMIT;',
      ].join('\n'));
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const read = db.prepare('SELECT * FROM fk_i_runs WHERE namespace = ? AND run_id = ?');
  const byStartKey = db.prepare('SELECT * FROM fk_i_runs WHERE namespace = ? AND start_key = ?');
  const latest = db.prepare('SELECT revision, transition_id, checkpoint_hash, entry_hash FROM fk_i_journal WHERE namespace = ? AND run_id = ? ORDER BY revision DESC LIMIT 1');
  const allEntries = db.prepare('SELECT * FROM fk_i_journal WHERE namespace = ? AND run_id = ? ORDER BY revision');
  const artifact = db.prepare('SELECT * FROM fk_i_artifacts WHERE namespace = ? AND artifact_hash = ?');
  const putArtifact = db.prepare('INSERT OR IGNORE INTO fk_i_artifacts(namespace, artifact_hash, source_hash, identity_json, program_bytes) VALUES (?, ?, ?, ?, ?)');
  const insertRun = db.prepare('INSERT INTO fk_i_runs(namespace, run_id, start_key, start_intent_hash, revision, artifact_hash, checkpoint_json, checkpoint_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updateRun = db.prepare('UPDATE fk_i_runs SET revision = ?, checkpoint_json = ?, checkpoint_hash = ? WHERE namespace = ? AND run_id = ? AND revision = ?');
  const insertJournal = db.prepare('INSERT INTO fk_i_journal(namespace, run_id, revision, transition_id, previous_hash, checkpoint_hash, entry_json, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const readReceipt = db.prepare('SELECT * FROM fk_i_receipt_index WHERE namespace = ? AND run_id = ? AND request_id = ?');
  const insertReceipt = db.prepare('INSERT OR IGNORE INTO fk_i_receipt_index(namespace, run_id, request_id, node_id, attempt, digest, accepted_revision, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const journalAtRevision = db.prepare('SELECT * FROM fk_i_journal WHERE namespace = ? AND run_id = ? AND revision = ?');
  const journalById = db.prepare('SELECT * FROM fk_i_journal WHERE namespace = ? AND run_id = ? AND transition_id = ?');
  const addAdminEvent=db.prepare(`INSERT INTO fk_i_admin_events
    (namespace,run_id,transition_id,admin_subject_id,reason_code,created_at) VALUES (?,?,?,?,?,?)`);
  const registerKey=db.prepare('INSERT OR IGNORE INTO fk_i_host_policy_keys VALUES (?,?,?)');
  const revokeKey=db.prepare('INSERT OR IGNORE INTO fk_i_revoked_keys VALUES (?,?,?)');
  const revokedPolicy=db.prepare(`SELECT 1 FROM fk_i_host_policy_keys AS p JOIN fk_i_revoked_keys AS r
    USING (namespace,key_hash) WHERE p.namespace=? AND p.policy_hash=? LIMIT 1`);
  const registeredKey=db.prepare('SELECT 1 FROM fk_i_host_policy_keys WHERE namespace=? AND policy_hash=? AND key_hash=?');
  const setDraining=db.prepare('INSERT OR IGNORE INTO fk_i_draining_policies VALUES (?,?)');
  const isDraining=db.prepare('SELECT 1 FROM fk_i_draining_policies WHERE namespace=? AND policy_hash=?');

  function assertActive(policyHash) {
    if (revokedPolicy.get(namespace,policyHash)) throw failure('FK_I_HOST_DENIED','Host policy has been revoked');
  }
  function assertStartAllowed(policyHash) {
    assertActive(policyHash);
    if (isDraining.get(namespace,policyHash)) throw failure('FK_I_HOST_DENIED','Host policy only drains existing Runs');
  }

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
    const cp = decodeCheckpoint(decodeCanonical(row.checkpoint_json, row.checkpoint_hash, MAX_CHECKPOINT_BYTES));
    assertCheckpoint(cp, namespace, row.run_id, row.revision, row.artifact_hash);
    if (cp.startKey !== row.start_key || cp.startIntentHash !== row.start_intent_hash) {
      throw failure('FK_I_STORE_CORRUPT', 'run identity differs from checkpoint');
    }
    const tail = latest.get(namespace, row.run_id);
    if (!tail || tail.revision !== row.revision || tail.checkpoint_hash !== row.checkpoint_hash
      || cp.lastTransitionId!==(tail.transition_id.startsWith('sha256:')?tail.transition_id:digest(['store-cas',tail.transition_id]))) {
      throw failure('FK_I_STORE_CORRUPT', 'journal does not match latest checkpoint');
    }
    return cp;
  }
  function receiptProof(runId, record) {
    const journalRow = journalAtRevision.get(namespace, runId, record.acceptedRevision);
    if (!journalRow || journalRow.entry_hash !== record.entryHash) {
      throw failure('FK_I_STORE_CORRUPT', 'receipt index has no matching journal revision');
    }
    const detail = decodeCanonical(journalRow.entry_json,
      sha256Bytes(Buffer.from(journalRow.entry_json, 'utf8')), MAX_JOURNAL_BYTES);
    if (journalRow.entry_hash !== journalDigest(namespace, runId, record.acceptedRevision,
      journalRow.transition_id, journalRow.previous_hash, journalRow.checkpoint_hash, detail)
      || detail.kind !== 'receipt-accepted'
      || detail.nodeId !== record.nodeId || detail.attempt !== record.attempt
      || detail.requestId !== record.requestId || detail.digest !== record.digest) {
      throw failure('FK_I_STORE_CORRUPT', 'receipt index differs from immutable journal');
    }
  }
  function putReceiptIndex(runId, record, entryHash) {
    identifier(record.requestId, 'receipt.requestId');
    identifier(record.nodeId, 'receipt.nodeId');
    if (!Number.isSafeInteger(record.attempt) || record.attempt < 1
      || !Number.isSafeInteger(record.acceptedRevision) || record.acceptedRevision < 1) {
      throw failure('FK_I_STORE_CORRUPT', 'invalid receipt index identity');
    }
    assertSHA256(record.digest);
    assertSHA256(entryHash);
    insertReceipt.run(namespace, runId, record.requestId, record.nodeId, record.attempt,
      record.digest, record.acceptedRevision, entryHash);
    const saved = readReceipt.get(namespace, runId, record.requestId);
    if (!saved || saved.node_id !== record.nodeId || saved.attempt !== record.attempt
      || saved.digest !== record.digest || saved.accepted_revision !== record.acceptedRevision
      || saved.entry_hash !== entryHash) {
      throw failure('FK_I_RECEIPT_CONFLICT', 'accepted request identity changed');
    }
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
    [sqliteHostTrust]:Object.freeze({
      register(policyHash,keys,drainOnly) {
        transaction('write',()=>{
          for (const key of keys) registerKey.run(namespace,policyHash,key);
          if (drainOnly) setDraining.run(namespace,policyHash);
        });
      },
      assertActive,
      assertStartAllowed,
      sign(policyHash,keyHash,sign) {
        return transaction('write',()=>{
          assertActive(policyHash);
          if (!registeredKey.get(namespace,policyHash,keyHash)) {
            throw failure('FK_I_HOST_DENIED','signing key is outside the Run policy');
          }
          return sign();
        });
      },
      revoke(keyHash) {
        assertSHA256(keyHash);
        return transaction('write',()=>revokeKey.run(namespace,keyHash,new Date().toISOString()).changes===1);
      },
    }),
    [sqliteAdminTerminate](runId,reason,subjectId) {
      identifier(runId,'runId');
      identifier(subjectId,'subjectId');
      return transaction('write',()=>{
        const current=decodeRow(read.get(namespace,runId));
        if (!current) throw failure('FK_I_HOST_DENIED','Run is not accessible');
        if (TERMINAL.has(current.status)) return current;
        if (current.revision>=Number.MAX_SAFE_INTEGER) throw failure('FK_I_REVISION_EXHAUSTED','revision range exceeded');
        const next={...current,status:'cancelled',revision:current.revision+1,
          pending:null,prepared:null,candidate:null,receivedSubmission:null,terminal:null,pauseReason:null};
        const eventDigest=digest({kind:'admin-terminate',subjectId,reason});
        const proposalDigest=digest({kind:'admin-tombstone',status:'cancelled'});
        const transitionId=digest([namespace,runId,current.revision,current.blockId,eventDigest,current.artifactHash,proposalDigest]);
        const committedAt=new Date().toISOString();
        const transition={namespace,runId,transitionId,fromRevision:current.revision,toRevision:next.revision,
          fromBlockId:current.blockId,toBlockId:null,programHash:current.artifactHash,eventDigest,proposalDigest,committedAt};
        next.lastTransitionId=transitionId;
        const bytes=boundedCheckpointBytes(encodeCheckpoint(next)), checkpointHash=sha256Bytes(bytes);
        const previous=latest.get(namespace,runId);
        if (updateRun.run(next.revision,bytes.toString('utf8'),checkpointHash,namespace,runId,current.revision).changes!==1) {
          throw failure('FK_I_CAS_CONFLICT','revision changed during admin transaction');
        }
        appendJournal(runId,next.revision,transitionId,checkpointHash,previous.entry_hash,{kind:'admin-terminate',transition});
        addAdminEvent.run(namespace,runId,transitionId,subjectId,reason,committedAt);
        return next;
      });
    },

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
    createRun({startKey, startIntent = null, checkpoint, genesis}) {
      identifier(startKey, 'startKey');
      const base = boundedCheckpoint(checkpoint);
      identifier(base?.runId, 'checkpoint.runId');
      assertCheckpoint(base, namespace, base.runId, 0);
      if (base.status==='cancelled') throw failure('FK_I_INVALID_TRANSITION','cancelled requires management authorization');
      if (base.startKey !== undefined || base.startIntentHash !== undefined) {
        throw failure('FK_I_INVALID_CHECKPOINT', 'start identity is store-generated');
      }
      const intent = safeJSONSnapshot(startIntent);
      const startIntentHash = sha256Bytes(boundedCheckpointBytes({
        namespace, startKey, artifactHash:base.artifactHash, state:base.state,
        policyHash:base.policyHash ?? null, intent,
      }));
      return transaction('write', () => {
        assertStartAllowed(base.policyHash??digest({}));
        const registered=artifact.get(namespace,base.artifactHash);
        if (!registered) throw failure('FK_I_PROGRAM_MISMATCH','Program bytes must be registered first');
        const program=JSON.parse(registered.identity_json);
        if (base.program && digest(base.program)!==digest(program)) throw failure('FK_I_PROGRAM_MISMATCH','Program identity mismatch');
        const initial={...base,startKey,startIntentHash,program,activationSeq:base.activationSeq??0,
          policyHash:base.policyHash??digest({}),policyIdentity:base.policyIdentity??checkpointPolicy({},base.policyHash??digest({})),
          receivedSubmission:null,stageCount:0,receiptCount:0};
        const eventDigest=digest(['genesis',startIntentHash]);
        const proposalDigest=digest(['create',initial.blockId]);
        const transitionId=digest([namespace,initial.runId,null,null,eventDigest,initial.artifactHash,proposalDigest]);
        if (genesis && genesis.transitionId!==transitionId) throw failure('FK_I_INVALID_TRANSITION','invalid genesis');
        const transition=genesis??{namespace,runId:initial.runId,programHash:initial.artifactHash,
          fromRevision:null,toRevision:0,fromBlockId:null,toBlockId:initial.blockId,eventDigest,proposalDigest,
          transitionId,committedAt:new Date().toISOString()};
        initial.lastTransitionId=transitionId;
        const checkpointBytes=boundedCheckpointBytes(encodeCheckpoint(initial));
        const checkpointHash=sha256Bytes(checkpointBytes);
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
        if (checkpointBytes.byteLength > MAX_ACTIVE_CHECKPOINT_BYTES) {
          throw failure('FK_I_CHECKPOINT_CAPACITY', 'initial Run would leave no error reserve');
        }
        insertRun.run(namespace, initial.runId, startKey, startIntentHash, 0,
          initial.artifactHash, checkpointBytes.toString('utf8'), checkpointHash);
        appendJournal(initial.runId,0,transitionId,checkpointHash,null,{kind:'created',transition});
        return {created:true,checkpoint:decodeCheckpoint(JSON.parse(checkpointBytes.toString('utf8')))};
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
      const next = boundedCheckpoint(nextCheckpoint);
      if (next.status==='cancelled') throw failure('FK_I_INVALID_TRANSITION','cancelled requires management authorization');
      const journal = safeJSONSnapshot(journalEntry, MAX_JOURNAL_BYTES);
      return transaction('write', () => {
        const row = read.get(namespace, runId);
        if (!row) throw failure('FK_I_RUN_NOT_FOUND', 'run is not accessible in this namespace');
        const current = decodeRow(row);
        assertActive(current.policyHash);
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
        next.lastTransitionId=transitionId.startsWith('sha256:') ? transitionId : digest(['store-cas',transitionId]);
        const persisted=encodeCheckpoint(next);
        const bytes=boundedCheckpointBytes(persisted);
        const checkpoint=decodeCheckpoint(persisted);
        if (!TERMINAL.has(next.status) && bytes.byteLength > MAX_ACTIVE_CHECKPOINT_BYTES) {
          throw failure('FK_I_CHECKPOINT_CAPACITY', 'nonterminal Checkpoint reserve exhausted');
        }
        const checkpointHash = sha256Bytes(bytes);
        const last = latest.get(namespace, runId);
        if (!last) throw failure('FK_I_STORE_CORRUPT', 'missing journal head');
        const updated = updateRun.run(next.revision, bytes.toString('utf8'), checkpointHash,
          namespace, runId, expectedRevision);
        if (updated.changes !== 1) throw failure('FK_I_CAS_CONFLICT', 'revision changed during transaction');
        const entryHash = appendJournal(runId, next.revision, transitionId, checkpointHash,
          last.entry_hash, journal);
        if (journal?.kind === 'receipt-accepted') {
          if (current.status !== 'waiting' || next.phase !== 'validate'
            || next.candidate?.requestId !== journal.requestId
            || next.candidate?.nodeId !== journal.nodeId
            || next.candidate?.attempt !== journal.attempt
            || next.receivedSubmission?.canonicalDigest!==journal.digest
            || current.pending?.requestId!==journal.requestId
            || current.pending.nodeId!==journal.nodeId || current.pending.attempt!==journal.attempt
            || next.receiptCount!==current.receiptCount+1) {
            throw failure('FK_I_INVALID_RECEIPT', 'receipt transition does not match the Pending');
          }
          putReceiptIndex(runId, {
            requestId:journal.requestId,nodeId:journal.nodeId,attempt:journal.attempt,
            digest:journal.digest,acceptedRevision:next.revision,
          },entryHash);
        } else if (next.receiptCount!==current.receiptCount || (current.status==='waiting' && next.phase==='validate')) {
          throw failure('FK_I_INVALID_RECEIPT','receipt acceptance requires the durable index entry');
        }
        return {committed:true,checkpoint};
      });
    },

    /** Immutable, namespaced accepted-receipt lookup without growing CP. */
    getReceipt(runId, requestId) {
      identifier(runId, 'runId');
      identifier(requestId, 'requestId');
      return transaction('read', () => {
        const run = read.get(namespace, runId);
        if (!run) return null;
        decodeRow(run);
        const record = readReceipt.get(namespace, runId, requestId);
        const indexed = record ? {
          requestId:record.request_id,nodeId:record.node_id,attempt:record.attempt,
          digest:record.digest,acceptedRevision:record.accepted_revision,
          entryHash:record.entry_hash,
        } : null;
        if (indexed) {
          receiptProof(runId, indexed);
          return {
            requestId:indexed.requestId,nodeId:indexed.nodeId,attempt:indexed.attempt,
            digest:indexed.digest,acceptedRevision:indexed.acceptedRevision,
          };
        }
        return null;
      });
    },

    /** Indexed read used by the async Store facade. Old records keep their original IDs. */
    readJournalRecord(runId, {transitionId,revision}) {
      identifier(runId, 'runId');
      if (transitionId!==undefined) identifier(transitionId,'transitionId');
      return transaction('read',()=>{
        const cp=decodeRow(read.get(namespace,runId));
        if (!cp) return null;
        const row=transitionId===undefined ? journalAtRevision.get(namespace,runId,revision)
          : journalById.get(namespace,runId,transitionId);
        if (!row) return null;
        const entry=JSON.parse(row.entry_json);
        if (journalDigest(namespace,runId,row.revision,row.transition_id,row.previous_hash,row.checkpoint_hash,entry)
          !==row.entry_hash) throw failure('FK_I_STORE_CORRUPT','invalid journal record');
        return {revision:row.revision,transitionId:row.transition_id,entry};
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
