import {assertSHA256,canonicalBytes,sha256Bytes} from './canonical.mjs';
import {publishedInteractivePending} from './protocol.mjs';

export const artifactTables=[
  'CREATE TABLE fk_i_business_artifact (',
  ' ordinal INTEGER PRIMARY KEY, namespace TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,',
  ' node_id TEXT NOT NULL, request_id TEXT NOT NULL, metadata TEXT NOT NULL,',
  ' UNIQUE(namespace,run_id,version_id), FOREIGN KEY(namespace,run_id) REFERENCES fk_i_runs(namespace,run_id)',
  ') STRICT;',
  'CREATE INDEX fk_i_business_artifact_latest ON fk_i_business_artifact(namespace,run_id,artifact_id,ordinal);',
  'CREATE TABLE fk_i_review_bundle (',
  ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, bundle_hash TEXT NOT NULL,',
  ' snapshot TEXT NOT NULL, expires_at INTEGER NOT NULL, approval TEXT,',
  ' PRIMARY KEY(namespace,run_id,request_id), FOREIGN KEY(namespace,run_id) REFERENCES fk_i_runs(namespace,run_id)',
  ') STRICT;',
  'CREATE TABLE fk_i_artifact_effective (',
  ' namespace TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,',
  ' PRIMARY KEY(namespace,run_id,artifact_id), FOREIGN KEY(namespace,run_id,version_id)',
  ' REFERENCES fk_i_business_artifact(namespace,run_id,version_id)',
  ') STRICT;',
];

const hash=value=>sha256Bytes(canonicalBytes(value));
const fail=(code,message)=>Object.assign(new Error(code+': '+message),{code});
const validText=(value,limit)=>typeof value==='string'&&value.length>0&&value.length<=limit&&!/[\u0000-\u001f\u007f]/.test(value);

export function prepareArtifactLedger(db,{namespace,transaction,load,receipt,assertActive}) {
  const version=db.prepare('SELECT * FROM fk_i_business_artifact WHERE namespace=? AND run_id=? AND version_id=?');
  const latest=db.prepare('SELECT version_id FROM fk_i_business_artifact WHERE namespace=? AND run_id=? AND artifact_id=? ORDER BY ordinal DESC LIMIT 1');
  const add=db.prepare('INSERT INTO fk_i_business_artifact(namespace,run_id,artifact_id,version_id,node_id,request_id,metadata) VALUES (?,?,?,?,?,?,?)');
  const bind=db.prepare('INSERT INTO fk_i_review_bundle(namespace,run_id,request_id,bundle_hash,snapshot,expires_at) VALUES (?,?,?,?,?,?)');
  const read=db.prepare('SELECT * FROM fk_i_review_bundle WHERE namespace=? AND run_id=? AND request_id=?');
  const replace=db.prepare(`UPDATE fk_i_review_bundle SET bundle_hash=?,snapshot=?,expires_at=?
    WHERE namespace=? AND run_id=? AND request_id=? AND bundle_hash=? AND approval IS NULL`);
  const decide=db.prepare('UPDATE fk_i_review_bundle SET approval=? WHERE namespace=? AND run_id=? AND request_id=? AND approval IS NULL');
  const record=db.prepare('INSERT INTO fk_i_artifact_effective VALUES (?,?,?,?) ON CONFLICT(namespace,run_id,artifact_id) DO UPDATE SET version_id=excluded.version_id');
  const list=db.prepare(`SELECT a.*, e.version_id AS effective_version_id FROM fk_i_business_artifact AS a
    LEFT JOIN fk_i_artifact_effective AS e USING(namespace,run_id,artifact_id)
    WHERE a.namespace=? AND a.run_id=? AND a.ordinal>? ORDER BY a.ordinal LIMIT 101`);
  const approvals=db.prepare(`SELECT DISTINCT json_extract(v.value,'$.versionId') AS version_id
    FROM fk_i_review_bundle AS b, json_each(b.snapshot,'$.versions') AS v
    WHERE b.namespace=? AND b.run_id=? AND json_extract(b.approval,'$.decision')='approve'`);
  function activeRun(runId) {
    const cp=load(runId);
    if(!cp) throw fail('FK_I_HOST_DENIED','Run is unavailable');
    assertActive(cp.policyHash);
    return cp;
  }
  function project(row) {
    const {artifact_id:artifactId,version_id:versionId,node_id:nodeId,request_id:requestId}=row;
    return {artifactId,versionId,nodeId,requestId,...JSON.parse(row.metadata)};
  }
  function checkVersions(runId,versions) {
    for(const item of versions) if(latest.get(namespace,runId,item.artifactId)?.version_id!==item.versionId) {
      throw fail('FK_I_STALE_RECEIPT','A bound artifact has a newer version');
    }
  }
  return Object.freeze({
    register({runId,requestId,artifactId,contentHash,mimeType,sizeBytes,storageRef,versionLabel}) {
      return transaction('write',()=>{
        activeRun(runId);
        const producing=receipt(runId,requestId);
        if(!producing) throw fail('FK_I_STALE_RECEIPT','An accepted producing task is required');
        assertSHA256(contentHash);
        if(!validText(artifactId,160)||!validText(mimeType,120)||!validText(storageRef,512)||!Number.isSafeInteger(sizeBytes)||sizeBytes<0) {
          throw fail('FK_I_INVALID_OPERATION','Invalid artifact version metadata');
        }
        if(versionLabel!==undefined&&!validText(versionLabel,80)) throw fail('FK_I_INVALID_OPERATION','Invalid artifact version label');
        const metadata={contentHash,mimeType,sizeBytes,storageRef,...(versionLabel===undefined?{}:{versionLabel})};
        const versionId=hash({namespace,runId,requestId,artifactId,...metadata});
        const existing=version.get(namespace,runId,versionId);
        if(existing) return project(existing);
        add.run(namespace,runId,artifactId,versionId,producing.node_id,requestId,JSON.stringify(metadata));
        return project(version.get(namespace,runId,versionId));
      });
    },
    freeze({runId,requestId,reviewDigest,versionIds,expiresAt,expectedBundleHash}) {
      return transaction('write',()=>{
        const cp=activeRun(runId);
        const task=publishedInteractivePending(cp).find(task=>task.kind==='human'&&task.requestId===requestId);
        if(task?.task.reviewDigest!==reviewDigest||typeof reviewDigest!=='string') throw fail('FK_I_STALE_RECEIPT','Current Human review is required');
        if(!Array.isArray(versionIds)||!versionIds.length||versionIds.length>64||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()) {
          throw fail('FK_I_INVALID_OPERATION','Invalid review bundle arguments');
        }
        const versions=versionIds.map(id=>{
          assertSHA256(id);
          const row=version.get(namespace,runId,id);
          if(!row) throw fail('FK_I_HOST_DENIED','A bundle version is unavailable');
          const {artifactId,versionId,contentHash}=project(row);
          return {artifactId,versionId,contentHash};
        }).sort((a,b)=>a.artifactId<b.artifactId?-1:a.artifactId>b.artifactId?1:0);
        if(new Set(versions.map(item=>item.artifactId)).size!==versions.length) throw fail('FK_I_INVALID_OPERATION','Review contains repeated artifacts');
        const snapshot={runId,requestId,reviewDigest,versions,expiresAt};
        const bundleHash=hash({namespace,...snapshot});
        checkVersions(runId,versions);
        const old=read.get(namespace,runId,requestId);
        if(old&&old.bundle_hash!==bundleHash) {
          const stale=old.expires_at<=Date.now() || JSON.parse(old.snapshot).versions.some(item=>
            latest.get(namespace,runId,item.artifactId)?.version_id!==item.versionId);
          if(!stale||old.bundle_hash!==expectedBundleHash || replace.run(bundleHash,JSON.stringify(snapshot),expiresAt,
            namespace,runId,requestId,expectedBundleHash).changes!==1) {
            throw fail('FK_I_OPERATION_CONFLICT','Human review is already bound to a different bundle');
          }
        } else if(!old) {
          if(expectedBundleHash!==undefined) throw fail('FK_I_OPERATION_CONFLICT','Expected review bundle does not exist');
          bind.run(namespace,runId,requestId,bundleHash,JSON.stringify(snapshot),expiresAt);
        }
        return {...snapshot,bundleHash};
      });
    },
    readBundle(runId,requestId) {
      return transaction('read',()=>{
        activeRun(runId);
        const row=read.get(namespace,runId,requestId);
        return row?{...JSON.parse(row.snapshot),bundleHash:row.bundle_hash,...(row.approval?{approval:JSON.parse(row.approval)}:{})}:null;
      });
    },
    commitReview(runId,requestId,proof,revision) {
      const bound=read.get(namespace,runId,requestId);
      if(!bound&&!proof.bundleHash) return;
      if(!bound||bound.approval||bound.bundle_hash!==proof.bundleHash||bound.expires_at<=Date.now()) {
        throw fail('FK_I_STALE_RECEIPT','Human receipt does not match a current review bundle');
      }
      const {versions}=JSON.parse(bound.snapshot);
      checkVersions(runId,versions);
      decide.run(JSON.stringify({revision,...proof}),namespace,runId,requestId);
      if(proof.decision==='approve') for(const item of versions) record.run(namespace,runId,item.artifactId,item.versionId);
    },
    readVersion(runId,artifactId,versionId) {
      return transaction('read',()=>{
        activeRun(runId);
        const row=version.get(namespace,runId,versionId);
        return row?.artifact_id===artifactId?project(row):null;
      });
    },
    list(runId,after=0) {
      return transaction('read',()=>{
        activeRun(runId);
        const rows=list.all(namespace,runId,after);
        const confirmed=new Set(approvals.all(namespace,runId).map(row=>row.version_id));
        return {items:rows.slice(0,100).map(row=>{
          const {storageRef:_storageRef,...metadata}=project(row);
          return {...metadata,latestVersionId:latest.get(namespace,runId,row.artifact_id)?.version_id,
            effectiveVersionId:row.effective_version_id??null,...(confirmed.has(row.version_id)?{confirmed:true}:{})};
        }),
        next:rows.length>100?rows[99].ordinal:null};
      });
    },
  });
}
