import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compile } from '../dist/index.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),examples=path.join(root,'examples');
const manifest=JSON.parse(await readFile(path.join(examples,'manifest.json'),'utf8'));
const workflows=['editorial.workflow.js','shared-join.workflow.ts','remote.workflow.js'];
const expected=[...workflows,...['editorial','shared-join','remote'].flatMap(name=>[`${name}.compiled.mjs`,`${name}.mmd`]),
  'skills/writer.md','skills/style.md','skills/fact.md','host.mjs','demo.mjs','agent.mjs'].sort();
assert.deepEqual(manifest.workflows.map(item=>item.source),workflows);
assert.deepEqual(manifest.files.map(item=>item.path).sort(),expected);
const remoteSource=await readFile(path.join(examples,'remote.workflow.js'),'utf8');
for(const skill of manifest.remoteSkills){
  assert.ok(['skills/style.md','skills/fact.md'].includes(skill.local));
  const bytes=await readFile(path.join(examples,skill.local));
  const integrity=`sha256-${createHash('sha256').update(bytes).digest('base64')}`;
  assert.ok(remoteSource.includes(integrity),`Review and update the DSL integrity for ${skill.local} before refreshing goldens`);
  skill.integrity=integrity;
}
// Generate through the public API; original workflow and Skill bytes are never rewritten.
for(const source of workflows){
  const result=await compile(path.join(examples,source),{projectRoot:examples,remoteSkillHosts:['skills.example.test']});
  assert.deepEqual(result.diagnostics,[],source);
}
for(const item of manifest.files){const bytes=await readFile(path.join(examples,item.path));item.bytes=bytes.length;item.sha256=createHash('sha256').update(bytes).digest('hex');}
await writeFile(path.join(examples,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({workflows:workflows.length,files:manifest.files.length,originalDefinitionsPreserved:true}));
