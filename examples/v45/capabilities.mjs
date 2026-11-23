import assert from 'node:assert/strict';
import {copyFile, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {canonicalBytes, sha256Bytes} from '../../src/interactive/canonical.mjs';
import {acceptance, change, flowKitRoot} from './local-target.mjs';

const digest = value => sha256Bytes(canonicalBytes(value));
const file = (dir,name) => path.join(dir,name);
const good = result => result.exitCode===0;
const ciKeys = ['unit','integration','lint','dependencies'];

export function createCapabilities({target, request, namespace, get, journal, faults, approval, toolchain}) {
  const {source,work,app,stable,candidate,previousRelease,auditPath,git,execute,checked,hashFile,writeJson,smoke,current,mutate}=target;
  const workApp=file(work,app);
  const releaseFile=file(target.root,'release-plan.json');
  const migrationFile=file(target.root,'migration.sqlite');
  const targetPath = async value => path.normalize(await realpath(value));
  const intent = ()=>({status:request.target===namespace&&request.change.trim()===change?'ready':'clarification',
    target:request.target,change:request.change.trim()});
  const expected = ()=>get('release-artifact-inventory').artifact;
  const verifiedApproval = ()=>approval('approve-release');
  const eligibility = ()=>{
    const row=current(),approved=verifiedApproval();
    return row.lease_until>Date.now() && row.previous_hash===previousRelease && !!approved
      && (row.current_hash===approved.artifact || row.canary_hash===approved.artifact);
  };
  const ciResult = id => get(id).passed;

  const actions = {
    'recognize-intent':()=>({evidence:intent(),set:{intent:intent()}}),
    'parse-user-request':()=>({target:request.target.trim(),change:request.change.trim(),migration:request.migration}),
    'gather-known-constraints':()=>({root:target.root,namespace,reversibleTarget:previousRelease,mutationSurface:app}),
    'resolve-user-goal':()=>({surface:app,requirement:get('parse-user-request').change,allowedChange:change}),
    'extract-acceptance-hints':()=>({fixtures:acceptance,goal:get('resolve-user-goal').requirement}),
    'record-clarification-policy':()=>({evidence:intent(),set:{intent:intent()}}),
    'normalize-request':()=>({...get('parse-user-request'),change:get('parse-user-request').change.toLowerCase()}),
    'snapshot-constraints':()=>({digest:digest(get('gather-known-constraints')),mutationSurface:app}),
    'identify-stakeholders':()=>({requestor:'reference-user',releaseApprover:'reference-operator',namespace}),
    'capture-baseline':async()=>({commit:await checked(await git('baseline-head',['rev-parse','HEAD'])),sourceHash:await hashFile(file(source,app))}),
    'read-repo-manifest':async()=>JSON.parse(await readFile(file(source,'package.json'),'utf8')),
    'inspect-dependencies':()=>({runtimeImports:target.baselineSource.match(/\bimport\b/g)??[],developmentToolchain:toolchain.lockHash}),
    'capture-git-snapshot':async()=>({files:(await checked(await git('tracked-files',['ls-files']))).split(/\r?\n/),
      changed:await checked(await git('baseline-status',['status','--porcelain']))}),
    'analyze-impact':()=>({source:app,baseline:get('capture-baseline').sourceHash,callers:['unit.test.mjs','service.test.mjs']}),
    'inventory-existing-behavior':()=>smoke('baseline-behavior',stable),
    'list-user-scenarios':()=>get('inventory-existing-behavior').values.map(item=>({...item,requiresChange:item.actual!==item.expected})),
    'identify-external-dependencies':()=>({target:namespace,runtimeImports:get('inspect-dependencies').runtimeImports,releaseAdapter:'local-sqlite'}),
    'refine-requirements':()=>({requirement:get('normalize-request').change,scope:app,
      revisedFrom:journal.lastDecision('record-user-confirmation')?.comment??null,previous:previousRelease}),
    'draft-requirements-doc':()=>({body:'# Normalization\n'+get('refine-requirements').requirement+'\nScope: '+app+'\n'+(get('refine-requirements').revisedFrom??''),
      source:get('capture-baseline').commit}),
    'draft-acceptance-cases':()=>get('list-user-scenarios').map(({input,expected:result})=>({input,result})),
    'draft-mermaid-flow':()=>({diagram:'flowchart LR\n  Input --> Trim\n  Trim --> Lowercase\n  Lowercase --> Result\n',
      cases:get('draft-acceptance-cases').length}),
    'bundle-requirement-artifacts':()=>({requirements:get('draft-requirements-doc').body,cases:get('draft-acceptance-cases'),
      diagram:get('draft-mermaid-flow').diagram,baseline:get('capture-baseline').commit}),
    'freeze-requirement-version':async pending=>{
      const bundle=get('bundle-requirement-artifacts');
      const requestId=/^req:([a-f0-9]{64})$/.exec(pending.requestId);
      assert.ok(requestId,'Invalid artifact-producing request identity');
      const version=file(target.root,'requirements-'+requestId[1]);
      await mkdir(version);
      const requirementFile=file(version,'requirements.md');
      const acceptsFile=file(version,'acceptance.json');
      const diagramPath=file(version,'requirement-flow.mmd');
      await writeFile(requirementFile,bundle.requirements,{flag:'wx'});
      await writeFile(acceptsFile,canonicalBytes(bundle.cases),{flag:'wx'});
      await writeFile(diagramPath,bundle.diagram,{flag:'wx'});
      return {evidence:{bundle:digest(bundle)}, artifacts:[['requirements',requirementFile,'text/markdown'],
        ['acceptance',acceptsFile,'application/json'],['requirement-flow',diagramPath,'text/plain']]};
    },
    'build-traceability-matrix':()=>({approval:approval('record-user-confirmation').bundleHash,
      links:get('draft-acceptance-cases').map(({input,result})=>({path:app,input,result,test:'unit.test.mjs'}))}),
    'draft-design':()=>({logic:['trim','toLowerCase'],surface:app,approvedRequirements:get('build-traceability-matrix').approval}),
    'decompose-architecture':()=>({publicModule:get('draft-design').surface,pureOperation:'normalize',dependencyCount:0}),
    'design-a-p-i-boundaries':()=>({export:get('decompose-architecture').pureOperation,parameters:[{name:'value',type:'string'}],returns:'string'}),
    'design-data-contracts':()=>({request:{value:'string'},response:{value:get('design-a-p-i-boundaries').returns}}),
    'define-test-strategy':()=>({unit:get('build-traceability-matrix').links,integration:'service.test.mjs',static:app}),
    'create-rollback-assumptions':()=>({target:namespace,previous:previousRelease,source:get('capture-baseline').commit}),
    'create-worktree':async()=>({head:get('capture-baseline').commit,path:await checked(await git('worktree-add',
      ['worktree','add','--detach',work,get('capture-baseline').commit]))}),
    'implement-change':async()=>{
      assert.equal(await readFile(workApp,'utf8'),target.baselineSource,'Unexpected isolated checkout contents');
      await writeFile(workApp,target.expectedSource);
      return {sourceHash:await hashFile(workApp),diff:await checked(await git('implementation-diff',['diff','--',app],work))};
    },
    'plan-c-i-jobs':()=>({lanes:ciKeys,head:get('capture-baseline').commit,sourceHash:get('implement-change').sourceHash}),
    'freeze-c-i-inputs':async()=>({sourceHash:await hashFile(workApp),planned:get('plan-c-i-jobs').sourceHash,
      dependencyLock:toolchain.lockHash}),
    'prepare-unit-suite':async()=>({suite:await hashFile(file(work,'unit.test.mjs')),source:await hashFile(workApp)}),
    'run-unit-matrix':async()=>{
      const result=await execute('unit-ci',['--experimental-test-coverage','--test','unit.test.mjs']);
      return {passed:good(result)&&/coverage report/i.test(result.stdout),exitCode:result.exitCode,log:sha256Bytes(Buffer.from(result.stdout))};
    },
    'record-unit-coverage':()=>({evidence:get('run-unit-matrix'),set:{unit:ciResult('unit')&&get('run-unit-matrix').passed}}),
    'prepare-integration-fixtures':async()=>({fixture:await hashFile(file(work,'service.test.mjs')),input:get('design-data-contracts').request}),
    'capture-integration-evidence':()=>({evidence:{passed:ciResult('verify-service-contracts')},set:{integration:ciResult('integration')&&ciResult('verify-service-contracts')}}),
    'capture-static-report':()=>({evidence:get('check-static-type-boundary'),set:{lint:ciResult('check-lint-config')&&ciResult('lint')&&ciResult('check-static-type-boundary')}}),
    'generate-s-b-o-m':()=>toolchain.sbom(),
    'check-license-allowlist':()=>{
      const denied=Object.entries(target.lock.packages).filter(([location,info])=>location&&!toolchain.allowedLicenses.has(info.license)).map(([location])=>location);
      return {evidence:{denied},set:{dependencies:ciResult('dependencies')&&ciResult('scan-known-vulnerabilities')&&!denied.length}};
    },
    'aggregate-c-i-results':pending=>Object.fromEntries(ciKeys.map(key=>[key,pending.task.input[key]])),
    'generate-c-i-summary':()=>({results:get('aggregate-c-i-results'),lock:toolchain.lockHash,source:get('freeze-c-i-inputs').sourceHash}),
    'independent-code-review':async()=>({files:(await checked(await git('review-scope',['diff','--name-only'],work))).split(/\r?\n/),
      tested:(await smoke('review-execution',workApp)).matches,source:await hashFile(workApp)}),
    'resolve-review-comments':()=>({scope:ciResult('audit-change-scope'),security:ciResult('check-security-findings'),
      findings:ciResult('audit-change-scope')&&ciResult('check-security-findings')?[]:['Review requires correction']}),
  };

  const verifiers = {
    'check-context-scope':async()=>await targetPath(source)===file(await targetPath(target.root),'source'),
    'verify-input-signals':()=>typeof get('parse-user-request').migration==='boolean'&&get('parse-user-request').change.length>0,
    'verify-intent-result':()=>['ready','clarification'].includes(get('recognize-intent').status),
    'check-intent-conflicts':()=>get('extract-acceptance-hints').fixtures.length===new Set(acceptance.map(([input])=>input)).size,
    'verify-request':()=>intent().status==='ready',
    'mark-risk-boundary':()=>get('snapshot-constraints').mutationSurface===app&&get('identify-stakeholders').namespace===namespace,
    'detect-project-conventions':()=>get('read-repo-manifest').type==='module'&&get('read-repo-manifest').private===true,
    'verify-baseline':()=>get('capture-git-snapshot').files.includes(app)&&get('capture-git-snapshot').changed==='',
    'prioritize-risks':()=>get('list-user-scenarios').some(item=>item.requiresChange)&&get('analyze-impact').baseline===get('inventory-existing-behavior').bytes,
    'validate-requirement-bundle':()=>get('bundle-requirement-artifacts').cases.every(item=>typeof item.result==='string')&&
      get('bundle-requirement-artifacts').baseline===get('capture-baseline').commit,
    'verify-acceptance':()=>get('draft-acceptance-cases').length===acceptance.length&&get('draft-mermaid-flow').diagram.includes('Trim --> Lowercase'),
    'verify-design':()=>get('define-test-strategy').unit.length===acceptance.length&&get('design-data-contracts').response.value==='string',
    'review-security-design':()=>get('decompose-architecture').dependencyCount===0&&get('create-rollback-assumptions').target===namespace,
    'review-performance-budget':()=>get('draft-design').logic.length===2&&get('create-rollback-assumptions').previous===previousRelease,
    'verify-worktree':async()=>await checked(await git('worktree-head',['rev-parse','HEAD'],work))===get('capture-baseline').commit&&
      await targetPath(work)!==await targetPath(source),
    'verify-change':async()=>await readFile(workApp,'utf8')===target.expectedSource&&get('implement-change').diff.includes('value.trim()'),
    'inspect-c-i-config':()=>get('plan-c-i-jobs').lanes.join(',')===ciKeys.join(','),
    'validate-test-environment':async()=>Number(process.versions.node.split('.')[0])>=22&&
      (await stat(file(flowKitRoot,'node_modules/typescript/bin/tsc'))).isFile(),
    unit:async()=>get('prepare-unit-suite').source===get('freeze-c-i-inputs').sourceHash,
    integration:()=>get('prepare-integration-fixtures').input.value==='string',
    'verify-service-contracts':async()=>good(await execute('service-ci',['--test','service.test.mjs'])),
    'check-lint-config':()=>get('read-repo-manifest').type==='module',
    lint:async()=>good(await git('git-diff-check',['diff','--check'],work)),
    'check-static-type-boundary':async()=>good(await execute('types-ci',[file(flowKitRoot,'node_modules/typescript/bin/tsc'),
      '--allowJs','--checkJs','--strict','--noEmit','--skipLibCheck',workApp])),
    dependencies:()=>get('generate-s-b-o-m').components>0,
    'scan-known-vulnerabilities':()=>toolchain.audit(),
    'check-required-evidence':()=>ciKeys.every(key=>typeof get('aggregate-c-i-results')[key]==='boolean'),
    'confirm-join-policy':()=>journal.parallelStartedWithFourPending(),
    'audit-change-scope':()=>get('independent-code-review').files.join(',')===app,
    'check-security-findings':async()=>await readFile(workApp,'utf8')===target.expectedSource&&get('inspect-dependencies').runtimeImports.length===0,
    'review-change':()=>!get('resolve-review-comments').findings.length&&get('independent-code-review').tested===acceptance.length,
  };

  Object.assign(actions,{
    'plan-release':()=>({target:namespace,source:get('freeze-c-i-inputs').sourceHash,previous:previousRelease,migration:request.migration}),
    'release-artifact-inventory':async()=>({artifact:await hashFile(workApp),size:(await stat(workApp)).size}),
    'draft-migration-checklist':()=>({apply:request.migration,dryRun:'SQLite transaction',data:target.inspectMigration()}),
    'document-rollback-anchor':()=>({artifact:previousRelease,target:namespace,current:current().current_hash}),
    'confirm-release-window':()=>({target:namespace,until:current().lease_until,previous:previousRelease}),
    'prepare-migration-fixture':()=>({data:target.inspectMigration(),source:get('draft-migration-checklist').data}),
    'rehearse-migration':()=>{
      const db=new DatabaseSync(migrationFile);
      try {
        db.exec('CREATE TABLE source_labels (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        const insert=db.prepare('INSERT INTO source_labels VALUES (?,?)');
        for (const row of get('prepare-migration-fixture').data.rows) insert.run(row.id,row.label);
        return {source:db.prepare('SELECT id,label FROM source_labels ORDER BY id').all(),migrationFile};
      } finally {db.close();}
    },
    'run-migration-dry-run':async()=>{
      const db=new DatabaseSync(migrationFile);
      try {
        db.exec('BEGIN IMMEDIATE; CREATE TABLE normalization_receipts AS SELECT id,lower(trim(label)) AS label FROM source_labels;');
        const projected=db.prepare('SELECT id,label FROM normalization_receipts ORDER BY id').all();
        db.exec('ROLLBACK');
        const restored=!db.prepare("SELECT name FROM sqlite_master WHERE name='normalization_receipts'").get();
        const result={projected,restored,before:db.prepare('SELECT id,label FROM source_labels ORDER BY id').all()};
        await writeJson(file(target.evidence,'migration-receipt.json'),result);
        return result;
      } finally {db.close();}
    },
    'deploy-staging':async pending=>{
      assert.equal(await hashFile(workApp),expected());
      await copyFile(workApp,candidate);
      assert.equal(await hashFile(candidate),expected());
      return mutate(pending.task.operationKey,'stage',db=>db.prepare('UPDATE target SET candidate_hash=?, staging_hash=? WHERE id=?')
        .run(expected(),expected(),namespace));
    },
    'deploy-canary-config-staging':async pending=>{
      const config={artifact:await hashFile(candidate),target:namespace,traffic:10};
      assert.equal(config.artifact,current().staging_hash);
      const hash=await writeJson(file(target.root,'staging-config.json'),config);
      return {operation:pending.task.operationKey,config,hash};
    },
    'run-smoke-staging':()=>smoke('staging-smoke',candidate),
    'capture-staging-evidence':()=>({checks:get('run-smoke-staging'),state:current(),config:get('deploy-canary-config-staging').hash}),
    'package-approval-bundle':async()=>{
      const plan={target:namespace,artifact:expected(),previous:previousRelease,source:get('plan-release').source,
        staging:digest(get('capture-staging-evidence')),ci:digest(get('generate-c-i-summary'))};
      return {evidence:{...plan,planHash:await writeJson(releaseFile,plan)},
        artifacts:[['candidate',candidate,'text/javascript'],['release-plan',releaseFile,'application/json']]};
    },
    'record-review-feedback':()=>({comment:journal.lastDecision('approve-release').comment,
      plan:get('package-approval-bundle').planHash,artifact:expected()}),
    'prepare-traffic-shift':()=>({artifact:verifiedApproval().artifact,previous:previousRelease,lease:current().lease_until}),
    'deploy-canary':async pending=>{
      const approved=verifiedApproval();
      assert.equal(await hashFile(candidate),approved.artifact,'Candidate bytes changed after approval');
      const evidence=mutate(pending.task.operationKey,'canary',(db,before)=>{
        assert.equal(before.staging_hash,approved.artifact);
        assert.equal(before.current_hash,previousRelease);
        db.prepare('UPDATE target SET canary_hash=?, traffic=10 WHERE id=?').run(approved.artifact,namespace);
      });
      if (faults.canaryPostWrite) {
        const probe=await smoke('failed-canary-readiness',candidate,[[' Ready ','unavailable']]);
        assert.ok(probe.matches<probe.total);
        return {evidence:{target:evidence,probe},failure:{code:'CANARY_POST_WRITE_CHECK_FAILED',
          message:'Isolated canary readiness contract failed after changing traffic',origin:'executor',sideEffectStatus:'known'}};
      }
      return evidence;
    },
    'collect-canary-metrics':async()=>({metrics:await smoke('canary-smoke',candidate),deployment:current()}),
    'compare-canary-baseline':async()=>({candidate:get('collect-canary-metrics').metrics,
      previous:await smoke('canary-baseline',stable),traffic:current().traffic}),
    'schedule-promotion':()=>({target:namespace,artifact:expected(),lease:current().lease_until,stages:[10,100]}),
    'promote-release':async pending=>{
      assert.equal(await hashFile(candidate),verifiedApproval().artifact);
      return mutate(pending.task.operationKey,'promote',(db,before)=>{
        assert.equal(before.canary_hash,expected());
        assert.equal(before.traffic,10);
        db.prepare('UPDATE target SET current_hash=?, traffic=100 WHERE id=?').run(expected(),namespace);
      });
    },
    'assess-user-impact':async()=>({traffic:current().traffic,service:await smoke('production-smoke',candidate)}),
    'record-promotion-audit':()=>({target:current(),approval:verifiedApproval().bundleHash,assessment:get('assess-user-impact')}),
    'rollback-release':()=>({target:namespace,trigger:journal.latestFailure(),rollbackFrom:current(),previous:previousRelease}),
    'restore-previous-release':async pending=>{
      assert.ok(eligibility(),'Rollback lease, active version or prior target differs');
      assert.equal(await hashFile(stable),previousRelease,'The pinned previous version has changed');
      const before = current();
      try {
        return mutate(pending.task.operationKey,'restore',(db,locked)=>{
          assert.ok(locked.current_hash===expected()||locked.canary_hash===expected());
          db.prepare('UPDATE target SET current_hash=?,canary_hash=NULL,traffic=0 WHERE id=?').run(previousRelease,namespace);
        });
      } catch(error) {
        if (!faults.restoreError || error.message!=='Reference restore rejected') throw error;
        const after=current();
        assert.deepEqual(after,before,'The rejected transaction must leave target bytes unchanged');
        return {evidence:{cause:error.message,before,after},failure:{code:'RESTORE_TRANSACTION_REJECTED',
          message:error.message,origin:'executor',sideEffectStatus:'none'}};
      }
    },
    'archive-delivery':async()=>{
      const document={target:namespace,artifact:current().current_hash,approval:verifiedApproval().bundleHash,
        changes:get('implement-change').sourceHash,ci:get('generate-c-i-summary'),audit:get('record-promotion-audit')};
      const delivery=await writeJson(auditPath,document);
      return {evidence:{delivery,artifact:document.artifact},set:{delivery},artifacts:[['delivery',auditPath,'application/json']]};
    },
    'collect-delivery-evidence':async()=>({archive:await hashFile(auditPath),mutations:target.record().map(row=>row.kind),
      approvals:['record-user-confirmation','approve-release'].map(id=>approval(id).bundleHash)}),
    'index-artifact-versions':()=>({versions:journal.artifacts().map(({artifactId,versionId,contentHash})=>({artifactId,versionId,contentHash}))}),
  });

  Object.assign(verifiers,{
    'bind-immutable-artifact':()=>expected()===get('plan-release').source,
    'verify-plan':()=>get('document-rollback-anchor').artifact===previousRelease&&get('draft-migration-checklist').apply===request.migration,
    'verify-readiness':()=>get('resolve-review-comments').findings.length===0,
    'check-staging-capacity':()=>get('release-artifact-inventory').size<64*1024&&current().staging_hash===null,
    'needs-migration':()=>get('draft-migration-checklist').apply,
    'snapshot-backup-plan':()=>get('document-rollback-anchor').current===previousRelease&&target.inspectMigration().rows.length>0,
    'measure-migration-risk':()=>get('prepare-migration-fixture').data.rows.length<=1000&&!get('prepare-migration-fixture').data.table,
    'verify-rollback-dry-run':()=>get('run-migration-dry-run').restored&&get('run-migration-dry-run').before.length>0,
    'verify-migration':()=>get('run-migration-dry-run').projected.every(item=>item.label===item.label.trim().toLowerCase()),
    'verify-staging':()=>get('capture-staging-evidence').checks.matches===acceptance.length&&current().staging_hash===expected(),
    'verify-release-evidence':async()=>await hashFile(releaseFile)===get('package-approval-bundle').planHash&&
      get('package-approval-bundle').artifact===await hashFile(candidate),
    'check-approval-identity':()=>get('identify-stakeholders').releaseApprover==='reference-operator'&&
      get('package-approval-bundle').target===namespace,
    'validate-approval-signature':async()=>verifiedApproval()?.artifact===await hashFile(candidate)&&
      verifiedApproval()?.plan===await hashFile(releaseFile),
    'check-release-lease':()=>current().lease_until>Date.now()&&current().previous_hash===previousRelease,
    'evaluate-error-budget':()=>get('compare-canary-baseline').candidate.matches===acceptance.length,
    'verify-canary':()=>get('collect-canary-metrics').deployment.traffic===10&&get('collect-canary-metrics').metrics.matches===acceptance.length,
    'validate-traffic-ramp':()=>get('schedule-promotion').lease>Date.now()&&current().traffic===10&&current().canary_hash===expected(),
    'check-deployment-drift':async()=>current().current_hash===await hashFile(candidate),
    'inspect-prod-health':async()=> (await smoke('production-health',candidate)).matches===acceptance.length,
    'verify-production':()=>get('record-promotion-audit').assessment.service.matches===acceptance.length&&current().traffic===100,
    'check-rollback-eligibility':()=>!faults.rollbackDenied&&eligibility(),
    'verify-rollback-traffic':()=>current().traffic===0&&current().canary_hash===null,
    'verify-rollback':async()=>current().current_hash===await hashFile(stable),
    'verify-audit-trail':async()=>get('collect-delivery-evidence').mutations.includes('promote')&&
      get('collect-delivery-evidence').archive===await hashFile(auditPath)&&
      get('index-artifact-versions').versions.some(version=>version.artifactId==='delivery'&&version.contentHash===get('collect-delivery-evidence').archive),
    'verify-archive':async()=>await hashFile(auditPath)===get('archive-delivery').delivery,
  });
  return {actions,verifiers};
}
