import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {chmod,chown,copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.platform,'linux');
assert.equal(process.getuid(),0,'run the disposable profile bootstrap as root');
const repo=fileURLToPath(new URL('../../',import.meta.url));
const hostUid=41001;
const modelUid=41002;
for (const id of [hostUid,modelUid]) {
  for (const database of ['passwd','group']) {
    const lookup=spawnSync('/usr/bin/getent',[database,String(id)]);
    assert.equal(lookup.status,2,'use a disposable runner with unused fixture identities');
  }
}
const root=await mkdtemp(path.join(tmpdir(),'flowkit-profile-'));
const publicDir=path.join(root,'public');
const hostDir=path.join(root,'host-private');
const modelDir=path.join(root,'model-scratch');
const worker=path.join(publicDir,'tests/security/secure-host-worker.mjs');
let host,model;

function launch(uid,mode,extraArgs=[]) {
  const args=[
    '--reuid='+uid,'--regid='+uid,'--clear-groups','--inh-caps=-all',
    '--bounding-set=-all','--no-new-privs',process.execPath,worker,mode,root,...extraArgs,
  ];
  const child=spawn('/usr/bin/setpriv',args,{
    cwd:publicDir,
    env:{PATH:'/usr/bin:/bin',LANG:'C',...(mode==='host'?{FLOWKIT_HOST_CANARY:'flowkit-disposable-host-fixture'}:{})},
    stdio:['ignore','pipe','pipe'],
  });
  console.log(JSON.stringify({event:'spawn',mode,command:'/usr/bin/setpriv',args,pid:child.pid}));
  child.stdout.pipe(process.stdout,{end:false});
  child.stderr.pipe(process.stderr,{end:false});
  const finished=new Promise(resolve=>{
    child.once('error',error=>resolve({error:error.message}));
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  return {child,finished};
}

async function readReport(directory,filename) {
  return JSON.parse(await readFile(path.join(directory,filename),'utf8'));
}

async function waitReady() {
  for (let i=0;i<150;i++) {
    try {return await readReport(hostDir,'host-ready.json');}
    catch (error) {if (error.code!=='ENOENT') throw error;}
    assert.equal(host.child.exitCode,null,'Host stopped during startup');
    await delay(100);
  }
  assert.fail('Host startup timed out');
}

async function finish(workerProcess,timeout) {
  const timer=setTimeout(()=>workerProcess.child.kill('SIGKILL'),timeout);
  try {assert.deepEqual(await workerProcess.finished,{code:0,signal:null});}
  finally {clearTimeout(timer);}
}

function verifyModelExec() {
  const input='fixture stdin\n';
  const execShim=path.join(publicDir,'model-exec');
  const child=spawn('/usr/bin/setpriv',[
    '--reuid='+modelUid,'--regid='+modelUid,'--clear-groups','--inh-caps=-all',
    '--bounding-set=-all','--no-new-privs',process.execPath,
    path.join(publicDir,'tests/security/codex-model-identity.mjs'),String(modelUid),String(modelUid),
    execShim,path.join(publicDir,'model-stdio-fixture'),
  ],{cwd:publicDir,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['pipe','pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',data=>{stdout+=data;});
  child.stderr.setEncoding('utf8').on('data',data=>{stderr+=data;});
  const finished=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.stdin.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  child.stdin.end(input);
  return finish({child,finished},5000).then(()=>{
    const [record,result]=stdout.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(record.method,'flowkit/profile/identity');
    const identity=record.params;
    assert.equal(identity.pid,child.pid);
    assert.equal(identity.uid,modelUid);
    assert.equal(identity.gid,modelUid);
    assert.deepEqual(result,{pid:identity.pid,uid:identity.uid,gid:identity.gid});
    assert.equal(stderr,'fixture stderr');
    console.log(JSON.stringify({event:'codex-model-exec-fixture',...identity,roundTrip:true}));
  });
}

try {
  await chmod(root,0o755);
  await mkdir(publicDir,{mode:0o755});
  for (const [folder,uid] of [[hostDir,hostUid],[modelDir,modelUid]]) {
    await mkdir(folder,{mode:0o700});
    await chown(folder,uid,uid);
  }
  for (const relative of ['tests/security/secure-host-worker.mjs','tests/security/codex-model-identity.mjs',
    'src/interactive/sqlite-store.mjs','src/interactive/checkpoint.mjs','src/interactive/canonical.mjs']) {
    const destination=path.join(publicDir,relative);
    await mkdir(path.dirname(destination),{recursive:true,mode:0o755});
    await copyFile(path.join(repo,relative),destination);
    await chmod(destination,0o644);
  }
  const compiler='/usr/bin/cc';
  const shim=spawnSync(compiler,['-Wall','-Wextra','-Werror','-O2',
    path.join(repo,'tests/security/codex-model-exec-linux.c'),'-o',path.join(publicDir,'model-exec')],{stdio:'inherit'});
  assert.equal(shim.status,0,'Compile the Model exec shim');
  const fixtureSource=path.join(publicDir,'model-stdio-fixture.c');
  await writeFile(fixtureSource,`
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  for (int fd = 0; fd <= 2; fd++) {
    int flags = fcntl(fd, F_GETFL);
    if (flags == -1 || (flags & O_NONBLOCK)) return 1;
  }
  if (fcntl(3, F_GETFD) != -1) return 2;
  char input[64];
  if (!fgets(input, sizeof(input), stdin) || strcmp(input, "fixture stdin\\n")) return 3;
  printf("{\\"pid\\":%ld,\\"uid\\":%lu,\\"gid\\":%lu}\\n", (long)getpid(),
    (unsigned long)getuid(), (unsigned long)getgid());
  fputs("fixture stderr", stderr);
  return 0;
}
`,{mode:0o644});
  const fixtureBuild=spawnSync(compiler,['-Wall','-Wextra','-Werror','-O2',fixtureSource,
    '-o',path.join(publicDir,'model-stdio-fixture')],{stdio:'inherit'});
  assert.equal(fixtureBuild.status,0,'Compile the stdio check');
  await verifyModelExec();
  await writeFile(path.join(publicDir,'task.json'),'flowkit-public-task\n',{mode:0o644});
  host=launch(hostUid,'host');
  const ready=await waitReady();
  assert.equal(ready.pid,host.child.pid);
  assert.equal(ready.identity.uid,hostUid);
  console.log(JSON.stringify({event:'host-ready',...ready}));

  model=launch(modelUid,'model',[String(ready.pid)]);
  await finish(model,30000);
  const result=await readReport(modelDir,'model-result.json');
  assert.equal(result.pid,model.child.pid);
  assert.equal(result.identity.uid,modelUid);
  assert.ok(result.publicTaskReadable && result.checks.length===47);
  console.log(JSON.stringify({event:'model-result',...result}));

  await writeFile(path.join(hostDir,'stop'),'stop\n',{mode:0o600});
  await finish(host,15000);
  const closed=await readReport(hostDir,'host-result.json');
  assert.ok(closed.protectedBytesUnchanged && closed.keyUsable);
  console.log(JSON.stringify({event:'host-result',...closed}));
} catch (error) {
  for (const [folder,filename] of [[hostDir,'host-error.json'],[modelDir,'model-error.json']]) {
    try {console.error(JSON.stringify(await readReport(folder,filename)));}
    catch (reportError) {if (reportError.code!=='ENOENT') console.error(reportError.message);}
  }
  throw error;
} finally {
  for (const process of [model,host]) {
    if (!process) continue;
    if (process.child.exitCode===null && process.child.signalCode===null) process.child.kill('SIGKILL');
    await process.finished;
  }
  await rm(root,{recursive:true,force:true});
}
