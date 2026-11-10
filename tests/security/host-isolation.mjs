/**
 * M5 explicit Linux OS-user isolation proof.
 * Run ONLY as a dedicated CI job with a privilege-boundary-capable runner.
 * It is deliberately not a mocked promise or an in-process verifier test.
 */
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSqliteCheckpointStore} from '../../src/interactive/sqlite-store.mjs';

if (process.platform!=='linux') throw new Error('M5 OS isolation proof requires Linux runner');
const root=await mkdtemp(path.join(tmpdir(),'flowkit-m5-os-'));
let store;
try {
  // mkdtemp defaults to 0700; the public task must actually be readable by
  // the unprivileged child while Host-owned secrets remain inaccessible.
  await chmod(root,0o755);
  const publicDir=path.join(root,'public');
  const hostDir=path.join(root,'host-private');
  await mkdir(publicDir,{mode:0o755});
  await mkdir(hostDir,{mode:0o700});
  const publicTask=path.join(publicDir,'task.json');
  const privateKey=path.join(hostDir,'signing-key.pem');
  const sqliteFile=path.join(hostDir,'checkpoint.db');
  await writeFile(publicTask,JSON.stringify({kind:'agent',requestId:'req-public',instruction:'public'}),{mode:0o644});
  const pair=generateKeyPairSync('ed25519');
  await writeFile(privateKey,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  store=createSqliteCheckpointStore(sqliteFile,{namespace:'host-owned'});
  await chmod(privateKey,0o600);
  await chmod(hostDir,0o700);

  const childCode=String.raw`
    import {readFile,writeFile} from 'node:fs/promises';
    const [publicTask,privateKey,sqliteFile]=process.argv.slice(1);
    const task=JSON.parse(await readFile(publicTask,'utf8'));
    if(task.requestId!=='req-public')throw Error('PUBLIC_TASK_UNREADABLE');
    for(const secret of [privateKey,sqliteFile]){
      let denied=false;
      try{await readFile(secret); }catch(e){denied=e.code==='EACCES'||e.code==='EPERM';}
      if(!denied)throw Error('HOST_SECRET_READABLE_BY_MODEL');
    }
    let denied=false;
    try{await writeFile(sqliteFile,'corrupt');}catch(e){denied=e.code==='EACCES'||e.code==='EPERM';}
    if(!denied)throw Error('HOST_DATABASE_WRITABLE_BY_MODEL');
    process.stdout.write('ISOLATION_CONFIRMED');
  `;
  const args=process.getuid?.()===0
    ? {command:process.execPath,args:['--input-type=module','-e',childCode,
      publicTask,privateKey,sqliteFile],options:{uid:65534,gid:65534}}
    : {command:'sudo',args:['-n','-u','nobody','--',process.execPath,
      '--input-type=module','-e',childCode,publicTask,privateKey,sqliteFile],
      options:{}};
  const child=await new Promise((resolve,reject)=>{
    const proc=spawn(args.command,args.args,{
      stdio:['ignore','pipe','pipe'],...args.options,
    });
    let stdout='',stderr='';
    proc.stdout.on('data',buffer=>stdout+=buffer);
    proc.stderr.on('data',buffer=>stderr+=buffer);
    proc.on('error',reject);
    proc.on('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
  assert.equal(child.code,0,
    'Model OS user must read public task but cannot reach Host key/DB: '+child.stderr);
  assert.match(child.stdout,/ISOLATION_CONFIRMED/);
  assert.match(await readFile(publicTask,'utf8'),/req-public/);
  assert.match(await readFile(privateKey,'utf8'),/BEGIN PRIVATE KEY/);
  assert.equal(store.load('unrelated-run'),null);
  console.log('M5 Linux OS-user boundary PASS: public task readable; Host key and SQLite file read/write denied');
} finally {
  store?.close();
  await rm(root,{recursive:true,force:true});
}
