import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowAuthor } from './author.mjs';
import { checkPlanCapabilities } from './draft.mjs';
import { reviewStandardCandidate } from './standard-artifact.mjs';
import { runArtifact } from '../runtime/run.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { authorError } from './host-budget.mjs';
import { authorIdentity } from './host-target.mjs';
import { evalWhen } from '../when/evaluate.mjs';

/** Real domain operations for the compiled fixed core. Semantic failures never enter syntax repair. */
export async function executeAuthorCore({ draft, turn, options, ports, signal, requestContext, observeReview, track }) {
  const execution = options.execution;
  if (typeof execution?.createSession !== 'function') throw authorError('author-executor', 'An independently responsive Host execution session is required');
  const session = await execution.createSession(Object.freeze({ request: ports.request, tool: ports.tool, io: ports.io }),
    { signal, requestContext, draftId: draft.id, turnId: turn.turnId, attemptId: turn.attemptId });
  if (!session?.intentRuntime?.parse || !session.runtime?.runAgentTask || !session.runtime?.validateResult) {
    throw authorError('author-executor', 'Session requires Intent Runtime, TaskV2 execution and result validation');
  }
  const boundGraph = typeof options.capabilityGraph === 'function' ? await options.capabilityGraph({ requestContext, signal }) : options.capabilityGraph;
  const graph = boundGraph && new Proxy(boundGraph, { get(target, key) {
    const method = target[key];
    return typeof method === 'function' ? (...args) => ports.read({ graphMethod: String(key), args }, () => method.apply(target, args)) : method;
  } });
  let intentBaseline = draft.intentBaseline;
  const author = createWorkflowAuthor({ intentRuntime: { async parse(...args) {
    const result = await session.intentRuntime.parse(...args);
    intentBaseline = JSON.parse(JSON.stringify(result.effective));
    return result;
  } }, capabilityGraph: graph,
    verifySafetyPolicy: request => options.authorization.verifySafetyPolicy?.({ ...request, requestContext, signal }),
    readDocumentUrl: options.readDocumentUrl && (url => ports.read({ url }, () => options.readDocumentUrl(url, { requestContext, signal }))) });
  const workspace = await mkdtemp(path.join(options.workRoot, '.flowkit-author-'));
  let reviewObservation;
  const state = { reviewOnly: turn.kind === 'review-only' };
  const question = (id, text, values = ['clarify', 'revise']) => ({ id, question: text,
    options: values.map(value => ({ value, label: String(value) })), recommended: values[0], customAllowed: true });
  const clarify = (message, questions) => Object.assign(authorError('author-resource', message), { outcome: 'needs-clarification', questions });
  const observed = async operation => {
    const before = ports.observed();
    const pending = Promise.resolve().then(operation);
    track(pending);
    const value = await pending;
    if (ports.observed() === before) throw authorError('author-unobserved', 'Execution bypassed the guarded model request port');
    return value;
  };
  const actions = {
    async loadReview(ctx) {
      if (!draft.candidate) throw authorError('author-review', 'No committed candidate exists for review-only');
      if (draft.candidate.manifest.hostProfile.digest !== options.hostProfile.digest) throw clarify('Host profile changed; rebuild before review', [question('host-profile', 'Review target Host capabilities', ['rebuild', 'cancel'])]);
      ctx.state.authorizedRequest = { ...(draft.authorizedRequest ?? { input: draft.goal }), reviewRequest: turn.request };
      ctx.state.effectiveIntent = draft.intent ?? { importedDefinition: draft.candidate.manifest.workflowDefinition };
      ctx.state.intentChanges = [];
      ctx.state.baselineEvidence = draft.baselineEvidence ?? { manifest: draft.candidate.manifest, source: draft.operation };
      ctx.state.currentPlan = draft.plan;
      ctx.state.candidate = draft.candidate;
      ctx.state.candidateDiff = reviewStandardCandidate(draft.candidate, draft.previousCandidate);
      for (const item of draft.candidate.manifest.documents ?? []) {
        await author.readDocument({ ...item, ...(item.source.type === 'url' ? { url: item.source.url } : {}) });
      }
      ctx.state.resourceSnapshot = draft.resources;
    },
    async parseIntent(ctx) {
      ctx.state.authorizedRequest = structuredClone(turn.request);
      ctx.state.authorizedRequest.target = { operation: draft.operation, ...draft.target, previousHash: draft.previousHash };
      ctx.state.authorizedRequest.choices = draft.choices;
      const baseline = Object.hasOwn(turn.request, 'baseline') ? turn.request.baseline : draft.intentBaseline;
      ctx.state.effectiveIntent = JSON.parse(JSON.stringify(await observed(() => author.analyze(draft, { input: turn.request.input,
        context: turn.request.contextSnapshot, baseline, baselineId: turn.request.baselineId ?? (baseline ? authorIdentity(baseline) : undefined),
        confirmedConstraintIds: turn.request.confirmedConstraintIds, signal }))));
      ctx.state.intentChanges = ctx.state.effectiveIntent.changes;
      ctx.state.baselineEvidence = { ...(draft.intent ? { intent: draft.intent } : {}),
        plan: draft.plan ?? null, candidateHash: draft.candidate?.hash ?? null,
        workflow: draft.previousCandidate ? { manifest: draft.previousCandidate.manifest, files: draft.previousCandidate.files } : null,
        materials: turn.request.contextSnapshot ?? null };
      if (baseline) ctx.state.baselineEvidence.intentBaseline = baseline;
    },
    async readCatalog(ctx) {
      const pins = options.initialDocuments ?? [];
      const documents = [];
      for (const pin of pins) documents.push(await author.readDocument(pin));
      const guide = await ports.read({ bundledAuthorGuide: true }, () => readFile(new URL('./flowkit-workflow-author/SKILL.md', import.meta.url), 'utf8'));
      if (artifactDigest(guide) !== options.coreIdentity.guideHash) throw authorError('author-resource', 'Bundled Author guide differs from the built core identity');
      const catalog = graph && await graph.getCapabilities({ ids: options.initialCapabilityIds ?? ['flowkit::compile-workflow'] });
      ctx.state.catalogSnapshot = { documents, catalog: catalog ?? null,
        generalDocumentation: { text: guide, contentHash: artifactDigest(guide), source: 'bundled-author-guide' },
        hostProfile: options.hostProfile, choices: draft.choices };
      ctx.state.confirmedPlan = false;
      if (turn.request.confirmedPlanHash) {
        if (draft.plan?.planHash !== turn.request.confirmedPlanHash || draft.plan.intentRef.effectiveIntentHash !== ctx.state.effectiveIntent.intentRef.effectiveIntentHash) {
          throw authorError('author-conflict', 'Confirmed Plan or effective intent changed');
        }
        const proposal = structuredClone(draft.plan);
        proposal.assumptions = proposal.assumptions.map(item => ({ ...item, requiresConfirmation: false }));
        proposal.unresolvedIssues = proposal.unresolvedIssues.filter(item => !item.id.startsWith('assumption-'));
        ctx.state.rawText = JSON.stringify(proposal); ctx.state.confirmedPlan = true;
      }
    },
    async validatePlan(ctx) {
      ctx.state.currentPlan = null; ctx.state.planDiagnostics = [];
      let proposal;
      try { proposal = JSON.parse(ctx.state.rawText); }
      catch (error) { ctx.state.planDiagnostics = [{ message: error.message }]; return; }
      try {
        const planningIntent = structuredClone(ctx.state.effectiveIntent);
        if (draft.plan?.intentRef?.effectiveIntentHash === planningIntent.intentRef.effectiveIntentHash &&
          draft.plan.intentRef.changeSetHash === planningIntent.intentRef.changeSetHash) planningIntent.intentRef = draft.plan.intentRef;
        ctx.state.currentPlan = await author.plan(draft, planningIntent, proposal,
          { previous: draft.plan, graphContext: requestContext });
        ctx.state.questions = ctx.state.currentPlan.unresolvedIssues.filter(item => item.blocking).map(item =>
          question(item.id, item.description, item.id.startsWith('unsupported-') ? ['standard', 'revise'] : ['clarify', 'revise']));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        ctx.state.planDiagnostics = [{ message: error.message }];
      }
    },
    async bindResources(ctx) {
      const plan = ctx.state.currentPlan;
      if (plan.capabilityRequirements.length && !graph) throw clarify('Capability Graph binding is missing', [question('capability-graph', 'Connect the Host capability catalog', ['configure-host', 'revise'])]);
      const capabilities = await checkPlanCapabilities(graph, plan.capabilityRequirements, requestContext);
      const documents = [];
      if (plan.resourceRequirements.some(item => !['document', 'professional-skill'].includes(item.kind) && item.required !== false)) {
        throw clarify('Unknown required resource kind', [question('resource-kind', 'Select a supported document or approved Professional Skill', ['revise', 'cancel'])]);
      }
      for (const pin of plan.resourceRequirements.filter(item => item.kind === 'document')) documents.push(await author.readDocument(pin));
      const professionalSkills = plan.resourceRequirements.filter(item => item.kind === 'professional-skill');
      const selected = [];
      for (const pin of professionalSkills) {
        const skill = await ports.read({ professionalSkill: pin }, () => options.resolveProfessionalSkill?.(pin, { requestContext, signal }));
        if (!skill || skill.approved !== true || skill.id !== pin.id || skill.version !== pin.version || skill.digest !== pin.digest) {
          if (pin.required === false) continue;
          ctx.state.resourceSnapshot = { ready: false, gap: pin, options: ['create', 'review', 'approve-existing'] };
          ctx.state.questions = [question('missing-professional-skill', `Select an approved exact Professional Skill for ${pin.id}`, ['create-review-approve', 'select-existing'])]; return;
        }
        selected.push({ ...skill, nodeId: pin.nodeId });
      }
      ctx.state.resourceSnapshot = { ready: capabilities.supported, capabilities, documents,
        catalogIdentity: authorIdentity(ctx.state.catalogSnapshot),
        professionalSkills: selected, hostProfile: options.hostProfile, safetyPolicies: turn.request.safetyPolicies ?? [] };
      ctx.state.reuseCandidate = !!draft.candidate && draft.plan?.planHash === plan.planHash &&
        authorIdentity(draft.resources) === authorIdentity(ctx.state.resourceSnapshot);
      ctx.state.reuseReview = false;
      if (ctx.state.reuseCandidate) {
        ctx.state.candidate = draft.candidate; ctx.state.candidateDiff = reviewStandardCandidate(draft.candidate, draft.previousCandidate);
        ctx.state.reuseReview = !!turn.priorReview?.qualified && turn.priorReview.coreHash === authorIdentity(options.coreIdentity) &&
          turn.priorReview.reviewPolicy === (options.authorization.reviewPolicy ?? 'separate-pass') &&
          authorIdentity(draft.authorizedRequest) === authorIdentity(ctx.state.authorizedRequest);
      }
    },
    async prepareCandidate(ctx) {
      ctx.state.candidate = null; ctx.state.candidateDiff = null; ctx.state.compileDiagnostics = [];
      const file = path.join(workspace, 'candidate.workflow.js');
      await ports.read({ writeCandidateSource: artifactDigest(ctx.state.rawText) }, async () => { await writeFile(file, ctx.state.rawText); return true; });
      let result;
      try { result = await ports.read({ compileSource: artifactDigest(ctx.state.rawText) }, () => author.prepare(ctx.state.currentPlan, { file, ...draft.target, collectionId: draft.collectionId,
        hostProfile: options.hostProfile, buildId: turn.attemptId, includeSource: draft.choices.includeSource,
        executionMode: draft.choices.executionMode, compilerOptions: { projectRoot: workspace, skillCheck: false },
        documents: ctx.state.resourceSnapshot.documents.map(item => item.evidence),
        professionalSkills: ctx.state.resourceSnapshot.professionalSkills.map(({ nodeId, id, version, digest }) => ({ nodeId, id, version, digest })),
        safetyPolicies: ctx.state.resourceSnapshot.safetyPolicies })); }
      catch (error) {
        if (error.code === 'FKA_HUMAN_LIMIT_REQUIRED') throw clarify(error.message,
          [question(error.nodeId, 'Choose a finite Human revision limit', [2, 1, 3])]);
        if (error.code === 'FKA_SAFETY_POLICY_REQUIRED') throw clarify(error.message,
          [question(error.nodeId, `Approve a Host policy for exact Artifact ${error.artifactHash}`, ['review-exact-policy', 'revise'])]);
        if (/Document|document|Graph/.test(error.message)) throw clarify(error.message, [question('resource-drift', 'Refresh and review the changed resource', ['refresh-review', 'cancel'])]);
        if (/differ.*WorkflowPlan|control flow differs/.test(error.message)) error.outcome = 'needs-revision';
        throw error;
      }
      ctx.state.compileDiagnostics = result.diagnostics;
      if (result.candidate) {
        ctx.state.candidate = result.candidate;
        ctx.state.candidateDiff = reviewStandardCandidate(result.candidate, draft.previousCandidate ?? null);
      }
    },
    async bindReviewReceipt(ctx) {
      if (ctx.state.passed !== true || ctx.state.findings.length) return;
      if (!reviewObservation) throw authorError('author-review', 'No actual semantic review execution was observed');
      const observation = await observeReview({ ...reviewObservation, requestContext, signal });
      if (observation && (observation.requestId ?? observation.executionId) !== reviewObservation.task.execution.requestId) {
        throw authorError('author-review', 'Host review observation does not correlate with the actual review request');
      }
      if (!observation || observation.passed !== true || !observation.subjectId || !observation.executionId ||
        options.authorization.reviewPolicy === 'independent-subject' && (!observation.authorSubjectId || observation.subjectId === observation.authorSubjectId ||
          !observation.sessionId || !observation.authorSessionId || observation.sessionId === observation.authorSessionId ||
          !observation.workspaceId || !observation.authorWorkspaceId || observation.workspaceId === observation.authorWorkspaceId)) {
        throw clarify('Host review observation is not qualified', [question('review-observation',
          options.authorization.reviewPolicy === 'independent-subject' ? 'Configure an independently authorized reviewer and its actual execution evidence' :
            'Configure the actual semantic review execution observer', ['configure-host-review', 'cancel'])]);
      }
      ctx.state.reviewReceipt = { observation, candidateHash: ctx.state.candidate.hash };
    }
  };
  const runtime = { ...session.runtime, evalWhen, isControlSignal: session.runtime.isControlSignal ?? (() => false),
    taskPolicy: { ...session.runtime.taskPolicy, deadlineMs: turn.budget.deadlineMs,
      maxDispatches: turn.budget.limits.maxRequests, maxTaskBytes: turn.budget.limits.maxBytes },
    async runAgentTask(prepared, context) {
      const id = prepared.task.node.id;
      if (id.endsWith('-repair')) ports.repair(`${turn.attemptId}/${prepared.task.execution.activationId}`);
      const result = await observed(() => session.runtime.runAgentTask(prepared, context));
      if (result?.status === 'succeeded' && (id === 'semantic-review' ?
        typeof result.result?.passed !== 'boolean' || !Array.isArray(result.result?.findings) || result.result.findings.some(item => typeof item !== 'string') :
        typeof result.result?.rawText !== 'string')) throw authorError('author-schema', 'Author TaskV2 result does not satisfy its declared output contract');
      if (id === 'semantic-review') reviewObservation = { task: prepared.task, result: structuredClone(result),
        attemptId: turn.attemptId, candidateHash: prepared.task.input.candidate.hash };
      return result;
    },
    async runAction(name, _label, ctx) { ports.check(); await actions[name](ctx); },
    async runVerification(name, _label, { state: value }) {
      ports.check();
      return { intentReady: () => value.effectiveIntent.coverage === 'complete' && !value.effectiveIntent.issues.length &&
          !value.effectiveIntent.unresolved.length && !!draft.choices.executionMode &&
          !(draft.operation === 'update' && draft.target.version === draft.previousCandidate.manifest.version),
        planValid: () => !!value.currentPlan, planReady: () => value.currentPlan.status === 'ready-for-dsl',
        resourcesReady: () => value.resourceSnapshot.ready === true, compiled: () => !!value.candidate,
        reviewPassed: () => !!value.reviewReceipt }[name]();
    }
  };
  try {
    const coreRoot = new URL('./core/', import.meta.url);
    const identity = options.coreIdentity;
    const result = await runArtifact(fileURLToPath(new URL('workflow.js', coreRoot)), identity.artifactHash, runtime, state,
      { signal, projectRoot: options.workRoot, skillCheck: false });
    return { outcome: result.terminal === 'candidate-ready' ? 'candidate-ready' : result.terminal === 'needs-info' ?
      'needs-clarification' : 'needs-revision', state: result.state, coreIdentity: identity, intentBaseline };
  } finally {
    // Only remove this invocation's owned temporary directory, never Host resources or published files.
    if (path.dirname(workspace) === path.resolve(options.workRoot) && path.basename(workspace).startsWith('.flowkit-author-')) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
