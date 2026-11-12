import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createPrivateKey,generateKeyPairSync,sign,verify} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile,lstat,open,readFile,readdir,readlink,rename,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';

const [mode,root,hostPidArg]=process.argv.slice(2);
assert.ok(['host','model'].includes(mode) && path.isAbsolute(root));
const hostDir=path.join(root,'host-private');
const modelDir=path.join(root,'model-scratch');
const publicTask=path.join(root,'public','task.json');
const key=path.join(hostDir,'signing-key.pem');
const database=path.join(hostDir,'checkpoint.db');
const backup=path.join(hostDir,'backup.db');
const config=path.join(hostDir,'host-config.json');
const allowlist=path.join(hostDir,'program-allowlist.json');
const files=[key,config,allowlist,database,database+'-wal',database+'-shm',backup];
const canary='flowkit-disposable-host-fixture';

async function report(folder,name,value) {
  const destination=path.join(folder,name);
  await writeFile(destination+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(destination+'.tmp',destination);
}

async function identity() {
  if (process.platform==='linux') {
    const status=await readFile('/proc/self/status','utf8');
    const readField=(name)=>status.match(new RegExp('^'+name+':\\s*(.+)$','m'))?.[1].trim();
    const uid=process.getuid();
    const gid=process.getgid();
    const groups=process.getgroups();
    assert.notEqual(uid,0);
    assert.ok(groups.every(group=>group===gid), 'unexpected supplementary group');
    assert.equal(readField('NoNewPrivs'),'1');
    for (const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) {
      assert.match(readField(field),/^0+$/,field);
    }
    return {uid,gid,groups,status:status.split('\n').filter(line=>/^(Uid|Gid|Groups|Cap|NoNewPrivs):?/.test(line))};
  }
  assert.equal(process.platform,'win32');
  const whoami=path.join(process.env.SystemRoot,'System32','whoami.exe');
  const query=(...args)=>execFileSync(whoami,args,{encoding:'utf8',windowsHide:true,timeout:10000});
  const user=query('/user','/fo','csv','/nh').trim();
  const sid=user.match(/S-1-[\d-]+/)?.[0];
  const groups=query('/groups','/fo','csv','/nh');
  const privileges=query('/priv','/fo','csv','/nh');
  assert.match(sid,/^S-1-5-21-/);
  assert.doesNotMatch(groups,/S-1-5-32-544(?:["\s,]|$)/,'local administrator group present');
  assert.doesNotMatch(privileges,/Se(?:Debug|Tcb|Impersonate|AssignPrimaryToken|Backup|Restore|TakeOwnership)Privilege/i);
  return {sid,user,groups,privileges};
}

async function hashes() {
  return Object.fromEntries(await Promise.all(files.map(async file=>{
    const digest=createHash('sha256').update(await readFile(file)).digest('hex');
    return [path.basename(file),digest];
  })));
}

function verifyDatabase(filename) {
  const handle=new DatabaseSync(filename,{readOnly:true});
  try {
    assert.equal(handle.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(handle.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='fk_i_runs'").get().n,1);
  } finally {handle.close();}
}

async function runHost() {
  const actualIdentity=await identity();
  assert.equal(process.env.FLOWKIT_HOST_CANARY,canary);
  let windowsAccessPolicy;
  if (process.platform==='win32') {
    const probe=path.join(root,'public','process-access.exe');
    windowsAccessPolicy=JSON.parse(execFileSync(probe,['restrict',String(process.pid)],{
      encoding:'utf8',windowsHide:true,timeout:10000,
    }));
    assert.deepEqual(windowsAccessPolicy,{
      sid:actualIdentity.sid,processDaclApplied:true,tokenDaclApplied:true,
    });
  }
  const pair=generateKeyPairSync('ed25519');
  await writeFile(key,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  await writeFile(config,'{"fixture":true}\n',{mode:0o600});
  await writeFile(allowlist,'[]\n',{mode:0o600});
  const store=createSqliteCheckpointStore(database,{namespace:'disposable-profile'});
  try {
    const connection=new DatabaseSync(database);
    try {connection.prepare('VACUUM INTO ?').run(backup);}
    finally {connection.close();}
    const before=await hashes();
    const fileModes=Object.fromEntries(await Promise.all([hostDir,...files].map(async file=>{
      const s=await lstat(file);
      return [path.basename(file),{uid:s.uid,mode:(s.mode&0o777).toString(8)}];
    })));
    if (process.platform==='linux') {
      assert.equal(fileModes['host-private'].mode,'700');
      assert.equal(fileModes['signing-key.pem'].mode,'600');
      assert.ok(Object.values(fileModes).every(file=>file.uid===actualIdentity.uid));
    }
    await report(hostDir,'host-ready.json',{
      pid:process.pid,ppid:process.ppid,identity:actualIdentity,files:before,fileModes,windowsAccessPolicy,
    });
    const until=Date.now()+75000;
    while (true) {
      try {await lstat(path.join(hostDir,'stop')); break;}
      catch (error) {if (error.code!=='ENOENT') throw error;}
      assert.ok(Date.now()<until,'profile model run timed out');
      await delay(100);
    }
    assert.deepEqual(await hashes(),before,'protected fixture changed');
    const privateKey=createPrivateKey(await readFile(key));
    const message=Buffer.from(canary);
    assert.ok(verify(null,message,pair.publicKey,sign(null,message,privateKey)));
    assert.equal(store.load('not-created'),null);
  } finally {store.close();}
  verifyDatabase(database);
  verifyDatabase(backup);
  await report(hostDir,'host-result.json',{pid:process.pid,keyUsable:true,protectedBytesUnchanged:true,storeIntegrity:'ok',backupIntegrity:'ok'});
}

async function runModel() {
  const hostPid=Number(hostPidArg);
  assert.ok(Number.isSafeInteger(hostPid) && hostPid>1 && hostPid!==process.pid);
  const actualIdentity=await identity();
  assert.equal(process.env.FLOWKIT_HOST_CANARY,undefined);
  assert.equal(await readFile(publicTask,'utf8'),'flowkit-public-task\n');
  const checks=[];
  async function denied(resource,operation,callback) {
    try {await callback();}
    catch (error) {
      assert.ok(['EACCES','EPERM'].includes(error.code),resource+' '+operation+': '+error.code);
      checks.push({resource,operation,code:error.code});
      return;
    }
    assert.fail(resource+' '+operation+' was allowed');
  }
  await denied('host-private','list',()=>readdir(hostDir));
  const incoming=path.join(modelDir,'replacement');
  await writeFile(incoming,'disposable replacement',{mode:0o600});
  for (const file of files) {
    const resource=path.basename(file);
    await denied(resource,'read',()=>readFile(file));
    await denied(resource,'copy',()=>copyFile(file,path.join(modelDir,'copy'),constants.COPYFILE_EXCL));
    await denied(resource,'open-write',async()=>{const handle=await open(file,'r+'); await handle.close();});
    await denied(resource,'delete',()=>unlink(file));
    await denied(resource,'move',()=>rename(file,path.join(modelDir,'moved')));
    await denied(resource,'replace',()=>rename(incoming,file));
  }

  let processEvidence;
  if (process.platform==='linux') {
    const hostProc='/proc/'+hostPid;
    await denied('host-fd','list',()=>readdir(hostProc+'/fd'));
    await denied('host-env','read',()=>readFile(hostProc+'/environ'));
    await denied('host-memory','open-read',async()=>{const handle=await open(hostProc+'/mem','r'); await handle.close();});
    await denied('host-process','signal-permission',()=>process.kill(hostPid,0));
    const fds=[];
    for (const fd of await readdir('/proc/self/fd')) {
      try {fds.push({fd,target:await readlink('/proc/self/fd/'+fd)});}
      catch (error) {if (error.code!=='ENOENT') throw error;}
    }
    assert.ok(fds.every(fd=>!fd.target.startsWith(hostDir+'/')),'a Host fixture file descriptor is visible');
    processEvidence={fds};
  } else {
    await report(modelDir,'model-file-result.json',{pid:process.pid,identity:actualIdentity,publicTaskReadable:true,checks});
    const probe=path.join(root,'public','process-access.exe');
    processEvidence=JSON.parse(execFileSync(probe,[String(hostPid)],{
      encoding:'utf8',windowsHide:true,timeout:10000,
    }));
    assert.equal(processEvidence.length,6);
    assert.ok(processEvidence.every(result=>result.denied===true),JSON.stringify(processEvidence));
  }
  await report(modelDir,'model-result.json',{
    pid:process.pid,ppid:process.ppid,identity:actualIdentity,publicTaskReadable:true,checks,processEvidence,
  });
}

try {
  if (mode==='host') await runHost();
  else await runModel();
} catch (error) {
  await report(mode==='host'?hostDir:modelDir,mode+'-error.json',{
    pid:process.pid,code:error.code,message:error.message,stack:error.stack,
  }).catch(()=>{});
  console.error(error);
  process.exitCode=1;
}
