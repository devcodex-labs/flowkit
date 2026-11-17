import {createHash} from 'node:crypto';

const defaults=Object.freeze({maxEntries:64,maxBytes:8*1024*1024,ttlMs:5*60*1000,maxModuleIdentities:256,maxModuleBytes:64*1024*1024});
let limits={...defaults};
const entries=new Map();
const modules=new Set();
let bytes=0,residentModuleBytes=0,hits=0,misses=0,evictions=0;
const remove=key=>{const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);evictions++;}};
function prune() {
  for(const [key,entry] of entries) if(Date.now()-entry.usedAt>=limits.ttlMs) remove(key);
  while(entries.size>limits.maxEntries || bytes>limits.maxBytes) remove(entries.keys().next().value);
}
export function configureCompilationCache(options) {
  if(!options || Object.keys(options).some(key=>!Object.hasOwn(defaults,key))) throw new TypeError('Unknown compilation cache limit');
  const next={...limits,...options};
  if(!Object.values(next).every(value=>Number.isSafeInteger(value)&&value>0) || next.maxModuleIdentities<modules.size || next.maxModuleBytes<residentModuleBytes) {
    throw new TypeError('Cache limits must be positive and retain already resident module identities');
  }
  limits=next;prune();return compilationCacheStatus();
}
export function clearCompilationCache() {for(const key of entries.keys())remove(key);return compilationCacheStatus();}
export function compilationCacheStatus() {
  prune();return {...limits,entries:entries.size,bytes,residentModuleIdentities:modules.size,residentModuleBytes,hits,misses,evictions};
}
export function getCompilation(key) {
  prune();const entry=entries.get(key);
  if(!entry){misses++;return undefined;}
  hits++;entry.usedAt=Date.now();entries.delete(key);entries.set(key,entry);return entry.value;
}
export function setCompilation(key,value) {
  remove(key);const size=Buffer.byteLength(key)+Buffer.byteLength(value.code);
  if(size>limits.maxBytes)return;
  entries.set(key,{value,bytes:size,usedAt:Date.now()});bytes+=size;prune();
}
/** Node retains data-URL modules until the process ends. Clearing LRU entries cannot unload them. */
export function reserveModuleIdentity(moduleId,code) {
  const identity=createHash('sha256').update(moduleId).digest('hex');
  const size=Buffer.byteLength(code);
  if(!modules.has(identity)) {
    if(modules.size>=limits.maxModuleIdentities || residentModuleBytes+size>limits.maxModuleBytes) {
      throw Object.assign(new Error('FK_R001 resident Program identity limit reached; rotate the Host process before loading a new Program'),
        {code:'FK_R001',kind:'module-capacity'});
    }
    // Reserve synchronously so concurrent imports cannot exceed the process budget.
    modules.add(identity);
    residentModuleBytes+=size;
  }
}
export async function loadBoundedModule(code) {
  reserveModuleIdentity('data:'+createHash('sha256').update(code).digest('hex'),code);
  return import('data:text/javascript;base64,'+Buffer.from(code,'utf8').toString('base64'));
}
