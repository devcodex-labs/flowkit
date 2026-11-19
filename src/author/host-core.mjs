import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkflowAuthor } from './author.mjs';
import { checkPlanCapabilities } from './draft.mjs';
import { reviewStandardCandidate } from './standard-artifact.mjs';
import { materializePlan } from './workflow-plan.mjs';
import { runArtifact } from '../runtime/run.mjs';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { authorError, isIntentModelOutputError } from './host-budget.mjs';
import { authorIdentity } from './host-target.mjs';
import { evalWhen } from '../when/evaluate.mjs';

function clarificationQuestions(draft, intent, continuation, answered) {
  const questions = draft.questions.filter(({ id }) =>
    id === 'execution-mode' && !draft.choices.executionMode ||
    id === 'target-version' && draft.operation === 'update' && draft.target.version === draft.previousCandidate.manifest.version);
  const byId = new Map(intent.issues.map(issue => [issue.id, issue]));
  const messages = new Set(intent.issues.map(issue => issue.message).filter(Boolean));
  const unresolved = new Set([...intent.unresolved.filter(value => !messages.has(value)), ...byId.keys()]
    .filter(id => typeof id === 'string' && id.trim()));
  if (!unresolved.size && intent.coverage !== 'complete') unresolved.add('workflow-goal');
  const shown = new Set();
  for (const id of unresolved) {
    const questionId = `intent:${id}`;
    if (answered.has(questionId)) continue;
    const isDestination = ['publication-destination', 'publication-target', 'delivery-target'].includes(id);
    const issue = byId.get(id);
    const proposed = issue?.questions?.find(item => typeof item.question === 'string' && item.question.trim());
    const text = isDestination ? 'Where should the workflow deliver or publish its result?' :
      proposed?.question ?? issue?.message ?? 'Which inputs or rules should the workflow use where the behavior is still undecided?';
    const options = proposed?.optionIds?.map(value => {
      const candidate = issue.candidates?.find(item => item.id === value);
      return candidate && { value, label: candidate.description, reason: 'Use this option for the current decision.' };
    }).filter(Boolean) ?? [];
    if (continuation && (!['ambiguity', 'missing', 'conflict'].includes(issue?.category) ||
      !issue.sourceRefs?.some(ref => ref.root === 'input' || ref.root === 'context') ||
      !proposed || new Set(options.map(option => option.value)).size < 2 ||
      new Set(options.map(option => option.label)).size < 2)) continue;
    if (shown.has(text)) continue;
    shown.add(text);
    questions.push({ id: questionId,
      question: text,
      options: [
        { value: 'keep-draft', label: 'Keep this as a draft', reason: 'Wait for this decision before generating the workflow.' },
        ...options,
        { value: 'provide-details', label: isDestination ? 'Specify the destination' : 'Specify the expected behavior',
          reason: 'Use the details you provide in the next turn.' }
      ], recommended: 'keep-draft', customAllowed: true });
  }
  return questions;
}

function concretePlanDecision(issue) {
  if (typeof issue.id !== 'string' || !issue.id.trim() || typeof issue.description !== 'string' || !issue.description.trim()) return;
  const options = Array.isArray(issue.options) ? issue.options.filter(option => option &&
    ['value', 'label', 'reason'].every(key => typeof option[key] === 'string' && option[key].trim() && option[key].length <= 500)) : [];
  if (options.length >= 2 && options.length <= 5 &&
    new Set(options.map(x => x.value)).size === options.length && new Set(options.map(x => x.label)).size === options.length &&
    options.some(x => x.value === issue.recommended)) {
    return { id: issue.id, question: issue.description, options: options.map(({ value, label, reason }) => ({ value, label, reason })),
      recommended: issue.recommended, customAllowed: true };
  }
}

function planDecision(issue, question) {
  if (issue.id.startsWith('unsupported-')) return question(issue.id, issue.description, ['standard', 'revise']);
  return concretePlanDecision(issue) ?? question(issue.id, issue.description);
}

function isReviewFinding(item) {
  return typeof item === 'string' || (item !== null && typeof item === 'object' && typeof item.message === 'string' &&
    (item.rule === undefined || typeof item.rule === 'string') &&
    (item.nodeIds === undefined || Array.isArray(item.nodeIds) && item.nodeIds.every(id => typeof id === 'string')));
}

export function rejectedReview(candidate, findings = []) {
  const candidateHash = candidate.hash;
  const declaredIds = new Set(candidate.manifest.workflowDefinition?.nodes.map(node => node.id));
  return {
    candidateHash,
    findings: findings.slice(0, 8).map(item => {
      const { message, nodeIds = [], rule } = typeof item === 'string' ? { message: item } : item;
      const linkedNodes = [...new Set(nodeIds.filter(id => declaredIds.has(id)))].slice(0, 8);
      return { message: message.trim().slice(0, 800), nodeIds: linkedNodes, ...(rule?.trim() ? { rule: rule.trim().slice(0, 360) } : {}) };
    }).filter(item => item.message),
    actions: [
      { kind: 'review-only', candidateHash, label: 'Review the same candidate' },
      { kind: 'authoring', candidateHash, label: 'Revise from findings' }
    ]
  };
}

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
  const continuation = turn.clarifyingDraft || !!turn.reviewRevision;
  const answered = new Set(turn.answeredQuestionIds);
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
      const authorization = { ...turn.reviewAuthorization, ...turn.request };
      ctx.state.authorizedRequest = structuredClone(authorization);
      ctx.state.authorizedRequest.target = { operation: draft.operation, ...draft.target, previousHash: draft.previousHash };
      ctx.state.authorizedRequest.choices = draft.choices;
      let input = turn.request.input;
      let context = turn.request.contextSnapshot;
      let draftContext;
      if (continuation) {
        const previous = draft.authorizedRequest;
        // Old in-flight turns have the continuation flag but no saved dialogue.
        const draftInputs = turn.draftInputs ?? [...(previous.draftInputs ??
          (draft.goal === previous.input ? [draft.goal] : [draft.goal, previous.input])), input];
        const followUp = turn.reviewRevision ? 'User follow-up ' : 'User clarification ';
        input = draftInputs.map((value, index) => `${index === 0 ? 'Initial workflow request' : followUp + index}:\n${value}`).join('\n\n');
        context ??= turn.draftContextSnapshot ?? previous?.contextSnapshot;
        ctx.state.authorizedRequest.draftInputs = draftInputs;
        ctx.state.authorizedRequest.contextSnapshot = context ?? null;
        draftContext = { draftId: draft.id, operation: draft.operation, goal: draft.goal };
        ctx.state.authorizedRequest.currentDraft = draftContext;
        if (draft.choices.executionMode === 'standard') ctx.state.authorizedRequest.planSource = 'node-options';
      }
      const baseline = Object.hasOwn(authorization, 'baseline') ? authorization.baseline : continuation ? undefined : draft.intentBaseline;
      const mayRepairIntentOutput = draft.operation === 'create' && (!draft.candidate || !!turn.reviewRevision) && !baseline;
      const request = { input,
        context: draftContext ? { currentDraft: draftContext, suppliedContext: context ?? null } : context,
        baseline, baselineId: authorization.baselineId ?? (baseline ? authorIdentity(baseline) : undefined),
        confirmedConstraintIds: authorization.confirmedConstraintIds, signal };
      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const intent = JSON.parse(JSON.stringify(await observed(() => author.analyze(draft, request))));
          const questions = clarificationQuestions(draft, intent, continuation, answered);
          if (!continuation || questions.length ||
            (intent.coverage === 'complete' && !intent.issues.length && !intent.unresolved.length)) {
            ctx.state.effectiveIntent = intent;
            ctx.state.questions = questions;
            break;
          }
          if (!attempt) { ports.retryIntentOutput(); continue; }
          throw Object.assign(authorError('FKA_INTENT_CLARIFICATION_UNVERIFIED',
            'The model did not identify a concrete business decision. Continue on this draft with the answers already saved.'),
          { outcome: 'needs-revision' });
        } catch (error) {
          if (!mayRepairIntentOutput || !isIntentModelOutputError(error)) throw error;
          ports.retryIntentOutput(error);
          if (!attempt) continue;
          throw Object.assign(authorError(error.code,
            'The model could not interpret the saved input. Continue on this draft without re-entering your answers.'),
          { outcome: 'needs-revision', cause: error });
        }
      }
      ctx.state.intentChanges = ctx.state.effectiveIntent.changes;
      ctx.state.baselineEvidence = { ...(draft.intent ? { intent: draft.intent } : {}),
        plan: draft.plan ?? null, candidateHash: draft.candidate?.hash ?? null,
        workflow: draft.previousCandidate ? { manifest: draft.previousCandidate.manifest, files: draft.previousCandidate.files } : null,
        materials: context ?? null };
      if (baseline) ctx.state.baselineEvidence.intentBaseline = baseline;
      if (turn.reviewRevision) ctx.state.baselineEvidence.reviewRejection = turn.reviewRevision;
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
        proposal.unresolvedIssues = proposal.unresolvedIssues.filter(item => !item.id.startsWith('assumption-') && item.kind !== 'coverage-gap');
        ctx.state.rawText = JSON.stringify(proposal); ctx.state.confirmedPlan = true;
      }
    },
    async validatePlan(ctx) {
      ctx.state.currentPlan = null; ctx.state.planDiagnostics = [];
      ctx.state.planSource = null; ctx.state.planHasSource = false;
      let proposal;
      try { proposal = JSON.parse(ctx.state.rawText); }
      catch (error) { ctx.state.planDiagnostics = [{ message: error.message }]; return; }
      try {
        const planningIntent = structuredClone(ctx.state.effectiveIntent);
        if (draft.plan?.intentRef?.effectiveIntentHash === planningIntent.intentRef.effectiveIntentHash &&
          draft.plan.intentRef.changeSetHash === planningIntent.intentRef.changeSetHash) planningIntent.intentRef = draft.plan.intentRef;
        const confirmedSource = ctx.state.confirmedPlan && draft.plan.sourceHash;
        const declaredDecisions = (proposal.unresolvedIssues ?? []).filter(item => item.blocking);
        const assumedDecision = (proposal.assumptions ?? []).some(item => item.requiresConfirmation);
        if (continuation && !ctx.state.confirmedPlan &&
          (assumedDecision || declaredDecisions.some(issue => answered.has(issue.id) || !concretePlanDecision(issue)))) {
          ctx.state.planDiagnostics = [{ code: 'FKA_PLAN_DECISION_UNVERIFIED',
            message: 'Use known choices and Host facts. For a still-missing business decision, supply a distinct question, concrete options with reasons, and a recommendation. Keep already-answered decisions out of blocking issues.' }];
          return;
        }
        const awaitingDecision = declaredDecisions.length > 0 || assumedDecision;
        let compiledPlan;
        if (confirmedSource || (ctx.state.authorizedRequest.planSource === 'node-options' && !awaitingDecision)) {
          compiledPlan = await materializePlan(draft, proposal, { filename: path.join(workspace, 'candidate.workflow.js'), projectRoot: workspace });
          if (confirmedSource && compiledPlan.sourceHash !== confirmedSource) throw authorError('author-conflict', 'Confirmed Plan source changed');
          if (compiledPlan.diagnostics) {
            ctx.state.planDiagnostics = compiledPlan.diagnostics.map(({ code, message, nodeId }) => ({ code, message, nodeId }));
            return;
          }
          proposal = compiledPlan.proposal;
        }
        ctx.state.currentPlan = await author.plan(draft, planningIntent, proposal,
          { previous: draft.plan, graphContext: requestContext, sourceHash: compiledPlan?.sourceHash });
        if (compiledPlan) {
          ctx.state.planSource = compiledPlan.source;
          ctx.state.planHasSource = true;
        }
        const blocking = ctx.state.currentPlan.unresolvedIssues.filter(item => item.blocking);
        if (!ctx.state.confirmedPlan && blocking.length && blocking.every(item => item.kind === 'coverage-gap')) {
          ctx.state.planDiagnostics = blocking.map(({ intentId, description }) => ({
            code: 'FKA_PLAN_COVERAGE_REQUIRED', intentId, message: description
          }));
        }
        const business = blocking.filter(item => item.kind !== 'coverage-gap');
        ctx.state.questions = (ctx.state.confirmedPlan && business.length === 0 ? blocking : business)
          .map(item => planDecision(item, question));
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
      const source = ctx.state.planSource ?? ctx.state.rawText;
      await ports.read({ writeCandidateSource: artifactDigest(source) }, async () => { await writeFile(file, source); return true; });
      let result;
      try {
        result = await ports.read({ compileSource: artifactDigest(source) }, async () => {
          try {
            return await author.prepare(ctx.state.currentPlan, { file, ...draft.target, collectionId: draft.collectionId,
              hostProfile: options.hostProfile, buildId: turn.attemptId, includeSource: draft.choices.includeSource,
              executionMode: draft.choices.executionMode, compilerOptions: { projectRoot: workspace, skillCheck: false },
              documents: ctx.state.resourceSnapshot.documents.map(item => item.evidence),
              professionalSkills: ctx.state.resourceSnapshot.professionalSkills.map(({ nodeId, id, version, digest }) => ({ nodeId, id, version, digest })),
              safetyPolicies: ctx.state.resourceSnapshot.safetyPolicies });
          } catch (error) {
            if (error.code !== 'FKA_PLAN_MISMATCH') throw error;
            return { candidate: null, diagnostics: [{ code: error.code, message: error.message, ...error.detail }] };
          }
        });
      }
      catch (error) {
        if (error.code === 'FKA_HUMAN_LIMIT_REQUIRED') throw clarify(error.message,
          [question(error.nodeId, 'Choose a finite Human revision limit', [2, 1, 3])]);
        if (error.code === 'FKA_SAFETY_POLICY_REQUIRED') throw clarify(error.message,
          [question(error.nodeId, `Approve a Host policy for exact Artifact ${error.artifactHash}`, ['review-exact-policy', 'revise'])]);
        if (/Document|document|Graph/.test(error.message)) throw clarify(error.message, [question('resource-drift', 'Refresh and review the changed resource', ['refresh-review', 'cancel'])]);
        throw error;
      }
      ctx.state.compileDiagnostics = result.diagnostics;
      if (result.candidate) {
        ctx.state.candidate = result.candidate;
        ctx.state.candidateDiff = reviewStandardCandidate(result.candidate, draft.previousCandidate ?? null);
      }
    },
    async bindReviewReceipt(ctx) {
      if (ctx.state.passed !== true || ctx.state.findings.length) {
        ctx.state.reviewRejection = rejectedReview(ctx.state.candidate, ctx.state.findings);
        ctx.state.reviewDiagnostics = [{ code: 'FKA_REVIEW_NOT_QUALIFIED',
          message: 'Independent review did not pass. Use review-only to review the same candidate, or revise it to address a confirmed issue.',
          candidateHash: ctx.state.candidate.hash, nextAction: 'review-only' }];
        return;
      }
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
        typeof result.result?.passed !== 'boolean' || !Array.isArray(result.result?.findings) || result.result.findings.some(item => !isReviewFinding(item)) :
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
        planValid: () => !!value.currentPlan && !value.planDiagnostics.length, planReady: () => value.currentPlan.status === 'ready-for-dsl',
        resourcesReady: () => value.resourceSnapshot.ready === true, compiled: () => !!value.candidate,
        reviewPassed: () => !!value.reviewReceipt }[name]();
    }
  };
  try {
    const coreRoot = new URL('./core/', import.meta.url);
    const identity = options.coreIdentity;
    const result = await runArtifact(fileURLToPath(new URL('workflow.js', coreRoot)), identity.artifactHash, runtime, state,
      { signal, projectRoot: options.workRoot, skillCheck: false });
    // The generated workflow routes action failures through its needs-info
    // terminal. Preserve the explicit technical recovery state in the Host.
    if (result.error?.outcome === 'needs-revision') throw result.error;
    return { outcome: result.terminal === 'candidate-ready' ? 'candidate-ready' : result.terminal === 'needs-info' ?
      'needs-clarification' : 'needs-revision', state: result.state, coreIdentity: identity, intentBaseline };
  } finally {
    // Only remove this invocation's owned temporary directory, never Host resources or published files.
    if (path.dirname(workspace) === path.resolve(options.workRoot) && path.basename(workspace).startsWith('.flowkit-author-')) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}
