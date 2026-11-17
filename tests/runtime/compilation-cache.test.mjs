import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {configureCompilationCache,compilationCacheStatus,clearCompilationCache,
  getCompilation,setCompilation,loadBoundedModule} from '../../src/runtime/compilation-cache.mjs';
import {releaseToolReceipts} from '../../src/host.mjs';

test('compiled LRU enforces entries, bytes, TTL and explicit cleanup without resetting resident module accounting',async()=>{
  configureCompilationCache({maxEntries:2,maxBytes:32,ttlMs:30,maxModuleIdentities:2});
  setCompilation('a',{code:'first'});setCompilation('b',{code:'second'});assert.ok(getCompilation('a'));
  setCompilation('c',{code:'third'});assert.equal(getCompilation('b'),undefined);
  setCompilation('oversize',{code:'x'.repeat(64)});assert.equal(getCompilation('oversize'),undefined);
  assert.equal(compilationCacheStatus().entries,2);assert.ok(compilationCacheStatus().bytes<=32);
  await delay(40);assert.equal(getCompilation('a'),undefined);assert.equal(compilationCacheStatus().entries,0);
  await loadBoundedModule('export const boundedA=1;');await loadBoundedModule('export const boundedB=2;');
  assert.equal(clearCompilationCache().residentModuleIdentities,2);
  await assert.rejects(loadBoundedModule('export const boundedC=3;'),error=>error.kind==='module-capacity');
  assert.equal((await loadBoundedModule('export const boundedA=1;')).boundedA,1);
  assert.throws(()=>configureCompilationCache({maxModuleIdentities:1}));
  assert.throws(()=>configureCompilationCache({maxBytes:0}));
});

test('receipt cleanup is exact-scope and atomically refuses unknown writes',()=>{
  const key=(scope,run,name)=>JSON.stringify([scope,run,'node',name,'operation']);
  const ledger=new Map([[key('one','run','completed'),{status:'completed'}],
    [key('one','run','unknown'),{status:'pending'}],[key('two','run','completed'),{status:'completed'}]]);
  assert.throws(()=>releaseToolReceipts(ledger,{scope:'one',runId:'run'}),/reconciliation/);assert.equal(ledger.size,3);
  ledger.get(key('one','run','unknown')).status='completed';
  assert.deepEqual(releaseToolReceipts(ledger,{scope:'one',runId:'run'}),{removed:2,remaining:1});
  assert.ok(ledger.has(key('two','run','completed')));
});
