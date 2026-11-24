import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { prepareStandardSkill } from '../../src/author/standard-artifact.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';
import { exportTrust, newExportKey, publicDelivery, readPortableExport } from '../../scripts/local-mcp-artifacts.mjs';
import { readWorkflowPageData, workflowPage } from '../../scripts/workflow-viewer.mjs';

async function movingDots(page, selector) {
  await page.waitForFunction(target=>document.querySelector(target)?.hasAttribute('cx'),selector,{timeout:5000});
  const initial=await page.locator(selector).evaluateAll(dots=>dots.slice(0,10).map(dot=>{
    return {width:dot.getBoundingClientRect().width,cx:dot.getAttribute('cx'),cy:dot.getAttribute('cy')};
  }));
  assert.ok(initial.length);
  await page.waitForFunction(({initial,selector})=>[...document.querySelectorAll(selector)].slice(0,10).some((dot,index)=>{
    const origin=initial[index];
    return dot.getAttribute('cx')!==origin.cx||dot.getAttribute('cy')!==origin.cy;
  }),{initial,selector},{timeout:5000});
  return initial[0].width;
}

test('a signed V4.5 export works offline at four widths and two motion settings', {timeout:120000}, async t=>{
  const temporary=await mkdtemp(path.join(tmpdir(),'flowkit-browser-'));
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  const candidateOptions={
    file:fileURLToPath(new URL('../../examples/v45/software-delivery.workflow.js',import.meta.url)),
    collectionId:'v45-browser',skillId:'software-delivery',name:'software-delivery',
    description:'V4.5 browser test',version:'1.0.0',executionMode:'interactive-p2',
    hostProfile:{id:'v45-browser',digest:artifactDigest('v45-browser')},buildId:'v45-browser',
  };
  const {candidate}=await prepareStandardSkill(candidateOptions);
  assert.ok(candidate);
  const key=newExportKey(), files=publicDelivery(candidate,key);
  assert.deepEqual(Object.keys(files).sort(),['workflow.html','workflow.js','workflow.mmd']);
  assert.equal(readPortableExport(files,exportTrust([key.publicKey])).candidate.hash,candidate.hash);
  await Promise.all(Object.entries(files).map(([name,body])=>writeFile(path.join(temporary,name),body)));
  const original=readWorkflowPageData(files['workflow.html']);
  const {graph,layout,candidateHash}=original;
  assert.equal(original.mermaid,files['workflow.mmd']);
  assert.equal(candidateHash,candidate.hash);
  assert.equal(graph.artifactHash,artifactDigest(files['workflow.js']));
  assert.equal(graph.nodes.length,140);
  assert.equal(layout.nodes.length,142);
  const reauthoredFile=path.join(temporary,'reauthored.workflow.js');
  const originalSource=await readFile(candidateOptions.file,'utf8');
  await writeFile(reauthoredFile,'\n'+originalSource);
  const {candidate:reauthored}=await prepareStandardSkill({...candidateOptions,file:reauthoredFile});
  const regenerated=readWorkflowPageData(publicDelivery(reauthored,key)['workflow.html']);
  assert.notEqual(regenerated.graph.artifactHash,graph.artifactHash);
  assert.notEqual(regenerated.graph.graphDigest,graph.graphDigest);
  assert.deepEqual(regenerated.layout,layout);
  await writeFile(reauthoredFile,originalSource.replace("intent.status === 'ready'", "intent.status === 'other'"));
  const {candidate:changedPredicate}=await prepareStandardSkill({...candidateOptions,file:reauthoredFile});
  const changedLayout=readWorkflowPageData(publicDelivery(changedPredicate,key)['workflow.html']).layout;
  assert.equal(changedLayout.phases.length,1);
  const evidence={candidateHash,artifactHash:graph.artifactHash,graphDigest:graph.graphDigest,cases:[]};
  const browser=await chromium.launch(process.env.FLOWKIT_BROWSER_CHANNEL?{channel:process.env.FLOWKIT_BROWSER_CHANNEL}:{});
  evidence.browser=browser.version();
  try {
    const roleSource = path.join(temporary, 'role.workflow.js');
    await writeFile(roleSource, `import { defineWorkflow, node, terminal } from '@devcodex-labs/flowkit/dsl';
      export default defineWorkflow({ id:'role-review', name:'Role review', version:'1.0.0', nodes:[
        node('review',{ name:'Review record', description:'Review the approved record.', inputs:[], output:{type:'object'}, next:'done' }),
        terminal('done',{ name:'Done', status:'succeeded' })
      ] });`);
    const { candidate: roleCandidate } = await prepareStandardSkill({ ...candidateOptions, file: roleSource, name:'role-review',
      skillId:'role-review', executionMode:'standard', compilerOptions:{ projectRoot:temporary } });
    const roleDiagram = readWorkflowPageData(publicDelivery(roleCandidate,key)['workflow.html']);
    const agent = roleDiagram.graph.nodes.find(node => node.type === 'agent');
    const rolePage = await browser.newPage({ offline: true });
    try {
      await rolePage.setContent(workflowPage({ graph:roleDiagram.graph, viewLayout:roleDiagram.layout, executionManifest: {
        nodeRoles: [{ nodeId: agent.id, id: 'reviewer', label: '业务复核员' }],
        professionalSkills: [{ nodeId: agent.id, id: 'record-check', version: '1.0.0', digest: artifactDigest('record-check'), source: 'test-catalog' }]
      } }));
      const card = roleDiagram.layout.nodes.find(node => node.nodeId === agent.id);
      await rolePage.locator(`#nodeLayer [data-node-id="${card.id}"]`).press('Enter');
      const panel = await rolePage.locator('#inspectorBody').innerText();
      assert.match(panel, /业务复核员/);
      assert.match(panel, /record-check · 1\.0\.0 · 已固定/);
    } finally { await rolePage.close(); }
    for(const reducedMotion of ['no-preference','reduce'])for(const width of [390,800,1024,1440]){
      const page=await browser.newPage({offline:true,reducedMotion,viewport:{width,height:950}});
      const exceptions=[], externalRequests=[];
      page.on('pageerror',error=>exceptions.push(error.message));
      page.on('request',request=>{if(/^https?:/.test(request.url()))externalRequests.push(request.url());});
      try {
        await page.goto(pathToFileURL(path.join(temporary,'workflow.html')).href);
        assert.equal(await page.locator('#nodeLayer [data-node-id]').count(),142);
        assert.equal(await page.locator('#edgeLayer .edge-group').count(),layout.edges.length);
        assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),reducedMotion==='reduce');
        const diameter=await movingDots(page,'.ambient-dot[data-kind=normal]');
        assert.ok(diameter>=5&&diameter<=6,`visible first-frame diameter at ${width}px: ${diameter}`);
        assert.equal(await page.getByRole('button',{name:'播放动画',exact:true}).count(),0);
        await page.getByRole('button',{name:'核对静态检查配置 · check-lint-config',exact:true}).press('Enter');
        const fields=await page.evaluate(()=>{
          const labels=[...document.querySelectorAll('#inspectorBody .meta-list .k')];
          const id=labels.find(element=>element.textContent==='节点 ID');
          const phase=labels.find(element=>element.textContent==='所属阶段');
          return [id,id.nextElementSibling,phase.nextElementSibling,document.querySelector('#inspectorBody .capability-name')].map(element=>{
            const {fontFamily,fontWeight,fontSize}=getComputedStyle(element);
            return [fontFamily,fontWeight,fontSize];
          });
        });
        assert.ok(fields.every(([family,weight,size])=>family===fields[0][0]&&weight==='400'&&size==='13px'));
        await page.getByRole('button',{name:'并行入口 · run-ci',exact:true}).press('Enter');
        const region=page.locator('#panel-section-branches');
        assert.match(await region.innerText(),/全部分支成功/);
        assert.equal(await region.getByRole('button').count(),5);
        assert.equal(await region.evaluate(element=>element.scrollWidth<=element.clientWidth),true);
        await region.getByRole('button',{name:'准备单元测试套件 4 个成员'}).click();
        assert.equal(await page.locator('#inspectorTitle').innerText(),'准备单元测试套件');
        await page.getByRole('button',{name:'并行汇合 · run-ci',exact:true}).press('Enter');
        await region.getByRole('button',{name:'汇总并行结果 aggregate-c-i-results'}).click();
        assert.equal(await page.locator('#inspectorTitle').innerText(),'汇总并行结果');
        await page.getByRole('button',{name:'并行入口 → 准备单元测试套件',exact:true}).press('Enter');
        await movingDots(page,'.motion-layer .motion-comet');
        assert.equal(await page.locator('#inspectorTitle').innerText(),'进入并行分支');
        assert.deepEqual(exceptions,[]);
        assert.deepEqual(externalRequests,[]);
        if(width===1440&&reducedMotion==='no-preference'){
          await page.getByRole('button',{name:'返回概览',exact:true}).click();
          for(const [label,search] of [['阅读 Mermaid','ArchiveDelivery'],['阅读根契约','required']]){
            await page.getByRole('button',{name:label,exact:true}).click();
            const reader=page.locator('#detailReader');
            await reader.getByRole('searchbox').fill(search);
            await reader.getByRole('button',{name:'查找下一处'}).click();
            assert.equal(await reader.locator('.reader-match').count(),1);
            await reader.getByRole('button',{name:'放大文字'}).click();
            assert.equal(await reader.locator('.reader-content').getAttribute('data-reader-size'),'large');
            await reader.getByRole('button',{name:'还原文字'}).click();
            await page.keyboard.press('Escape');
            assert.equal(await reader.isVisible(),false);
            assert.equal(await page.getByRole('button',{name:label,exact:true}).isVisible(),true);
          }
        }
        evidence.cases.push({width,reducedMotion,diameter,selectedMotion:true,branchNavigation:true});
      } finally {await page.close();}
    }
    const invalidCases=[
      ['obsolete-view',config=>{config.schemaVersion=99;}],
      ['unknown-view-node',config=>{config.layout.nodes[0].nodeId='removed-node';}],
      ['wrong-view-edge',config=>{
        const edge=config.layout.edges.find(item=>item.edgeId);
        edge.target=config.layout.nodes.find(node=>node.id!==edge.target&&node.nodeId!==undefined).id;
      }],
    ];
    const invalid=await browser.newPage({offline:true});
    try {
      for(const [name, mutate] of invalidCases){
        const draft=structuredClone(original);
        mutate(draft);
        const encoded=JSON.stringify(draft).replace(/[<>&]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
        const altered=files['workflow.html'].replace(/(<script id="workflow-data" type="application\/json">)[\s\S]*?(<\/script>)/,(_,open,close)=>open+encoded+close);
        assert.deepEqual(readPortableExport({...files,'workflow.html':altered},exportTrust([key.publicKey])),{invalid:true});
        const invalidFile=path.join(temporary,name+'.html');
        await writeFile(invalidFile,altered);
        await invalid.goto(pathToFileURL(invalidFile).href);
        assert.equal(await invalid.locator('#templateError').isVisible(),true);
        assert.equal(await invalid.locator('#edgeLayer .edge-group').count(),0);
      }
      evidence.rejectedViewConfigurations=invalidCases.map(([name])=>name);
    } finally {await invalid.close();}
  } finally {await browser.close();}
  if(process.env.FLOWKIT_BROWSER_EVIDENCE){
    const report=path.resolve(process.env.FLOWKIT_BROWSER_EVIDENCE);
    await mkdir(path.dirname(report),{recursive:true});
    await writeFile(report,JSON.stringify(evidence,null,2)+'\n');
  }
});
