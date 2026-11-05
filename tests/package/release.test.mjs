import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { create as createTar, Header } from 'tar';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assessRelease, packRelease, verifyRelease } from '../../scripts/release.mjs';
import { packageFiles } from '../../scripts/package-files.mjs';
import { build } from '../../scripts/build.mjs';
import { validatePackage } from '../../scripts/check-package.mjs';
import { runProcess } from '../../scripts/validation-process.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const tag = 'v0.1.0-test.0';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'flowkit-release-tests-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('flowkit-release-tests-')); await rm(root, {recursive:true,force:true}); });
  for (const file of ['package.json', 'package-lock.json', 'README.md', ...packageFiles.map(([source]) => source)]) {
    await mkdir(path.dirname(path.join(root, file)), {recursive:true}); await copyFile(path.join(repository, file), path.join(root, file));
  }
  const pkg = JSON.parse(await readFile(path.join(root,'package.json')));
  Object.assign(pkg, {private:false,version:tag.slice(1),license:'MIT'});
  const lock = JSON.parse(await readFile(path.join(root,'package-lock.json'))); lock.version=pkg.version; lock.packages[''].version=pkg.version;
  await writeFile(path.join(root,'package.json'),JSON.stringify(pkg,null,2)); await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));
  await writeFile(path.join(root,'LICENSE'),'Synthetic fixture license, not a project license decision.');
  await writeFile(path.join(root,'CHANGELOG.md'),`# Changelog\n\n## ${pkg.version}\n\nFixture release.\n`);
  return root;
}
async function syntheticArtifact(root) {
  // This fixture builds a real gzip/tar archive; integration separately uses actual npm pack.
  await build(root);
  const directory=path.join(root,'.tmp/release');await mkdir(directory,{recursive:true});
  const filename=`devcodex-flowkit-${tag.slice(1)}.tgz`;
  const files=[];for(const member of ['package.json','README.md','LICENSE',...packageFiles.map(([,output])=>output)]){
    const source=packageFiles.find(([,output])=>output===member)?.[0]??member;
    files.push({path:member,sha256:digest(await readFile(path.join(root,source)))});
  }
  await createTar({cwd:root,file:path.join(directory,filename),prefix:'package',gzip:true,portable:true},files.map(file=>file.path));
  const bytes=await readFile(path.join(directory,filename));
  const manifest={schemaVersion:1,name:'@devcodex/flowkit',version:tag.slice(1),tag,npmTag:'next',filename,sha256:digest(bytes),files};
  await writeFile(path.join(directory,'release.json'),JSON.stringify(manifest));
  return {directory,filename,manifest,bytes};
}

test('release assessment collects current gaps without writing and accepts adjacent candidate metadata',async t=>{
  const root=await fixture(t);assert.equal((await assessRelease(root,tag)).ready,true);
  await assert.rejects(access(path.join(root,'.tmp')),{code:'ENOENT'});
  assert.equal((await assessRelease(root,'v0.2.0')).issues.some(issue=>issue.field==='tag'),true);
  const filename=path.join(root,'package.json'),original=JSON.parse(await readFile(filename));
  for(const [field,mutate]of [['private',pkg=>pkg.private=true],['license',pkg=>pkg.license='UNLICENSED'],['repository',pkg=>pkg.repository.url='git+https://example.test/wrong.git'],['publishConfig',pkg=>pkg.publishConfig.registry='https://example.test/'],['version',pkg=>pkg.version='0.1.0+build']]){
    const altered=structuredClone(original);mutate(altered);await writeFile(filename,JSON.stringify(altered));
    assert.ok((await assessRelease(root,tag)).issues.some(issue=>issue.field===field),field);
  }
  await writeFile(filename,JSON.stringify(original));await rm(path.join(root,'LICENSE'));await writeFile(path.join(root,'CHANGELOG.md'),'## 0.1.0-test.01\n');
  const assessment=await assessRelease(root,tag);assert.ok(assessment.issues.some(issue=>issue.field==='LICENSE'));assert.ok(assessment.issues.some(issue=>issue.field==='CHANGELOG'));
});

test('stable releases use latest; lock root identities and explicit private booleans stay validated',async t=>{
  const root=await fixture(t);await build(root);
  const packed=['package.json','README.md','LICENSE',...packageFiles.map(([,output])=>output)];
  assert.equal((await validatePackage(root,packed)).licensePresent,true);
  const filename=path.join(root,'package.json'),pkg=JSON.parse(await readFile(filename));
  for(const value of [null,'false',0]){await writeFile(filename,JSON.stringify({...pkg,private:value}));await assert.rejects(validatePackage(root,packed));}
  pkg.version='0.1.0';await writeFile(filename,JSON.stringify(pkg));const lock=JSON.parse(await readFile(path.join(root,'package-lock.json')));
  lock.version=pkg.version;await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));
  assert.ok((await assessRelease(root,'v0.1.0')).issues.some(issue=>issue.field==='lockfile'));await assert.rejects(validatePackage(root,packed));
  lock.packages[''].version=pkg.version;await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));await writeFile(path.join(root,'CHANGELOG.md'),'## [0.1.0] - Fixture\n');
  assert.equal((await assessRelease(root,'v0.1.0')).npmTag,'latest');assert.equal((await assessRelease(root,'v0.1.0')).ready,true);
});

test('artifact verification binds tag, source bytes, exact members and tarball digest without rebuilding',async t=>{
  const root=await fixture(t);const {directory,filename,manifest,bytes}=await syntheticArtifact(root);
  assert.deepEqual(await verifyRelease(root,tag),manifest);
  await writeFile(path.join(directory,filename),'tampered');await assert.rejects(verifyRelease(root,tag),/digest mismatch/);
  await writeFile(path.join(directory,filename),bytes);
  await writeFile(path.join(root,'src/index.mjs'),'changed source');await assert.rejects(verifyRelease(root,tag),/source changed/);
  await copyFile(path.join(repository,'src/index.mjs'),path.join(root,'src/index.mjs'));
  await writeFile(path.join(directory,'extra.txt'),'foreign');await assert.rejects(verifyRelease(root,tag),/Unexpected release artifacts/);await rm(path.join(directory,'extra.txt'));
  for(const mutate of [m=>m.tag='v9.0.0',m=>m.filename='../outside.tgz',m=>m.files[0].path='../outside',m=>m.files.pop()]){
    const altered=structuredClone(manifest);mutate(altered);await writeFile(path.join(directory,'release.json'),JSON.stringify(altered));await assert.rejects(verifyRelease(root,tag));
  }
});

test('real archive omissions, duplicate members, substituted content and non-tar bytes cannot be blessed by a new checksum',async t=>{
  const root=await fixture(t);const {directory,filename,manifest}=await syntheticArtifact(root);
  const target=path.join(directory,filename),metadata=path.join(directory,'release.json'),members=manifest.files.map(file=>file.path);
  for(const list of [members.slice(1),[...members,members[0]]]){
    await createTar({cwd:root,file:target,prefix:'package',gzip:true,portable:true},list);
    await writeFile(metadata,JSON.stringify({...manifest,sha256:digest(await readFile(target))}));
    await assert.rejects(verifyRelease(root,tag),/archive|tar member/);
  }
  await writeFile(path.join(root,'dist/index.mjs'),'substituted artifact content');
  await createTar({cwd:root,file:target,prefix:'package',gzip:true,portable:true},members);
  await writeFile(metadata,JSON.stringify({...manifest,sha256:digest(await readFile(target))}));
  await assert.rejects(verifyRelease(root,tag),/archive content mismatch/);
  await writeFile(target,'not a gzip tarball');await writeFile(metadata,JSON.stringify({...manifest,sha256:digest(Buffer.from('not a gzip tarball'))}));
  await assert.rejects(verifyRelease(root,tag));
});

test('unknown-type extra and duplicate headers rejected even when the aggregate digest is recomputed',async t=>{
  const root=await fixture(t);const {directory,filename,manifest,bytes}=await syntheticArtifact(root);
  const raw=gunzipSync(bytes);assert.ok(raw.subarray(-1024).every(value=>value===0));
  for(const member of ['package/extra-file.txt','package/dist/index.mjs']){
    const header=new Header({path:member,type:'File',size:0,mode:0o644,uid:0,gid:0,mtime:new Date(0)});header.encode();
    const block=Buffer.from(header.block);block[156]='Z'.charCodeAt(0);block.fill(32,148,156);
    const sum=block.reduce((a,b)=>a+b,0);block.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
    const changed=gzipSync(Buffer.concat([raw.subarray(0,-1024),block,Buffer.alloc(1024)]));
    await writeFile(path.join(directory,filename),changed);await writeFile(path.join(directory,'release.json'),JSON.stringify({...manifest,sha256:digest(changed)}));
    await assert.rejects(verifyRelease(root,tag),/Ignored tar member/);
  }
});

test('pack refuses unready metadata before creating output; linked output cannot redirect writes',async t=>{
  const root=await fixture(t),filename=path.join(root,'package.json'),pkg=JSON.parse(await readFile(filename));
  await writeFile(filename,JSON.stringify({...pkg,private:true}));await assert.rejects(packRelease(root,tag),error=>error.assessment?.ready===false);
  await assert.rejects(access(path.join(root,'.tmp')),{code:'ENOENT'});await writeFile(filename,JSON.stringify(pkg));
  const outside=path.join(root,'outside');await mkdir(outside);await symlink(outside,path.join(root,'.tmp'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(packRelease(root,tag,'selected-npm-cli'),/Invalid release directory/);await assert.rejects(access(path.join(outside,'release')),{code:'ENOENT'});
});

test('release CLI distinguishes unready candidate and bad invocation with read-only JSON output',async()=>{
  const pkg=JSON.parse(await readFile(path.join(repository,'package.json')));
  for(const [args,expected]of [[['check','--tag',`v${pkg.version}-mismatch`],1],[['check'],2],[['publish','--tag','v1.0.0'],2]]){
    const result=await runProcess(process.execPath,['scripts/release.mjs',...args],{cwd:repository});
    assert.equal(result.status,expected,result.stderr);assert.equal(result.error,undefined);assert.equal(result.stderr,'');assert.ok(JSON.parse(result.stdout));
  }
});
