import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowAuthor } from './author.mjs';
import { checkPlanCapabilities } from './draft.mjs';
import { reviewStandardCandidate } from './standard-artifact.mjs';
import { runArtifact } from '../runtime/run.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { authorError } from './host-budget.mjs';

/** Real domain operations for the compiled fixed core. Semantic failures never enter syntax repair. */
export async function executeAuthorCore({ draft, turn, options, ports, signal, requestContext, observeReview }) {
  const execution = options.execution;
  if (typeof execution?.createSession !== 'function') throw authorError('author-executor', 'An independently responsive Host execution session is required');
  const session = await execution.createSession(Object.freeze({ request: ports.request, tool: ports.tool, io: ports.io }),
    { signal, requestContext, draftId: draft.id, turnId: turn.turnId, attemptId: turn.attemptId });
  if (!session?.intentRuntime?.parse || !session.runtime?.runAgentTask || !session.runtime?.validateResult) {
    throw authorError('author-executor', 'Session requires Intent Runtime, TaskV2 execution and result validation');
  }
  const graph = options.capabilityGraph && new Proxy(options.capabilityGraph, { get(target, key) {
    const method = target[key];
    return typeof method === 'function' ? (...args) => ports.read({ graphMethod: String(key), args }, () => method.apply(target, args)) : method;
  } });
  const author = createWorkflowAuthor({ intentRuntime: session.intentRuntime, capabilityGraph: graph,
    verifySafetyPolicy: request => options.authorization.verifySafetyPolicy?.({ ...request, requestContext, signal }),
    readDocumentUrl: options.readDocumentUrl && (url => ports.read({ url }, () => options.readDocumentUrl(url, { requestContext, signal }))) });
  const workspace = await mkdtemp(path.join(options.workRoot, '.flowkit-author-'));
  let reviewObservation;
  const state = {};
  const observed = async operation => {
    const before = ports.observed();
    const value = await operation();
    if (ports.observed() === before) throw authorError('author-unobserved', 'Execution bypassed the guarded model request port');
    return value;
  };
  const actions = {
    async parseIntent(ctx) {
      ctx.state.authorizedRequest = structuredClone(turn.request);
      ctx.state.effectiveIntent = JSON.parse(JSON.stringify(await observed(() => author.analyze(draft, { input: turn.request.input,
        context: turn.request.contextSnapshot, baseline: turn.request.baseline, baselineId: turn.request.baselineId,
        confirmedConstraintIds: turn.request.confirmedConstraintIds, signal }))));
      ctx.state.intentChanges = ctx.state.effectiveIntent.changes;
      ctx.state.baselineEvidence = { ...(draft.intent ? { intent: draft.intent } : {}),
        plan: draft.plan ?? null, candidateHash: draft.candidate?.hash ?? null,
        materials: turn.request.contextSnapshot ?? null };
    },
    async readCatalog(ctx) {
      const pins = options.initialDocuments ?? [];
      const documents = [];
      for (const pin of pins) documents.push(await author.readDocument(pin));
      ctx.state.catalogSnapshot = { documents, hostProfile: options.hostProfile, choices: draft.choices };
    },
    async validatePlan(ctx) {
      ctx.state.currentPlan = null; ctx.state.planDiagnostics = [];
      let proposal;
      try { proposal = JSON.parse(ctx.state.rawText); }
      catch (error) { ctx.state.planDiagnostics = [{ message: error.message }]; return; }
      try {
        ctx.state.currentPlan = await author.plan(draft, ctx.state.effectiveIntent, proposal,
          { previous: draft.plan, graphContext: requestContext });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        ctx.state.planDiagnostics = [{ message: error.message }];
      }
    },
    async bindResources(ctx) {
      const plan = ctx.state.currentPlan;
      const capabilities = await checkPlanCapabilities(graph, plan.capabilityRequirements, requestContext);
      const documents = [];
      for (const pin of plan.resourceRequirements.filter(item => item.kind === 'document')) documents.push(await author.readDocument(pin));
      const professionalSkills = plan.resourceRequirements.filter(item => item.kind === 'professional-skill');
      const selected = [];
      for (const pin of professionalSkills) {
        const skill = await ports.read({ professionalSkill: pin }, () => options.resolveProfessionalSkill?.(pin, { requestContext, signal }));
        if (!skill || skill.id !== pin.id || skill.version !== pin.version || skill.digest !== pin.digest) {
          ctx.state.resourceSnapshot = { ready: false, gap: pin, options: ['create', 'review', 'approve-existing'] }; return;
        }
        selected.push({ ...skill, nodeId: pin.nodeId });
      }
      ctx.state.resourceSnapshot = { ready: capabilities.supported, capabilities, documents,
        professionalSkills: selected, hostProfile: options.hostProfile, safetyPolicies: turn.request.safetyPolicies ?? [] };
    },
    async prepareCandidate(ctx) {
      ctx.state.candidate = null; ctx.state.candidateDiff = null; ctx.state.compileDiagnostics = [];
      const file = path.join(workspace, 'candidate.workflow.js');
      await ports.read({ writeCandidateSource: artifactDigest(ctx.state.rawText) }, async () => { await writeFile(file, ctx.state.rawText); return true; });
      const result = await ports.read({ compileSource: artifactDigest(ctx.state.rawText) }, () => author.prepare(ctx.state.currentPlan, { file, ...draft.target, collectionId: draft.collectionId,
        hostProfile: options.hostProfile, buildId: turn.attemptId, includeSource: draft.choices.includeSource,
        executionMode: draft.choices.executionMode, compilerOptions: { projectRoot: workspace, skillCheck: false },
        documents: ctx.state.resourceSnapshot.documents.map(item => item.evidence),
        professionalSkills: ctx.state.resourceSnapshot.professionalSkills.map(({ nodeId, id, version, digest }) => ({ nodeId, id, version, digest })),
        safetyPolicies: ctx.state.resourceSnapshot.safetyPolicies }));
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
      if (!observation || observation.passed !== true || !observation.subjectId || !observation.executionId ||
        options.authorization.reviewPolicy === 'independent-subject' && (!observation.authorSubjectId || observation.subjectId === observation.authorSubjectId)) {
        throw authorError('author-review', 'Host review observation is not qualified');
      }
      ctx.state.reviewReceipt = { observation, candidateHash: ctx.state.candidate.hash };
    }
  };
  const runtime = { ...session.runtime, isControlSignal: session.runtime.isControlSignal ?? (() => false),
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
          !value.effectiveIntent.unresolved.length && !!draft.choices.executionMode,
        planValid: () => !!value.currentPlan, planReady: () => value.currentPlan.status === 'ready-for-dsl',
        resourcesReady: () => value.resourceSnapshot.ready === true, compiled: () => !!value.candidate,
        reviewPassed: () => !!value.reviewReceipt }[name]();
    }
  };
  try {
    const coreRoot = new URL('./core/', import.meta.url);
    const identity = JSON.parse(await readFile(new URL('identity.json', coreRoot), 'utf8'));
    const result = await runArtifact(fileURLToPath(new URL('workflow.js', coreRoot)), identity.artifactHash, runtime, state,
      { signal, projectRoot: options.workRoot, skillCheck: false });
    return { outcome: result.terminal === 'candidate-ready' ? 'candidate-ready' : result.terminal === 'needs-info' ?
      'needs-clarification' : 'needs-revision', state: result.state, coreIdentity: identity };
  } finally {
    // Only remove this invocation's owned temporary directory, never Host resources or published files.
    if (path.dirname(workspace) === path.resolve(options.workRoot) && path.basename(workspace).startsWith('.flowkit-author-')) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
