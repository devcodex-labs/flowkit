import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileArtifact, compileSource, evalWhen, isControlSignal, runArtifact } from '../../src/index.mjs';
import { createWorkflowAuthor } from '../../src/author/author.mjs';
import { runApprovedCollectionWorkflow } from '../../src/author/approved-run.mjs';
import { createOpenAINativeSkillPort } from '../../src/author/openai-native-skills.mjs';
import { stageCollectionForDiscovery,removeCollectionGeneration } from '../../src/author/collection-layout.mjs';
import { collectionSkill, planCollectionRename, planNewCollection, verifiedCollectionPlan } from '../../src/author/collections.mjs';
import { authorIdentity } from '../../src/author/host-target.mjs';
import { openLocalSkillStore } from '../../src/author/local-skill-store.mjs';
import { planProfessionalSkills, prepareProfessionalSkill, publishProfessionalSkill } from '../../src/author/professional-skills.mjs';
import { startAuthorDraft } from '../../src/author/draft.mjs';
import { createWorkflowPlan } from '../../src/author/workflow-plan.mjs';
import { prepareStandardSkill, publishStandardSkill,reviewStandardCandidate } from '../../src/author/standard-artifact.mjs';
import { artifactDigest } from '../../src/shared/artifact-identity.mjs';

const source = `import { defineWorkflow, action, terminal } from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({ id: 'example', version: '1.0.0', name: 'Example', nodes: [
  action('work', { name: 'Work', action: 'inspect', next: 'done' }),
  terminal('done', { name: 'Done', status: 'succeeded' })
] });\n`;
const hostProfile = { id: 'test-host', digest: artifactDigest('local capability fixture') };

async function fixture(t, text = source, close = () => {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowkit-author-'));
  t.after(async () => {
    close();
    await rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'example.workflow.js');
  await writeFile(file, text);
  return { dir, options: { file, collectionId: 'team-id', skillId: 'example-id', name: 'example',
    description: 'Workflow: "Inspect"\n---', version: '1.0.0', hostProfile, buildId: 'test-build' } };
}

test('Standard candidate uses real Compiler output, has three files, and runs twice without the source', async t => {
  const { dir, options } = await fixture(t);
  const { candidate, diagnostics } = await prepareStandardSkill(options);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(await readdir(dir), ['example.workflow.js']);
  assert.deepEqual(Object.keys(candidate.files), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  const compiled = await compileArtifact(options.file);
  assert.equal(candidate.files['workflow.js'], compiled.code);
  assert.equal(candidate.files['workflow.mmd'], compiled.mermaid);
  assert.match(compiled.mermaid, /Work\["Work"\][\s\S]*Done\("Done"\)[\s\S]*Work --> Done/);
  assert.match(candidate.files['SKILL.md'], /name: example\ndescription: "Workflow:/);
  assert.doesNotMatch(candidate.files['SKILL.md'], /flowkit-workflow-author/);
  assert.equal(candidate.manifest.artifactHash, compiled.artifactHash);
  assert.equal(candidate.manifest.sourceHash, artifactDigest(source));
  assert.deepEqual(candidate.manifest.hostProfile, hostProfile);
  for (const [file, bytes] of Object.entries(candidate.files)) await writeFile(path.join(dir, file), bytes);
  await unlink(options.file);
  const calls = [];
  for (const runId of ['first', 'second']) {
    const result = await runArtifact(path.join(dir, 'workflow.js'), compiled.artifactHash,
      { isControlSignal, runAction: async id => { calls.push(id); } }, {}, { runId });
    assert.equal(result.terminal, 'done');
    assert.equal(artifactDigest(await readFile(path.join(dir, 'workflow.mmd'))), candidate.manifest.files['workflow.mmd']);
  }
  assert.deepEqual(calls, ['inspect', 'inspect']);
});

test('source retention preserves original UTF-8 bytes and compile errors leave no candidate', async t => {
  const text = '\uFEFF' + source.replaceAll('\n', '\r\n');
  const { dir, options } = await fixture(t, text);
  const { candidate } = await prepareStandardSkill({ ...options, includeSource: true });
  assert.equal(candidate.files['source/workflow.dsl.js'], text);
  assert.equal(candidate.manifest.files['source/workflow.dsl.js'], candidate.manifest.sourceHash);
  await writeFile(options.file, 'invalid workflow');
  const rejected = await prepareStandardSkill(options);
  assert.equal(rejected.candidate, null);
  assert.ok(rejected.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
  assert.deepEqual(await readdir(dir), ['example.workflow.js']);
});

test('workflow-specific references and actual read document provenance remain bound to reviewed candidate bytes',async t=>{
  const {options}=await fixture(t);
  const bytes=Buffer.from('Reviewed compiler contract');const url='https://example.invalid/pinned/compile.md';
  const pin={capabilityId:'flowkit::compile-workflow',documentId:'compiler',revision:'revision-1',contentHash:artifactDigest(bytes),url};
  let revision='revision-1',content=bytes;
  const author=createWorkflowAuthor({capabilityGraph:{async getCapabilities(){return {meta:{revision,completeness:'complete'},items:[
    {capability:{id:pin.capabilityId,documents:[{id:pin.documentId,source:{type:'url',url}}]}}]};}},
    readDocumentUrl:async()=>({url,bytes:content})});
  const evidence=(await author.readDocument(pin)).evidence;
  const draft=author.start('Inspect',{executionMode:'standard'});
  const plan=await author.plan(draft,{intentRef:{effectiveIntentHash:artifactDigest('intent')},coverage:'complete',issues:[],unresolved:[],
    goals:[{id:'goal'}],constraints:[]},{entryNodeId:'work',nodes:[{id:'work',kind:'action'},{id:'done',kind:'terminal'}],
    edges:[{from:'work',to:'done',kind:'control'}],coverage:[{intentId:'goal',status:'covered',coveredBy:['work']}]});
  const refs={'references/decision.md':'Workflow-specific decision'};
  const candidate=(await author.prepare(plan,{...options,references:refs})).candidate;
  assert.deepEqual(candidate.manifest.documents,[evidence]);assert.match(candidate.files['SKILL.md'],/Reviewed documentation/);
  assert.equal(candidate.files['references/decision.md'],refs['references/decision.md']);
  assert.equal(candidate.manifest.files['references/decision.md'],artifactDigest(refs['references/decision.md']));
  content=Buffer.from('changed');await assert.rejects(author.prepare(plan,options),/content differs/);content=bytes;
  revision='revision-2';await assert.rejects(author.prepare(plan,options),/revision differs/);
  await assert.rejects(prepareStandardSkill({...options,references:{'references/skills/other/SKILL.md':'nested'}}),/workflow-specific/);
  assert.deepEqual(Object.keys((await prepareStandardSkill(options)).candidate.files),['SKILL.md','workflow.js','workflow.mmd']);
  const changed=(await prepareStandardSkill({...options,version:'2.0.0'})).candidate;
  assert.ok(reviewStandardCandidate(changed,candidate).files.some(file=>file.path==='references/decision.md'));
  assert.deepEqual(changed.manifest.workflowDefinition.nodes.map(node=>node.id),['work','done']);
});

test('generation uninstall removes only an unchanged approved adapter scope and preserves user Skills',async t=>{
  let store;const {dir,options}=await fixture(t,source,()=>store?.close());
  store=openLocalSkillStore(path.join(dir,'cleanup.sqlite'),()=>true,()=>true);
  const plan=planNewCollection({name:'cleanup-flows',source:{id:options.collectionId},preserveId:true},[],()=>null);
  store.applyCollectionPlan(plan,'approved');
  const candidate=(await prepareStandardSkill(options)).candidate;
  await publishStandardSkill(candidate,{reviewRef:'review',approvalRef:'approval',previousHash:null},store);
  const root=path.join(dir,'managed');const generation=await stageCollectionForDiscovery(store,options.collectionId,root);
  const userFile=path.join(dir,'user-skill.md');await writeFile(userFile,'keep original');
  const input={hostOwnedRoot:root,discoveryRoot:generation.discoveryRoot,collectionId:options.collectionId,
    authorizeRemoval:({manifestHash})=>manifestHash===generation.manifestHash};
  await assert.rejects(removeCollectionGeneration({...input,discoveryRoot:dir}));
  await assert.rejects(removeCollectionGeneration({...input,authorizeRemoval:()=>false}),/denied/);
  const foreign=path.join(generation.directory,'user-added.md');await writeFile(foreign,'keep user addition');
  await assert.rejects(removeCollectionGeneration(input),/user-owned/);
  assert.equal(await readFile(foreign,'utf8'),'keep user addition');await unlink(foreign);
  await removeCollectionGeneration(process.platform==='win32'?{...input,hostOwnedRoot:root.toUpperCase(),
    discoveryRoot:generation.discoveryRoot.toUpperCase()}:input);
  assert.equal(await readFile(userFile,'utf8'),'keep original');
  assert.equal(store.readVersion(options.collectionId,options.skillId,candidate.hash).hash,candidate.hash);
});

test('Author rejects uncontrolled any writes, unlimited Human revisions and an omitted planned control edge',async t=>{
  const any=`import {defineWorkflow,parallel,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'any-writes',name:'Any',version:'1.0.0',nodes:[
parallel('race',{name:'Race',branches:['one','two'],join:{strategy:'any',next:'done'}}),
action('one',{name:'One',action:'write-one'}),action('two',{name:'Two',action:'write-two'}),
terminal('done',{name:'Done',status:'succeeded'})]});`;
  const {options}=await fixture(t,any);
  await assert.rejects(prepareStandardSkill(options),/Host-approved policy/);
  await assert.rejects(prepareStandardSkill({...options,safetyPolicies:[{nodeId:'race',policyRef:'claimed'}],verifySafetyPolicy:()=>false}),/Host-approved/);
  const allowed=await prepareStandardSkill({...options,safetyPolicies:[{nodeId:'race',policyRef:'checked'}],verifySafetyPolicy:request=>{
    assert.ok(request.artifactHash.startsWith('sha256:'));assert.equal(request.branches.length,2);return true;}});
  assert.deepEqual(allowed.candidate.manifest.safetyPolicies,[{nodeId:'race',policyRef:'checked'}]);
  const human=`import {defineWorkflow,human,action,terminal} from '@devcodex-labs/flowkit/dsl';
export default defineWorkflow({id:'review',name:'Review',version:'1.0.0',nodes:[
human('review',{name:'Review',onApprove:'done',onReject:'revise'}),
action('revise',{name:'Revise',action:'revise',next:'review'}),terminal('done',{name:'Done',status:'succeeded'})]});`;
  await writeFile(options.file,human);await assert.rejects(prepareStandardSkill(options),/finite maxRevisions/);
  await writeFile(options.file,human.replace("name:'Review',onApprove","name:'Review',maxRevisions:2,onApprove"));
  assert.ok((await prepareStandardSkill(options)).candidate);
  await writeFile(options.file,source);
  const author=createWorkflowAuthor({});const draft=author.start('Inspect',{executionMode:'standard'});
  const plan=await author.plan(draft,{intentRef:{effectiveIntentHash:artifactDigest('intent')},coverage:'complete',issues:[],unresolved:[],
    goals:[{id:'inspect'}],constraints:[]},{entryNodeId:'work',nodes:[{id:'work',kind:'action'},{id:'done',kind:'terminal'}],
    edges:[],coverage:[{intentId:'inspect',status:'covered',coveredBy:['work']}]});
  await assert.rejects(author.prepare(plan,options),/control flow differs/);
});

test('required Professional Skills must bind exact choices from the compiled definition', async t => {
  const { options } = await fixture(t, source.replace('defineWorkflow, action, terminal', 'defineWorkflow, node, terminal')
    .replace("action('work', { name: 'Work', action: 'inspect', next: 'done' })",
      `node('work', { name: 'Work', description: 'Inspect', requiredSkills: [{ id: 'inspect', version: '1.2.0' }],
        output: { type: 'object' }, next: 'done' })`));
  const pin = { nodeId: 'work', id: 'inspect', version: '1.2.0', digest: artifactDigest('selected bytes') };
  await assert.rejects(prepareStandardSkill(options), /Missing matching Professional Skill/);
  await assert.rejects(prepareStandardSkill({ ...options, professionalSkills: [{ ...pin, version: '2.0.0' }] }), /Missing matching/);
  const { candidate } = await prepareStandardSkill({ ...options, professionalSkills: [pin] });
  assert.deepEqual(candidate.manifest.professionalSkills, [pin]);
});

test('publish checks unchanged candidate bytes and delegates approved conditional commit to the Host', async t => {
  const { options } = await fixture(t);
  const { candidate } = await prepareStandardSkill(options);
  const refs = { reviewRef: 'review', approvalRef: 'approval', previousHash: null };
  let published = null;
  const host = { async publishAtomically({ candidate: entry, reviewRef, approvalRef, previousHash }) {
    assert.equal(reviewRef, refs.reviewRef);
    assert.equal(approvalRef, refs.approvalRef);
    assert.equal(entry.hash, candidate.hash);
    if (previousHash !== (published?.hash ?? null)) throw new Error('Candidate changed');
    published = entry;
    return entry.hash;
  } };
  await assert.rejects(publishStandardSkill(candidate, { ...refs, approvalRef: '' }, host), /requires review, approval/);
  await assert.rejects(publishStandardSkill({ ...candidate, files: { ...candidate.files, 'workflow.mmd': 'changed' } }, refs, host), /differ/);
  assert.equal(published, null);
  assert.equal(await publishStandardSkill(candidate, refs, host), candidate.hash);
  await assert.rejects(publishStandardSkill(candidate, refs, host), /Candidate changed/);
  assert.equal(published.hash, candidate.hash);
});

test('collection previews keep two layers, scope Skill IDs, and reject name or migration ID conflicts', () => {
  const free = () => null;
  const { destination: first } = planNewCollection({}, [], free);
  assert.equal(first.directory, 'flowkit-workflows');
  assert.match(first.rootSkill, /\nname: flowkit-workflows\n/);
  const source = first;
  const { destination: copy } = planNewCollection({ source, name: 'team-copy' }, [first], free);
  assert.notEqual(copy.id, first.id);
  const { destination: moved } = planNewCollection({ source, name: 'team-move', preserveId: true }, [copy], free);
  assert.equal(moved.id, first.id);
  assert.throws(() => planNewCollection({ source, name: 'another', preserveId: true }, [first], free), /belongs to/);
  assert.throws(() => planNewCollection({ name: 'team-copy' }, [copy], free), /in use/);
  assert.throws(() => planNewCollection({}, [], () => 'unmanaged collection'), /occupied/);
  assert.throws(() => planNewCollection({ name: 'com1' }, [], free), /portable Skill name/);
  const item = { id: 'inspect', name: 'inspect' };
  const original = collectionSkill(first, item);
  assert.notEqual(original.collectionId, collectionSkill(copy, item).collectionId);
  assert.equal(original.directory, 'flowkit-workflows/skills/inspect');
  const rename = planCollectionRename({ id: first.id, name: 'team-move' }, [first, copy], {
    directoryOwner: free,
    previewMigration: () => ({ expectedSnapshotHash: 'sha256:' + '0'.repeat(64), hostMapping: ['old', 'next'], mcpResources: [], workflowReferences: [] })
  });
  const renamed = collectionSkill(rename.destination, item);
  assert.deepEqual(rename.directory, ['flowkit-workflows', 'team-move']);
  assert.deepEqual(rename.hostMapping, ['old', 'next']);
  assert.deepEqual(renamed, { ...original, directory: 'team-move/skills/inspect' });
});

test('file-backed Host store gives readers complete approved versions and rolls back rejected commits', async t => {
  let writer;
  let reader;
  const { dir, options } = await fixture(t, source, () => { reader?.close(); writer?.close(); });
  const file = path.join(dir, 'host.sqlite');
  const approvals = new Map();
  const verify = ({ collectionId, skillId, candidateHash, reviewRef, approvalRef, previousHash }) => {
    const receipt = approvals.get(approvalRef);
    return receipt?.reviewRef === reviewRef && receipt?.hash === candidateHash && receipt?.previousHash === previousHash &&
      receipt?.scope === `${collectionId}/${skillId}`;
  };
  writer = openLocalSkillStore(file, verify);
  reader = openLocalSkillStore(file, verify);
  async function candidate(overrides, previousHash = null) {
    const prepared = (await prepareStandardSkill({ ...options, ...overrides })).candidate;
    const { collectionId, skillId } = prepared.manifest;
    const refs = { reviewRef: `review-${prepared.hash}`, approvalRef: `approval-${prepared.hash}`, previousHash };
    approvals.set(refs.approvalRef, { ...refs, scope: `${collectionId}/${skillId}`, hash: prepared.hash });
    return { prepared, refs };
  }
  const first = await candidate({});
  const { collectionId, skillId } = options;
  assert.equal(reader.readActive(collectionId, skillId), null);
  await assert.rejects(publishStandardSkill(first.prepared, { ...first.refs, reviewRef: 'other-review' }, writer), /Host denied/);
  assert.equal(reader.readActive(collectionId, skillId), null);
  await publishStandardSkill(first.prepared, first.refs, writer);
  assert.deepEqual(reader.readActive(collectionId, skillId), first.prepared);
  await writeFile(options.file, source.replace("action('work'", "action('a-1'").replaceAll("'done'", "'a1'"));
  const graphFailure = await prepareStandardSkill({ ...options, version: '2.0.0' });
  assert.equal(graphFailure.candidate, null);
  assert.ok(graphFailure.diagnostics.some(diagnostic => diagnostic.code === 'FK_C090'));
  assert.deepEqual(reader.readActive(collectionId, skillId), first.prepared);
  await writeFile(options.file, source);
  assert.equal(reader.readActive('another-team', skillId), null);
  const collision = await candidate({ skillId: 'another-skill-id' });
  await assert.rejects(publishStandardSkill(collision.prepared, collision.refs, writer), /UNIQUE constraint failed/);
  assert.equal(reader.readVersion(collectionId, 'another-skill-id', collision.prepared.hash), null);
  assert.deepEqual(reader.readActive(collectionId, skillId), first.prepared);
  const second = await candidate({ version: '2.0.0' }, first.prepared.hash);
  const stale = await candidate({ version: '3.0.0' }, first.prepared.hash);
  await publishStandardSkill(second.prepared, second.refs, writer);
  await assert.rejects(publishStandardSkill(stale.prepared, stale.refs, reader), /Active workflow changed/);
  assert.deepEqual(reader.readActive(collectionId, skillId), second.prepared);
  assert.deepEqual(reader.readVersion(collectionId, skillId, first.prepared.hash), first.prepared);
  assert.equal(await publishStandardSkill(second.prepared, second.refs, writer), second.prepared.hash);
});

test('an interrupted SQLite publication leaves the complete old version visible before and after restart', async t => {
  let store;
  const { dir, options } = await fixture(t, source, () => store?.close());
  const dbPath = path.join(dir, 'workflow-store.sqlite');
  const { candidate: first } = await prepareStandardSkill(options);
  const { candidate: second } = await prepareStandardSkill({ ...options, version: '2.0.0' });
  store = openLocalSkillStore(dbPath, request => request.candidateHash === first.hash);
  await publishStandardSkill(first, { reviewRef: 'review', approvalRef: 'approval', previousHash: null }, store);
  const payload = path.join(dir, 'next-candidate.json');
  await writeFile(payload, JSON.stringify(second));
  // Leave the same database mutations as publication pending, then terminate the writer before COMMIT.
  const writer = `
    import { DatabaseSync } from 'node:sqlite';
    import { readFileSync } from 'node:fs';
    const db = new DatabaseSync(process.argv[1]);
    const text = readFileSync(process.argv[2], 'utf8');
    const { hash, manifest: { collectionId, skillId, version } } = JSON.parse(text);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO fk_author_versions VALUES (?, ?, ?, ?, ?)').run(collectionId, skillId, hash, version, text);
    db.prepare('UPDATE fk_author_active SET candidate_hash = ? WHERE collection_id = ? AND skill_id = ?').run(hash, collectionId, skillId);
    process.stdout.write('uncommitted');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', writer, dbPath, payload], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  try {
    const [ready] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    assert.equal(String(ready), 'uncommitted');
    assert.deepEqual(store.readActive(options.collectionId, options.skillId), first);
    assert.equal(store.readVersion(options.collectionId, options.skillId, second.hash), null);
  } finally {
    child.kill();
    await exited;
  }
  store.close();
  store = openLocalSkillStore(dbPath, () => false);
  assert.deepEqual(store.readActive(options.collectionId, options.skillId), first);
  assert.equal(store.readVersion(options.collectionId, options.skillId, second.hash), null);
});

test('approved collection generation exposes a two-layer tree and preserves previous physical versions across renames', async t => {
  let store;
  const { dir, options } = await fixture(t, source, () => store?.close());
  const grants = new Map();
  const hostReadRoot = path.join(dir, 'host-staged-layouts');
  store = openLocalSkillStore(path.join(dir, 'collection.sqlite'),
    ({ candidateHash, approvalRef, reviewRef }) => grants.get(approvalRef) === candidateHash && reviewRef === 'reviewed',
    ({ planHash, approvalRef }) => grants.get(approvalRef) === planHash);
  const initial = planNewCollection({ name: 'project-flows' }, [], () => null);
  const { id } = initial.destination;
  await assert.rejects(stageCollectionForDiscovery(store, id, hostReadRoot), /no approved collection/);
  assert.throws(() => store.applyCollectionPlan(initial, 'unconfirmed'), /Host denied/);
  grants.set('init', verifiedCollectionPlan(initial).planHash);
  store.applyCollectionPlan(initial, 'init');
  const empty = await stageCollectionForDiscovery(store, id, hostReadRoot);
  assert.deepEqual((await readdir(empty.directory)).sort(), ['SKILL.md', 'skills']);
  assert.deepEqual(await readdir(path.join(empty.directory, 'skills')), []);

  const { candidate } = await prepareStandardSkill({ ...options, collectionId: id });
  await assert.rejects(publishStandardSkill(candidate, { reviewRef: 'reviewed', approvalRef: 'pending', previousHash: null }, store), /Host denied/);
  grants.set('workflow', candidate.hash);
  await publishStandardSkill(candidate, { reviewRef: 'reviewed', approvalRef: 'workflow', previousHash: null }, store);
  const metadata = { id: 'review', name: 'review', description: 'Review project changes', version: '1.0.0', body: '# Review changes' };
  assert.throws(() => prepareProfessionalSkill(initial.destination,
    { ...metadata, resources: { 'references/skills/another.md': 'invalid' } }), /portable resource paths/);
  const professional = prepareProfessionalSkill(initial.destination,
    { ...metadata, resources: { 'references/checklist.md': 'Review the public API.' } });
  grants.set('professional', professional.hash);
  await publishProfessionalSkill(professional, { reviewRef: 'reviewed', approvalRef: 'professional', previousHash: null }, store);
  const approved = await stageCollectionForDiscovery(store, id, hostReadRoot);
  const original = path.join(approved.directory, 'skills', options.name);
  const professionalDir = path.join(approved.directory, 'skills', 'review');
  assert.deepEqual((await readdir(original)).sort(), ['SKILL.md', 'workflow.js', 'workflow.mmd']);
  assert.deepEqual((await readdir(professionalDir)).sort(), ['SKILL.md', 'references']);
  assert.equal(await readFile(path.join(professionalDir, 'references', 'checklist.md'), 'utf8'), 'Review the public API.');
  assert.equal(artifactDigest(await readFile(path.join(original, 'workflow.js'))), candidate.manifest.artifactHash);
  const identity = { collectionId: id, skillId: options.skillId, candidateHash: candidate.hash,
    skillDirectory: original, executionRef: 'allow-run' };
  const actions = [];
  const host = { hostProfile, authorizeExecution: ({ executionRef, artifactHash, collectionId }) =>
    executionRef === 'allow-run' && artifactHash === candidate.manifest.artifactHash && collectionId === id,
  runtime: { isControlSignal, async runAction(action) { actions.push(action); } } };
  await assert.rejects(runApprovedCollectionWorkflow(store, { ...identity, executionRef: 'denied' }, host), /Host denied/);
  assert.deepEqual(actions, []);
  assert.equal((await runApprovedCollectionWorkflow(store, identity, host)).terminal, 'done');
  assert.deepEqual(actions, ['inspect']);
  assert.deepEqual(await readdir(path.join(empty.directory, 'skills')), []);

  const migrate = planCollectionRename({ id, name: 'team-flows' }, [initial.destination], {
    directoryOwner: () => null,
    previewMigration: () => ({ expectedSnapshotHash: authorIdentity(store.readCollectionMetadata(id)), hostMapping: ['project-flows', 'team-flows'], workflowReferences: [], mcpResources: [] })
  });
  grants.set('rename', verifiedCollectionPlan(migrate).planHash);
  store.applyCollectionPlan(migrate, 'rename');
  const current = await stageCollectionForDiscovery(store, id, hostReadRoot);
  assert.equal(path.basename(current.directory), 'team-flows');
  assert.deepEqual(current.skills, approved.skills);
  assert.match(await readFile(path.join(current.directory, 'SKILL.md'), 'utf8'), /name: team-flows/);
  assert.equal(artifactDigest(await readFile(path.join(original, 'workflow.js'))), candidate.manifest.artifactHash);
  assert.deepEqual(store.readVersion(id, options.skillId, candidate.hash), candidate);
  assert.throws(() => store.applyCollectionPlan(migrate, 'rename'), /changed after review/);
});

test('an approved Run refuses resource version or digest drift before delegating to the model', async t => {
  const agent = source.replace('defineWorkflow, action, terminal', 'defineWorkflow, node, terminal')
    .replace("action('work', { name: 'Work', action: 'inspect', next: 'done' })",
      `node('work', { name: 'Inspect', description: 'Inspect', requiredSkills: [{ id: 'inspect', version: '1.2.0' }],
        output: { type: 'object' }, next: 'done' })`);
  const { dir, options } = await fixture(t, agent);
  const pin = { nodeId: 'work', id: 'inspect', version: '1.2.0', digest: artifactDigest('exact resource') };
  const { candidate } = await prepareStandardSkill({ ...options, professionalSkills: [pin] });
  await writeFile(path.join(dir, 'workflow.js'), candidate.files['workflow.js']);
  const store = openLocalSkillStore(path.join(dir, 'verification.sqlite'), request => request.candidateHash === candidate.hash);
  try {
    await publishStandardSkill(candidate, { reviewRef: 'review', approvalRef: 'approve', previousHash: null }, store);
    const target = { collectionId: options.collectionId, skillId: options.skillId, candidateHash: candidate.hash,
      skillDirectory: dir, executionRef: 'run' };
    let calls = 0;
    let returnedDigest = artifactDigest('other resource version');
    const runtime = { isControlSignal, validateResult: () => [],
      taskPolicy: { hostProfile: { schemaVersion: 1, executionModes: ['standard'], capabilities: { skillResourceLoading: 'supported' } } },
      prepareAgentTask: async (task, context) => ({ protocolVersion: 2, task, descriptionResources: context.descriptionResources,
        skills: [{ logicalId: pin.id, resolvedVersion: pin.version, digest: returnedDigest }] }),
      runAgentTask: async () => { calls++; return { status: 'succeeded', result: {}, events: [] }; } };
    const host = { hostProfile, authorizeExecution: () => true, runtime };
    await assert.rejects(runApprovedCollectionWorkflow(store, target, host), /differ from the approved Run bindings/);
    assert.equal(calls, 0);
    returnedDigest = pin.digest;
    const result = await runApprovedCollectionWorkflow(store, target, host);
    assert.equal(result.terminal, 'done');
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('OpenAI native Skill transport scopes the upload and verifies the published version before building a reference', async () => {
  const collection = planNewCollection({ name: 'team' }, [], () => null).destination;
  const candidate = prepareProfessionalSkill(collection, { id: 'review', name: 'review-sample', description: 'Review a synthetic result',
    version: '1.0.0', body: '# Review the result', resources: { 'references/checklist.md': 'Confirm outcome' } });
  const requests = [];
  let responseVersion = '2';
  const port = createOpenAINativeSkillPort({ visibilityDelaysMs: [0],
    authorizeUpload: ({ approvalRef, candidateHash, collectionId }) =>
      approvalRef === 'approved' && candidateHash === candidate.hash && collectionId === collection.id,
    async request(endpoint, { method, body }) {
      requests.push([method, endpoint]);
      if (method === 'POST') {
        assert.equal(endpoint, '/v1/skills');
        const files = body.getAll('files[]');
        assert.deepEqual(files.map(file => file.name), ['review-sample/SKILL.md', 'review-sample/references/checklist.md']);
        assert.equal(await files[1].text(), 'Confirm outcome');
        return Response.json({ object: 'skill', name: 'review-sample', id: 'skill_example', default_version: '2' });
      }
      assert.equal(endpoint, '/v1/skills/skill_example/versions/2');
      if (requests.length === 2) return new Response(null, { status: 404 });
      return Response.json({ object: 'skill.version', name: 'review-sample', id: 'version_example', skill_id: 'skill_example', version: responseVersion });
    }
  });
  await assert.rejects(port.upload(candidate, 'denied'), /denied/);
  assert.deepEqual(requests, []);
  const uploaded = await port.upload(candidate, 'approved');
  assert.equal(uploaded.candidateHash, candidate.hash);
  assert.deepEqual(await port.prepareMount(uploaded), { reference: { type: 'skill_reference', skill_id: 'skill_example', version: '2' },
    versionId: 'version_example', activation: 'unobserved' });
  assert.deepEqual(requests.map(([method]) => method), ['POST', 'GET', 'GET']);
  await assert.rejects(port.prepareMount({ ...uploaded, nativeVersion: 'latest' }), /precise provider version/);
  responseVersion = '3';
  await assert.rejects(port.prepareMount(uploaded), /different Skill version/);
  assert.deepEqual(requests.map(([method]) => method), ['POST', 'GET', 'GET', 'GET']);
});

test('Professional Skill planning reads only matching authorized second-layer bodies and reuses one Skill', async () => {
  const { destination: collection } = planNewCollection({ name: 'team' }, [], () => null);
  const digest = artifactDigest('test skill files');
  const skill = { collectionId: collection.id, id: 'review', name: 'review', kind: 'professional',
    path: 'team/skills/review/SKILL.md', description: 'Review changes', version: '1.0.0', digest };
  const read = [];
  const pages = [];
  const host = {
    listProfessionalMetadata({ collectionId, cursor }) {
      assert.equal(collectionId, collection.id);
      pages.push(cursor);
      if (cursor === null) return { items: [
        { ...skill, collectionId: 'other-collection' },
        { ...skill, name: 'nested', path: 'team/skills/review/skills/nested/SKILL.md' },
        { ...skill, name: 'scripts', path: 'team/skills/scripts/SKILL.md' },
        { ...skill, name: 'workflow', kind: 'workflow', path: 'team/skills/workflow/SKILL.md' },
      ], nextCursor: 'next' };
      return { items: [skill], nextCursor: null };
    },
    matchesMetadata: (need, item) => need.id.includes('review') && item.description === 'Review changes',
    readProfessionalSkill: ({ skillId }) => { read.push(skillId); return 'Review changes and tests'; },
    confirmApplicability: (_need, body) => body.includes('and tests')
  };
  const budget = { maxPages: 2, maxBodies: 1 };
  assert.deepEqual(await planProfessionalSkills(collection, { id: 'work', professionalNeeds: [] }, host, budget),
    { reuse: [], unmatched: [], conflicts: [] });
  assert.deepEqual(pages, []);
  const plan = await planProfessionalSkills(collection, { id: 'work', professionalNeeds: [{ id: 'review-api' },
    { id: 'review-tests' }, { id: 'translate' }] }, host, budget);
  assert.deepEqual(plan, { reuse: [{ nodeId: 'work', id: 'review', version: '1.0.0', digest }],
    unmatched: [{ id: 'translate' }], conflicts: [] });
  assert.deepEqual(read, ['review']);
  assert.deepEqual(pages, [null, 'next']);
  await assert.rejects(planProfessionalSkills(collection, { id: 'work', professionalNeeds: [{ id: 'review' }] }, host,
    { ...budget, maxPages: 1 }), /exhausted its page budget/);
});

test('candidate retains the effective intent and Plan identity and rejects a changed entry', async t => {
  const { options } = await fixture(t);
  const draft = startAuthorDraft('Inspect', { executionMode: 'standard' });
  const intentRef = { effectiveIntentHash: artifactDigest('intent fixture') };
  const intent = { intentRef, coverage: 'complete', issues: [], unresolved: [], goals: [{ id: 'inspect' }], constraints: [] };
  const proposal = { entryNodeId: 'work', nodes: [{ id: 'work', kind: 'action' }, { id: 'done', kind: 'terminal' }],
    edges: [{ from: 'work', to: 'done', kind: 'control' }], coverage: [{ intentId: 'inspect', status: 'covered', coveredBy: ['work'] }] };
  const author = createWorkflowAuthor({});
  await assert.rejects(author.prepare(undefined, options), /current WorkflowPlan is required/);
  const blocked = await author.plan(draft, intent, { ...proposal, capabilityRequirements: ['flowkit::compile-workflow'] });
  assert.equal(blocked.status, 'needs-clarification');
  await assert.rejects(author.prepare(blocked, options), /current Standard WorkflowPlan is required/);
  const plan = await author.plan(draft, intent, proposal);
  const { candidate } = await author.prepare(plan, options);
  assert.deepEqual(candidate.manifest.planRef, { ...intentRef, planId: draft.id, revision: 1, planHash: plan.planHash });
  const { candidate: updated } = await author.prepare(plan, { ...options, version: '2.0.0', includeSource: true });
  const review = author.review(updated, candidate);
  assert.equal(review.previousHash, candidate.hash);
  assert.equal(review.candidateVersion, '2.0.0');
  assert.deepEqual(review.files, [{ path: 'source/workflow.dsl.js', previousHash: null, candidateHash: updated.manifest.sourceHash }]);
  const upstream = createWorkflowAuthor({ publicationHost: { verifyImport: ({ sourceRef, sourceHash }) =>
    sourceRef === 'trusted-source-receipt' && sourceHash === candidate.hash } });
  const migration = { mode: 'migration', collectionId: options.collectionId, skillId: options.skillId, sourceRef: 'trusted-source-receipt' };
  await assert.rejects(upstream.prepareImport(candidate, { ...migration, sourceRef: 'unrelated-receipt' }), /verify the source approval/);
  assert.deepEqual(await upstream.prepareImport(candidate, migration), candidate);
  const imported = await upstream.prepareImport(candidate, { ...migration, mode: 'new-collection', collectionId: 'different-team' });
  assert.equal(imported.manifest.collectionId, 'different-team');
  assert.equal(imported.manifest.artifactHash, candidate.manifest.artifactHash);
  assert.notEqual(imported.hash, candidate.hash);
  assert.deepEqual(imported.manifest.importedFrom, { collectionId: options.collectionId, skillId: options.skillId, hash: candidate.hash });
  await assert.rejects(prepareStandardSkill({ ...options, plan: { ...plan, goal: 'Changed' } }), /current Standard WorkflowPlan is required/);
  const differentEntry = createWorkflowPlan(draft, intent, { ...proposal, entryNodeId: 'done' }, plan);
  await assert.rejects(prepareStandardSkill({ ...options, plan: differentEntry }), /entry or node identities differ/);
  const differentEdge = createWorkflowPlan(draft, intent, { ...proposal, edges: [{ from: 'done', to: 'work', kind: 'control' }] }, plan);
  await assert.rejects(author.prepare(differentEdge, options), /control flow differs/);
});

test('R-04: the actual Author Skill parallel example compiles with its documented join strategies', async t => {
  const guide = await readFile(new URL('../../src/author/flowkit-workflow-author/SKILL.md', import.meta.url), 'utf8');
  assert.match(guide, /join: \{strategy: 'all_succeeded' 或 'any', next\}/);
  const example = /<!-- standard-parallel-example -->\r?\n```js\r?\n([\s\S]+?)\r?\n```/.exec(guide);
  assert.ok(example, 'Expected a compilable example from the shipped guide');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flowkit-author-guide-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { filename: path.join(directory, 'author-guide.workflow.js'), projectRoot: directory, skillCheck: false };
  const compiled = await compileSource(example[1], options);
  assert.ok(compiled.code);
  assert.deepEqual(compiled.diagnostics, []);
  const rejected = await compileSource(example[1].replace("strategy: 'all_succeeded'", "strategy: 'all'"), options);
  assert.equal(rejected.code, '');
  assert.deepEqual(rejected.diagnostics.map(({ code }) => code), ['FK_C023']);
});

test('diagram control branches, joins, and bounded repair match executable Standard candidates', async t => {
  const { dir, options } = await fixture(t);
  async function compiledExample(example, assertions) {
    const file = fileURLToPath(new URL(`../../examples/docs/${example}.workflow.js`, import.meta.url));
    const { candidate } = await prepareStandardSkill({ ...options, file });
    for (const expected of assertions) assert.ok(candidate.files['workflow.mmd'].includes(expected), expected);
    const entry = path.join(dir, 'workflow.js');
    await writeFile(entry, candidate.files['workflow.js']);
    return (runtime, state) => runArtifact(entry, candidate.manifest.artifactHash, { evalWhen, isControlSignal, ...runtime }, state);
  }

  const route = await compiledExample('conditional-routing/sample', ['Choose -- "urgent" --> Fast',
    'Choose -- "true" --> Normal', 'Fast --> Done', 'Normal --> Done']);
  for (const [urgent, selected] of [[true, 'fast'], [false, 'normal']]) {
    const calls = [];
    const result = await route({ async runAction(id, _name, ctx) { calls.push(id); ctx.state.route = id; } }, { urgent });
    assert.equal(result.terminal, 'done');
    assert.deepEqual(calls, [selected]);
  }

  const parallel = await compiledExample('parallel-review/all', ['并行检查 · all_succeeded', '_Flowkit0Start --> Fast',
    '_Flowkit0Start --> Slow', 'Fast --> _Flowkit0Join', 'Slow --> _Flowkit0Join', '_Flowkit0Join --> Done']);
  const parallelCalls = [];
  const joined = await parallel({ async runAction(id, _name, ctx) { parallelCalls.push(id); ctx.state.slowDone = true; },
    async runVerification(id) { parallelCalls.push(id); return true; } });
  assert.deepEqual(parallelCalls.sort(), ['check', 'slow']);
  assert.equal(joined.state.slowDone, true);
  assert.equal(joined.terminal, 'done');

  const repair = await compiledExample('verification-repair/sample', ['有限修复 · 最多 3 次', 'Check -- "成功" --> Done',
    'Check -- "失败（第1–2次）" --> Repair', 'Check -. "超过次数（第3次失败不再修复）" .-> Failed', 'Repair --> Check']);
  for (const [target, terminal, steps] of [[1, 'done', ['check:0', 'repair:1', 'check:1']],
    [9, 'failed', ['check:0', 'repair:1', 'check:1', 'repair:2', 'check:2']]]) {
    const calls = [];
    const result = await repair({
      async runVerification(_id, _name, ctx) { calls.push(`check:${ctx.state.score}`); return ctx.state.score >= target; },
      async runAction(_id, _name, ctx) { ctx.state.score++; calls.push(`repair:${ctx.state.score}`); }
    }, { score: 0 });
    assert.equal(result.terminal, terminal);
    assert.deepEqual(calls, steps);
  }
});
