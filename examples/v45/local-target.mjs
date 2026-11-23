import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {canonicalBytes, sha256Bytes} from '../../src/interactive/canonical.mjs';

const exec = promisify(execFile);
export const flowKitRoot = fileURLToPath(new URL('../../', import.meta.url));
const baseline = 'export const normalize = (/** @type {string} */ value) => value.toLowerCase();\n';
export const change = 'accept surrounding whitespace when normalizing a label';
const updated = baseline.replace('value.toLowerCase()', 'value.trim().toLowerCase()');
export const acceptance = [['READY','ready'],[' Ready ','ready'],['\t Mixed Case \n','mixed case']];
const app = 'normalize.mjs';
const now = () => Date.now();

export async function createLocalTarget(root, namespace, {rejectRestore=false}={}) {
  const source = path.join(root, 'source');
  const work = path.join(root, 'worktree');
  const evidence = path.join(root, 'evidence');
  const candidate = path.join(root, 'candidate.mjs');
  const stable = path.join(root, 'stable.mjs');
  const releaseDb = path.join(root, 'target.sqlite');
  const auditPath = path.join(root, 'delivery.json');
  await mkdir(source);
  await mkdir(evidence);
  const lock = JSON.parse(await readFile(path.join(flowKitRoot,'package-lock.json'),'utf8'));
  const gitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  const emptyGitConfig=path.join(evidence,'git-config');
  await writeFile(emptyGitConfig,'');
  gitEnvironment.GIT_CONFIG_GLOBAL=emptyGitConfig;
  gitEnvironment.GIT_CONFIG_NOSYSTEM='1';
  async function run(id, command, args, cwd=root, env=process.env) {
    const result = await exec(command, args, {cwd, env, windowsHide:true, timeout:95000, maxBuffer:8*1024*1024})
      .then(io=>({...io,exitCode:0}),error=>{
        if (!Number.isInteger(error.code)||error.signal) throw error;
        return {exitCode:error.code, stdout:error.stdout, stderr:error.stderr};
      });
    await writeFile(path.join(evidence,id+'.log'),result.stdout+'\n'+result.stderr);
    return result;
  }
  const git = (id,args,cwd=source) => run(id,'git',args,cwd,gitEnvironment);
  const execute = (id,args,cwd=work) => run(id,process.execPath,args,cwd);
  async function hashFile(file) { return sha256Bytes(await readFile(file)); }
  async function checked(result) { assert.equal(result.exitCode,0,result.stderr);return result.stdout.trim(); }
  async function writeJson(file,value) { await writeFile(file,canonicalBytes(value));return hashFile(file); }
  await writeFile(path.join(source,app),baseline);
  await writeFile(stable,baseline);
  await writeJson(path.join(source,'package.json'),{name:'flowkit-v45-isolated-target',private:true,type:'module'});
  await writeFile(path.join(source,'unit.test.mjs'),`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {normalize} from './${app}';\nfor (const [input,expected] of ${JSON.stringify(acceptance)}) test(JSON.stringify(input),()=>assert.equal(normalize(input),expected));\n`);
  await writeFile(path.join(source,'service.test.mjs'),`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {normalize} from './${app}';\nconst serve=request=>({value:normalize(JSON.parse(request).value)});\ntest('JSON request through exported service boundary',()=>assert.deepEqual(serve('{"value":" Ready "}'),{value:'ready'}));\n`);
  await checked(await git('init',['init','--quiet']));
  await checked(await git('line-endings',['config','--local','core.autocrlf','false']));
  await checked(await git('index',['add','--all']));
  await checked(await git('commit-baseline',['-c','user.name=FlowKit reference','-c','user.email=flowkit@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath=.git/no-hooks','commit','-qm','Isolated baseline']));
  const previousRelease = await hashFile(stable);
  const database = new DatabaseSync(releaseDb);
  database.exec(`CREATE TABLE target (id TEXT PRIMARY KEY, previous_hash TEXT NOT NULL, current_hash TEXT NOT NULL,
    candidate_hash TEXT, staging_hash TEXT, canary_hash TEXT, traffic INTEGER NOT NULL, lease_until INTEGER NOT NULL);
    CREATE TABLE mutations (operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL, evidence TEXT NOT NULL);
    CREATE TABLE fixture_data (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    INSERT INTO fixture_data VALUES (1, ' Ready ');`);
  database.prepare('INSERT INTO target VALUES (?,?,?,?,?,?,?,?)').run(namespace,previousRelease,previousRelease,null,null,null,0,now()+30*60*1000);
  if (rejectRestore) database.exec(`CREATE TRIGGER reject_restore BEFORE UPDATE OF traffic ON target
    WHEN OLD.traffic>0 AND NEW.traffic=0 BEGIN SELECT RAISE(ABORT,'Reference restore rejected'); END;`);
  database.close();

  function useTarget(callback) {
    const db = new DatabaseSync(releaseDb);
    try { return callback(db); } finally { db.close(); }
  }
  const getTarget = db => ({...db.prepare('SELECT * FROM target WHERE id=?').get(namespace)});
  const current = () => useTarget(getTarget);
  // A replay can only retrieve the exact same mutation. Compare-and-write occurs under the lease.
  function mutate(operationKey, kind, update) {
    return useTarget(db=>{
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db.prepare('SELECT kind, evidence FROM mutations WHERE operation_key=?').get(operationKey);
        if (existing) {assert.equal(existing.kind,kind);db.exec('COMMIT');return JSON.parse(existing.evidence);}
        const before = getTarget(db);
        assert.ok(before.lease_until>now(),'Target lease expired');
        update(db,before);
        const result={before,after:getTarget(db)};
        db.prepare('INSERT INTO mutations VALUES (?,?,?)').run(operationKey,kind,JSON.stringify(result));
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK');throw error; }
    });
  }
  async function smoke(id, file, cases=acceptance) {
    const sample=`import {pathToFileURL} from 'node:url';const {normalize}=await import(pathToFileURL(process.argv[1]).href);const pairs=JSON.parse(process.argv[2]);process.stdout.write(JSON.stringify(pairs.map(([i,e])=>({input:i,expected:e,actual:normalize(i)}))));`;
    const result=await execute(id,['--input-type=module','-e',sample,file,JSON.stringify(cases)],root);
    const values=JSON.parse(await checked(result));
    return {bytes:await hashFile(file),matches:values.filter(item=>item.actual===item.expected).length,total:values.length,values};
  }
  return {root,source,work,evidence,candidate,stable,auditPath,previousRelease,app,lock,git,execute,checked,hashFile,writeJson,
    current,mutate,smoke,
    record(){return useTarget(db=>db.prepare('SELECT operation_key,kind,evidence FROM mutations ORDER BY rowid').all());},
    inspectMigration(){return useTarget(db=>({rows:db.prepare('SELECT * FROM fixture_data ORDER BY id').all(),
      table:!!db.prepare("SELECT name FROM sqlite_master WHERE name='normalization_receipts'").get()}));},
    baselineSource:baseline,
    expectedSource:updated,
  };
}
