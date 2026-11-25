import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { mergeDesignSections, packDesignScope, planDesignCanvas } from '../../scripts/workflow-viewer/project-design.mjs';
import { defaultLayout, workflowPage } from '../../scripts/workflow-viewer.mjs';

test('a static project opens with real block relationships and unfolds without switching canvases', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flowkit-one-canvas-'));
  const file = path.join(dir, 'design.html');
  let browser;
  t.after(async () => {
    await browser?.close();
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
  });
  const materials = [{ id: 'request', title: '需求依据', content: '提交' },
    { id: 'review', title: '复审依据', content: '复审' }];
  const sections = materials.map((material, i) => {
    const name = i ? '复审处理' : '需求收集';
    const node = index => ({ id: 'step-' + index, name: name + ' ' + index, key: material.id + '-' + index,
      description: '## 按原始材料核对字段\n\n- **保留输出**\n\n| 依据 |\n| --- |\n| 核对证据 |',
      sources: [material.id], subflow: { key: material.id, name } });
    return { id: material.id, title: material.title, ranges: [{ id: material.id, sourceId: material.id, start: 0, end: 6 }],
      proposal: { nodes: Array.from({ length: 26 }, (_, index) => node(index)), edges: [], coverage: [], unresolved: [],
        handoffs: i ? [] : ['通过复审', '需要人工复核'].map(description =>
          ({ from: 'step-0', target: 'review-0', description, sources: [material.id] })) } };
  });
  const data = mergeDesignSections('交付项目图', materials, sections);
  data.design.excerpts = [{ rangeId: 'review', text: '## 复审原文\n\n**核对规则**\n\n<img src="https://outside.invalid/test">', mimeType: 'text/markdown',
    lines: { first: 1, count: 1 } }];
  const { layoutGraphs, ...project } = planDesignCanvas(data.graph, data.design);
  project.positions = layoutGraphs.map(({ id, graph }) => packDesignScope(id, graph, defaultLayout(graph), false));
  assert.equal(project.positions[0].routes.length, 1);
  await writeFile(file, workflowPage({ ...data, project }));
  browser = await chromium.launch({ headless: true, channel: process.env.FLOWKIT_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ offline: true, viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(file).href);
  const origin = await page.evaluate(() => performance.timeOrigin);
  assert.equal(await page.locator('#statNodes').textContent(), '52');
  assert.equal(await page.locator('#statEdges').textContent(), '2');
  assert.equal(await page.locator('#statNodeLabel').textContent(), '节点');
  assert.equal(await page.locator('#statEdgeLabel').textContent(), '流程关系');
  assert.equal(await page.locator('#nodeLayer .node').count(), 2);
  assert.equal(await page.locator('#edgeLayer .edge-group').count(), 1);
  const overviewEdge = page.getByRole('button', { name: '需求收集 → 复审处理' });
  await overviewEdge.press('Enter');
  assert.equal(await page.locator('[data-project-relationship]').count(), 2);
  assert.match(await page.locator('#inspectorBody').textContent(), /通过复审.*需要人工复核/s);
  assert.doesNotMatch(await page.locator('#inspectorSub').evaluate(el => getComputedStyle(el).fontFamily), /Consolas/);
  await page.getByRole('link', { name: '复审处理 0', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#inspectorTitle').textContent === '复审处理 0');
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  assert.match(page.url(), /#node\//);
  assert.equal(await page.locator('#nodeLayer .node').count(), 27);
  const tabs = page.locator('#inspectorNav [data-jump]');
  assert.deepEqual(await tabs.allTextContents(), ['描述', '输入', '输出', '产物', '约束', '校验', '完成', '运行']);
  for (const name of ['描述', '输入', '输出', '产物', '约束', '校验', '完成', '运行']) {
    const tab = tabs.getByText(name, { exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-current'), 'true');
  }
  const panel = page.locator('#inspectorBody');
  assert.match(await panel.locator('#panel-section-description').textContent(), /按原始材料核对字段/);
  assert.equal(await panel.locator('#panel-section-inputs,#panel-section-outputs,#panel-section-artifacts,#panel-section-checks').count(),0);
  assert.match(await panel.locator('#panel-section-completionCriteria').textContent(), /完成条件.*无已取证的后继流转/s);
  assert.match(await panel.locator('#panel-section-execution').textContent(), /未绑定运行.*输入输出契约/);
  assert.match(await panel.textContent(), /材料依据.*复审依据.*字节 0–6/s);
  const officialFont = await page.locator('#inspectorBody .template-items li').first().evaluate(el => {
    const font = getComputedStyle(el);
    return { family: font.fontFamily, weight: font.fontWeight, size: font.fontSize };
  });
  assert.doesNotMatch(officialFont.family, /Consolas/);
  assert.equal(officialFont.weight, '400');
  assert.equal(officialFont.size, '14px');
  assert.match(await page.locator('#inspectorSub').evaluate(el => getComputedStyle(el).fontFamily), /Consolas/);
  const nodeLink = page.url();
  await panel.locator('#panel-section-description').getByRole('button', { name: /专注阅读/ }).click();
  assert.equal(await page.locator('#readerTitle').textContent(), '节点描述');
  assert.equal(await page.locator('#readerContent h2').textContent(), '按原始材料核对字段');
  assert.equal(await page.getByRole('button', { name: '放大文字' }).count(), 0);
  assert.equal(await page.locator('#readerSearch').evaluate(el => getComputedStyle(el).fontSize), '13px');
  await page.locator('#readerSearch').fill('核对证据');
  await page.locator('#readerSearch').press('Enter');
  assert.equal(await page.locator('#readerContent td.reader-match').textContent(), '核对证据');
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: '复审依据 · 字节 0–6' }).click();
  assert.equal(await page.locator('#readerContent h2').textContent(), '复审原文');
  assert.equal(await page.locator('#readerContent img').count(), 0);
  assert.match(await page.locator('#readerContent').innerText(), /<img src=/);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: '复审依据', exact: true }).click();
  assert.match(await page.locator('#readerContent').innerText(), /原文件未随离线图提供/);
  await page.keyboard.press('Escape');
  await panel.locator('#panel-section-upstream').getByRole('link', { name: /需求收集 0.*通过复审/s }).click();
  await page.waitForFunction(() => document.querySelector('#inspectorTitle').textContent === '需求收集 0');
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  assert.match(await panel.locator('#panel-section-downstream').textContent(), /通过复审.*需要人工复核/s);
  await page.getByRole('button', { name: '折叠 需求收集', exact: true }).press('Enter');
  await page.getByRole('button', { name: '折叠 复审处理', exact: true }).press('Enter');
  assert.equal(await page.locator('#nodeLayer .node').count(), 2);
  await page.getByRole('button', { name: '展开 需求收集', exact: true }).press('Enter');
  assert.equal(await page.locator('#nodeLayer .node').count(), 27);
  const search = page.getByRole('combobox', { name: '搜索节点名称或 ID' });
  await search.fill('复审处理');
  assert.equal(await page.getByRole('option').and(page.locator('.node-search-option')).count(), 12);
  await search.press('ArrowDown');
  assert.match(await search.getAttribute('aria-activedescendant'), /nodeSearchOption-0/);
  await search.press('Escape');
  assert.equal(await search.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#nodeLayer .node').count(), 27);
  await search.fill('review-25');
  await search.press('ArrowDown');
  await search.press('Enter');
  assert.equal(await page.locator('#inspectorTitle').textContent(), '复审处理 25');
  assert.equal(await page.evaluate(() => performance.timeOrigin), origin);
  const deepLink = await browser.newPage({ offline: true, viewport: { width: 900, height: 1000 } });
  deepLink.on('pageerror', error => errors.push(error.message));
  await deepLink.goto(nodeLink);
  assert.equal(await deepLink.locator('#inspectorTitle').textContent(), '复审处理 0');
  assert.deepEqual(errors, []);
});
