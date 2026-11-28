import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile,readFile,readdir,lstat,realpath } from 'node:fs/promises';
import path from 'node:path';
import {artifactDigest} from '../shared/artifact-identity.mjs';
import { collectionGenerationFiles, materializeCollectionGeneration } from './generation.mjs';

/** Materialize one approved store snapshot. The Host chooses which completed generation to advertise. */
export async function stageCollectionForDiscovery(store, collectionId, hostOwnedRoot, planned) {
  const snapshot = planned?.snapshot ?? store.readCollection(collectionId);
  if (!snapshot) throw new Error('The Host has no approved collection with this ID');
  const { collection, skills } = snapshot;
  if (collection.id !== collectionId) throw new Error('Collection identity differs');
  if (planned?.plan) return materializeCollectionGeneration(snapshot, hostOwnedRoot, planned.plan, planned.signal);
  const bodies = collectionGenerationFiles(snapshot);
  const root = path.resolve(hostOwnedRoot);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, '.flowkit-stage-'));
  const complete = path.join(root, `flowkit-collection-${randomUUID()}`);
  try {
    const files={};
    for (const [file, body] of Object.entries(bodies)) {
      const target = path.join(staging, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body, { flag: 'wx' });
      files[file]=artifactDigest(body);
    }
    const receipt={collectionId,files};const manifestHash=artifactDigest(JSON.stringify(receipt));
    await writeFile(path.join(staging,'.flowkit-generation.json'),JSON.stringify({...receipt,manifestHash}),{flag:'wx'});
    await rename(staging, complete);
    return { discoveryRoot: complete, collectionId, directory: path.join(complete, collection.directory),
      manifestHash,
      skills: skills.map(candidate => ({ id: candidate.manifest.skillId, hash: candidate.hash })) };
  } catch (error) {
    if (path.dirname(staging) === root && path.basename(staging).startsWith('.flowkit-stage-')) {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Remove only an unchanged generation this adapter created, after the Host withdraws its discovery mapping. */
export async function removeCollectionGeneration({hostOwnedRoot,discoveryRoot,collectionId,authorizeRemoval}) {
  const root=await realpath(hostOwnedRoot),requested=path.resolve(discoveryRoot);
  const requestedStat=await lstat(requested);
  const target=await realpath(requested);
  if(path.relative(root,path.dirname(target))!=='' || !/^flowkit-collection-[0-9a-f-]+$/.test(path.basename(target)) ||
    requestedStat.isSymbolicLink() || typeof authorizeRemoval!=='function') {
    throw new Error('Only an exact adapter-owned collection generation may be removed');
  }
  const markerFile=path.join(target,'.flowkit-generation.json');
  const markerStat=await lstat(markerFile);
  if(!markerStat.isFile()||markerStat.size>1024*1024)throw new Error('Invalid generation ownership record');
  const marker=await readFile(markerFile);
  if(marker.length>1024*1024)throw new Error('Generation ownership record exceeds budget');
  const receipt=JSON.parse(marker);const {files,manifestHash}=receipt;
  if(receipt.collectionId!==collectionId || !files || Object.keys(files).length>10000 ||
    manifestHash!==artifactDigest(JSON.stringify({collectionId,files})))throw new Error('Generation ownership record differs');
  if(await authorizeRemoval({collectionId,discoveryRoot:target,manifestHash})!==true)throw new Error('Host denied generation removal');
  if(receipt.ownerHash) {
    const ownerFile=path.join(target,'.flowkit-owner.json'),ownerStat=await lstat(ownerFile);
    if(!ownerStat.isFile()||ownerStat.isSymbolicLink()||ownerStat.size>1024*1024||artifactDigest(await readFile(ownerFile))!==receipt.ownerHash)throw new Error('Generation ownership proof changed');
  }
  const pending=[''];let visited=0,readBytes=0;
  const seen=new Set();
  while(pending.length) {
    const directory=pending.pop();
    for(const entry of await readdir(path.join(target,directory),{withFileTypes:true})) {
      if(++visited>20000)throw new Error('Generation inspection budget exceeded');
      const relative=directory?directory+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw new Error('Generation contains a link or user modification');
      if(entry.isDirectory()){
        if(!Object.keys(files).some(file=>file.startsWith(relative+'/')))throw new Error('Generation contains a user-owned directory');
        pending.push(relative);continue;
      }
      if(relative==='.flowkit-generation.json'||relative==='.flowkit-owner.json'&&receipt.ownerHash)continue;
      const fileStat=await lstat(path.join(target,relative));readBytes+=fileStat.size;
      if(!fileStat.isFile()||readBytes>128*1024*1024)throw new Error('Generation read budget exceeded; retain for Host reconciliation');
      if(!Object.hasOwn(files,relative)||artifactDigest(await readFile(path.join(target,relative)))!==files[relative]) {
        throw new Error('Generation contains user-owned or modified files; keep it for reconciliation');
      }
      seen.add(relative);
    }
  }
  if(seen.size!==Object.keys(files).length)throw new Error('Generation is incomplete; keep it for reconciliation');
  await rm(target,{recursive:true});
  return {collectionId,removed:target,manifestHash};
}
