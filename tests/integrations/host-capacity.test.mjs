import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {SkillsClient} from '@modelcontextprotocol/client/ext/skills';
import {createFlowkitHttpHandler} from '../../src/mcp.mjs';
import {fixtureOptions} from './mcp-fixture.mjs';
import {prepareProfessionalSkill,publishProfessionalSkill} from '../../src/author/professional-skills.mjs';
import {createIndependentAgentAdapter} from '../../src/host.mjs';

test('1026 approved Skills use bounded metadata pages and keep identical logical IDs isolated across authenticated projects',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'flowkit-scale-'));
  const hosts=new Map(),clients=[];let server;
  try {
    for(const tenant of ['alpha','beta']) {
      const fixture=await fixtureOptions(path.join(directory,tenant+'.sqlite'));
      hosts.set(tenant,fixture);fixture.options.namespace=tenant;
      fixture.options.limits={pageSize:16,maxResourceBytes:32768,maxMetadataEntries:2048};
      const collection=fixture.options.store.readCollectionMetadata('test-collection').collection;
      for(let i=0;i<512;i++) {
        const candidate=prepareProfessionalSkill(collection,{id:'same-'+i,name:'load-'+String(i).padStart(4,'0'),
          version:'1.0.0',description:'Local scale fixture',body:'# '+tenant+' instruction',
          resources:{'references/payload.md':tenant+' '+ 'x'.repeat(16384)}});
        await publishProfessionalSkill(candidate,{reviewRef:'review',approvalRef:'fixture-approved',previousHash:null},fixture.options.store);
      }
      let bodyReads=0;const store=fixture.options.store;
      assert.equal(store.readCollectionMetadata('test-collection',{limit:3}).skills.length,3);
      assert.throws(()=>store.readCollectionMetadata('test-collection',{limit:-1}));
      fixture.options.store={...store,readCollection(){assert.fail('MCP must use metadata-only queries');},
        readVersion(...args){bodyReads++;return store.readVersion(...args);}};
      fixture.bodyReads=()=>bodyReads;
    }
    server=createServer(createFlowkitHttpHandler(request=>hosts.get(request.headers.authorization)?.options??null));
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const url=new URL(`http://127.0.0.1:${server.address().port}/mcp`);
    for(const tenant of ['alpha','beta']) {
      const client=new Client({name:'scale',version:'1'},{skills:true});clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:tenant}}}));
      const skills=new SkillsClient(client);const page=await skills.list({cursor:'0'});
      assert.equal(page.skills.length,16);assert.equal(page.nextCursor,'16');
      assert.equal(hosts.get(tenant).bodyReads(),16);
      assert.ok(Buffer.byteLength(JSON.stringify(page))<32768);
      assert.ok(!JSON.stringify(page).includes('x'.repeat(50)));
      const selected=page.skills.find(skill=>skill.frontmatter.name==='load-0000');assert.ok(selected);
      const payload=await skills.read(selected,'references/payload.md');assert.equal(payload.verified,true);
      assert.ok(payload.text.startsWith(tenant+' '));
      const foreign=selected.uri.replace(`skill://${tenant}/`,`skill://${tenant==='alpha'?'beta':'alpha'}/`);
      await assert.rejects(client.readResource({uri:foreign}));
      const collection=await client.callTool({name:'flowkit_collection',arguments:{collectionId:'test-collection'}});
      const metadata=JSON.parse(collection.content[0].text);
      assert.equal(metadata.skills.length,16);assert.equal(metadata.nextCursor,'16');
      assert.equal((await skills.list()).skills.length,513);
    }
  } finally {
    for(const client of clients)await client.close();
    if(server)await new Promise(resolve=>server.close(resolve));
    for(const fixture of hosts.values())fixture.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('64 concurrent Host attempts never exceed four physical slots and all completed sessions can be reclaimed',async()=>{
  let finish;const barrier=new Promise(resolve=>{finish=resolve;});
  const adapter=createIndependentAgentAdapter({scope:'pressure',limits:{maxConcurrent:4,maxSessions:8},authorize:()=>true,
    select:async({artifactHash,runId,nodeId})=>({artifactHash,runId,nodeId,subjectId:runId,sessionId:runId,
      workspaceRef:runId,permissionRef:'test',runAgentTask:async()=>{await barrier;return {status:'succeeded',result:{},events:[]};}})});
  const task=runId=>({task:{workflow:{artifactHash:'approved'},run:{runId},node:{id:'work'},execution:{}}});
  const operations=Array.from({length:64},(_,index)=>adapter.runAgentTask(task('run-'+index)));
  assert.equal(adapter.status().activeExecutions,4);finish();
  const results=await Promise.all(operations);
  assert.equal(results.filter(result=>result.status==='succeeded').length,4);
  assert.equal(results.filter(result=>result.failure?.code==='agent-capacity').length,60);
  for(let i=0;i<64;i++)adapter.releaseRun('approved','run-'+i);
  assert.deepEqual(adapter.status(),{activeExecutions:0,sessionBindings:0});
});
