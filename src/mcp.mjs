import { McpServer } from '@modelcontextprotocol/server';
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { workflowExecutionModes } from './interactive/protocol.mjs';
import { hasLongAuthorMaterials } from './author/document-work.mjs';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const response = text => ({ content: [{ type: 'text', text }] });
const responseLimitCode = 'FKA_RESPONSE_LIMIT';
const minimumErrorText = JSON.stringify({ error: { code: responseLimitCode } });

/** Bind one MCP connection to one authenticated Host scope and the existing Author services. */
export function createFlowkitMcpServer({ namespace, collectionIds, store, authorHost, requestContext, authorize,
  resolveAuthoringInput, resolveCollectionPlan, applyCollectionPlan, runWorkflow, workflowUi, queueAuthoringTurn, nativeSkillDiscovery = false, limits = {} },
  transportSignal = undefined) {
  if (typeof namespace !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace) ||
    !Array.isArray(collectionIds) || collectionIds.some(value => typeof value !== 'string' || !value) ||
    typeof authorize !== 'function') throw new TypeError('MCP requires a Host-bound namespace, collections and authorization');
  const pageSize = limits.pageSize ?? 50;
  const maxBytes = limits.maxResourceBytes ?? 262144;
  const maxResponseBytes = limits.maxResponseBytes ?? 262144;
  const maxMetadataEntries = limits.maxMetadataEntries ?? 10000;
  if (![pageSize, maxBytes, maxResponseBytes,maxMetadataEntries].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('MCP limits must be positive integers');
  }
  if (maxResponseBytes < Buffer.byteLength(minimumErrorText)) throw new TypeError('MCP response budget must fit an error code');
  const allowed = new Set(collectionIds);
  const server = new McpServer({ name: 'flowkit', version: '1.0.0' }, workflowUi ? {
    instructions: 'Use flowkit_start_workflow to create a draft, then flowkit_prepare_workflow with a turn to clarify or compile. ' +
      'When preparation returns a running draft, use flowkit_get_workflow_draft with its ID to get the result. ' +
      (workflowUi.recover ? 'For a draft with recovery information, use flowkit_recover_workflow before sending another turn. ' : '') +
      'Open the candidate preview for visual review and user confirmation. Use flowkit_export_workflow for the three files and ' +
      'flowkit_add_workflow only for an explicit request to add the exact candidate or import a selected source.'
  } : undefined);
  const baseUri = `skill://${namespace}/`;

  async function access(operation, collectionId, ctx) {
    ctx?.signal?.throwIfAborted();
    if (!allowed.has(collectionId) || await authorize({ namespace, collectionId, operation, signal: ctx?.signal }, requestContext) !== true) {
      throw new Error('FlowKit access denied for this collection');
    }
    ctx?.signal?.throwIfAborted();
  }

  function catalog(collectionId) {
    if (!store) throw new Error('Host approved Skill store is unavailable');
    const snapshot = typeof store.readCollectionMetadata === 'function' ? store.readCollectionMetadata(collectionId,
      {limit:Math.min(Number.MAX_SAFE_INTEGER,maxMetadataEntries+1)}) : store.readCollection(collectionId);
    if (!snapshot) throw new Error('Collection is unavailable');
    return snapshot;
  }

  const metadata = candidate => ({ skillId: candidate.manifest.skillId, name: candidate.manifest.name,
    version: candidate.manifest.version, candidateHash: candidate.hash, kind: candidate.manifest.kind ?? 'workflow' });
  const author = () => {
    if (!authorHost || !requestContext || requestContext.namespace !== namespace) throw new Error('Authenticated AuthorHost request binding is unavailable');
    return authorHost;
  };
  const draftView = draft => workflowUi ? workflowUi.present(draft, requestContext) : Object.fromEntries(['id', 'status', 'collectionId', 'stateVersion', 'contentRevision', 'contentHash',
    'goal', 'target', 'choices', 'questions', 'plan', 'candidate', 'previousHash', 'diff', 'diagnostics', 'reviewReceipt', 'approvalReceipt',
    'reviewRejection', 'documentProgress', 'reconciliationRequired']
    .filter(key => Object.hasOwn(draft, key)).map(key => [key, draft[key]]));
  async function exactDraft(collectionId, draftId, signal) {
    const draft = await author().readDraft({ draftId }, requestContext, signal);
    if (draft.collectionId !== collectionId) throw new Error('Draft belongs to a different collection');
    return draft;
  }

  function toolError(error, recovery) {
    const code = typeof error?.code === 'string' ? error.code : 'FKA_HOST_OPERATION_FAILED';
    const details = { code };
    if (typeof error?.retryable === 'boolean') details.retryable = error.retryable;
    if (['none', 'known', 'unknown'].includes(error?.sideEffectStatus)) details.sideEffectStatus = error.sideEffectStatus;
    if (recovery) details.recovery = recovery;
    let text;
    try {
      text = JSON.stringify({ error: { ...details, message: error?.message ?? String(error),
        ...(error?.questions ? { questions: error.questions } : {}),
        ...(error?.options ? { options: error.options, recommended: error.recommended } : {}) } });
    } catch { /* The bounded fallback also covers non-JSON details from the Host. */ }
    if (text === undefined || Buffer.byteLength(text) > maxResponseBytes) {
      text = JSON.stringify({ error: details });
      if (Buffer.byteLength(text) > maxResponseBytes) text = JSON.stringify({ error: { code } });
      if (Buffer.byteLength(text) > maxResponseBytes) text = minimumErrorText;
    }
    return { ...response(text), isError: true };
  }

  const draftResponses = new Set(['flowkit_start_workflow', 'flowkit_prepare_workflow', 'flowkit_get_workflow_draft', 'flowkit_recover_workflow']);
  function responseError(name, input, result, error) {
    let recovery, sideEffectStatus;
    if (name === 'flowkit_publish_candidate' && result?.publicationId === input.publicationId && result.status === 'saved') {
      recovery = { draftId: input.draftId, publicationId: input.publicationId };
      sideEffectStatus = 'known';
    } else if (name === 'flowkit_run_workflow') {
      recovery = { executionRef: input.executionRef };
      sideEffectStatus = 'unknown';
    } else if (name === 'flowkit_apply_collection_plan') {
      recovery = { planRef: input.planRef };
      sideEffectStatus = 'unknown';
    } else if (draftResponses.has(name) && typeof result?.id === 'string') {
      recovery = { draftId: result.id };
    }
    return toolError(Object.assign(new Error(error?.message ?? String(error), {cause:error}), {
      code: error?.code, retryable: false, sideEffectStatus
    }), recovery);
  }

  const accessDenied = new Error('FlowKit access denied for this collection');
  function tool(name, description, schema, invoke, readOnlyHint = false, readAfterAuthorization) {
    const inputSchema = z.object(workflowUi ? { ...schema, collectionId: id.optional() } : schema).strict();
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint } },
      async (args, request) => {
        const requestSignal = request.mcpReq.signal;
        const ctx = { ...request, signal: transportSignal ? AbortSignal.any([requestSignal, transportSignal]) : requestSignal };
        const input = workflowUi ? { ...args, collectionId: args.collectionId ?? workflowUi.defaultCollectionId } : args;
        const allowed = () => access(name, input.collectionId, ctx).then(() => true, () => false);
        if (!await allowed()) return toolError(accessDenied);
        let outcome;
        try {
          outcome = { result: await invoke(input, ctx) };
        } catch (error) {
          outcome = { error };
        }
        // A failed invocation can also have executed before access was revoked.
        if (!await allowed()) return toolError(accessDenied);
        if (Object.hasOwn(outcome, 'error')) return toolError(outcome.error);
        let { result } = outcome;
        if (readAfterAuthorization) {
          try { result = await readAfterAuthorization(result,input,ctx); }
          catch (error) { return toolError(error); }
        }
        try {
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text) > maxResponseBytes) {
            const error = Object.assign(new Error('Tool response exceeds the Host response byte budget'), {code:responseLimitCode});
            return responseError(name,input,result,error);
          }
          return response(text);
        } catch (error) {
          return responseError(name,input,result,error);
        }
      });
  }

  if (!nativeSkillDiscovery) tool('flowkit_collection', 'Read one bounded page of approved collection metadata.', { collectionId: id,cursor:z.string().optional() },
    ({ collectionId,cursor }) => { const { collection, skills } = catalog(collectionId);
      const offset=cursor===undefined?0:Number(cursor);
      if(!Number.isSafeInteger(offset)||offset<0||cursor!==undefined&&String(offset)!==cursor)throw new Error('Invalid Skill cursor');
      if(skills.length>maxMetadataEntries)throw new Error('Scope collection discovery within the metadata entry budget');
      const visibleCollection = workflowUi ? { id: collection.id, name: collection.name, description: collection.description } : collection;
      const page={collection:visibleCollection,skills:skills.slice(offset,offset+pageSize).map(metadata),
        ...(offset+pageSize<skills.length?{nextCursor:String(offset+pageSize)}:{})};
      if(Buffer.byteLength(JSON.stringify(page))>maxBytes)throw new Error('Collection page exceeds the metadata byte budget');
      return page; }, true);
  if (workflowUi?.matchCapability) tool('flowkit_match_capability', 'Find an authorized FlowKit capability for a goal. Discovery does not execute a workflow.',
    { collectionId: id, goal: z.string().trim().min(1).max(65536) },
    ({ goal }, ctx) => workflowUi.matchCapability({ goal }, requestContext, ctx.signal), true);
  tool('flowkit_start_workflow', 'Start a workflow draft using known collection choices.', {
    collectionId: id, requestId: id, operation: z.enum(['create', 'update', 'import']), goal: z.string().min(1).max(maxBytes),
    targetRef: z.union([z.object({ collectionId: id, skillId: id, baseArtifactHash: hash, baseVersion: id }).strict(),
      z.object({ sourceRef: id, mode: z.enum(['new-collection', 'migration']) }).strict()]).optional(),
    executionMode: z.enum(workflowExecutionModes).optional(),
    includeSource: z.boolean().optional()
  }, async ({ collectionId, goal, requestId, operation, targetRef, executionMode, includeSource }, ctx) => draftView(await author().start({ collectionId,
    goal, requestId, operation, ...(operation === 'import' ? { importSource: targetRef } : { targetRef }), choices: { collectionName: catalog(collectionId).collection.name,
      ...(executionMode ? { executionMode } : {}), ...(workflowUi ? { includeSource: false } :
        includeSource === undefined ? {} : { includeSource }) } }, requestContext, ctx.signal)));
  const turn = z.object({
    draftId: id, turnId: id, expectedStateVersion: z.number().int().positive(), input: z.string().min(1).max(maxBytes),
    kind: z.enum(['authoring', 'review-only']).optional(), candidateHash: hash.optional(), confirmedPlanHash: hash.optional(),
    reconfirmIntentBaseline: z.boolean().optional(),
    useCapabilityGraph: z.boolean().optional().describe('Request authorized capability discovery before planning when the task needs it.'),
    choices: z.object({ executionMode: z.enum(workflowExecutionModes).optional() }).strict().optional(),
    target: z.object({ name: id.optional(), version: id.optional() }).strict().optional()
  }).strict();
  const material = z.object({ id, title: z.string().trim().min(1).max(160), content: z.string().min(1).max(12000) });
  const materialSources = z.array(z.discriminatedUnion('kind', [
    material.extend({ kind: z.literal('text') }).strict(),
    z.object({ kind: z.literal('material'), id, sha256: hash }).strict(),
    z.object({ kind: z.literal('design'), ref: id, sha256: hash, groupId: id.optional() }).strict()
  ])).min(1).max(6);
  const sourceOptions = workflowUi?.authoringMaterials ? { sources: materialSources.optional() } : {};
  tool('flowkit_prepare_workflow', 'Compile a Host-selected planned input into a reviewable Workflow Skill candidate.',
    { collectionId: id, ...(workflowUi ? { inputRef: id.optional(), turn: turn.optional() } : { inputRef: id }), ...sourceOptions },
    async ({ collectionId, inputRef, turn, sources }, { signal }) => {
      signal.throwIfAborted();
      if (Boolean(inputRef) === Boolean(turn)) throw new Error('Provide exactly one inputRef or turn');
      if (inputRef && typeof resolveAuthoringInput !== 'function') throw new Error('Host AuthoringInput resolver is unavailable');
      let input = turn ?? await resolveAuthoringInput({ namespace, collectionId, inputRef, requestContext, signal });
      const draft = await exactDraft(collectionId, input.draftId, signal);
      if (workflowUi?.authoringMaterials) input = await workflowUi.authoringMaterials({ input, sources, draft }, requestContext, signal);
      signal.throwIfAborted();
      // Once admitted, the shared turn outlives the client wait.
      if (workflowUi && queueAuthoringTurn && hasLongAuthorMaterials(input.contextSnapshot)) {
        return draftView(await queueAuthoringTurn(input, requestContext, signal));
      }
      return draftView(await author().advanceTurn(input, requestContext, undefined, { admissionSignal: signal }));
    });
  tool('flowkit_review_candidate', 'Read candidate review evidence, or the exact saved receipt when publicationId is supplied.',
    { collectionId: id, draftId: id, candidateHash: hash, previousHash: hash.nullable(), publicationId: id.optional() }, async ({ collectionId, ...input }, ctx) => {
      await exactDraft(collectionId, input.draftId, ctx.signal);
      if (input.publicationId !== undefined) return null;
      const review = await author().reviewCandidate(input, requestContext, ctx.signal);
      return workflowUi ? workflowUi.review(review) : review;
    }, true, (review,input,ctx) => input.publicationId === undefined
      ? review : author().readPublication(input,requestContext,ctx.signal));
  tool('flowkit_publish_candidate', 'Publish an exact candidate after Host review and approval verification.',
    { collectionId: id, draftId: id, expectedStateVersion: z.number().int().positive(), publicationId: id,
      candidateHash: hash, previousHash: hash.nullable(), reviewRef: id, approvalRef: id },
    async ({ collectionId, ...input }, ctx) => {
      await exactDraft(collectionId, input.draftId, ctx.signal);
      const published = await author().publish(input, requestContext, ctx.signal);
      return Object.fromEntries(['publicationId', 'candidateHash', 'previousHash', 'status', 'discovery', 'currentActive', 'isCurrent', 'stateVersion', 'generation']
        .filter(key => Object.hasOwn(published, key)).map(key => [key, published[key]]));
    });
  tool('flowkit_discard_candidate', 'Discard a session candidate without changing approved Skill versions.',
    { collectionId: id, draftId: id, expectedStateVersion: z.number().int().positive(), candidateHash: hash.nullable() }, async ({ collectionId, ...input }, ctx) => {
      await exactDraft(collectionId, input.draftId, ctx.signal);
      return draftView(await author().discard(input, requestContext, ctx.signal));
    });
  if (!workflowUi || typeof resolveCollectionPlan === 'function' && typeof applyCollectionPlan === 'function') {
    tool('flowkit_apply_collection_plan', 'Apply a Host-selected reviewed collection creation or migration plan.',
      { collectionId: id, planRef: id, approvalRef: id }, async ({ collectionId, planRef, approvalRef }, ctx) => {
        if (typeof resolveCollectionPlan !== 'function') throw new Error('Host collection binding is unavailable');
        const plan = await resolveCollectionPlan({ namespace, collectionId, planRef, requestContext, signal: ctx.signal });
        if (plan.destination.id !== collectionId) throw new Error('Host collection plan belongs to a different collection');
        if (typeof applyCollectionPlan !== 'function') throw new Error('Host collection approval binding is unavailable');
        return applyCollectionPlan(plan, approvalRef, requestContext, ctx.signal);
      });
  }
  if (!workflowUi || typeof runWorkflow === 'function') {
    tool('flowkit_run_workflow', 'Run a fixed approved Artifact using the Host execution binding. Present runUrl to the operator when returned.',
      { collectionId: id, skillId: id, candidateHash: hash, executionRef: id }, async (input, ctx) => {
        if (typeof runWorkflow !== 'function') throw new Error('Host execution binding is unavailable');
        return runWorkflow({ namespace, ...input, requestContext, signal: ctx.signal });
      });
  }

  if (workflowUi) {
    if (workflowUi.design) tool('flowkit_create_design_diagram', 'Create one source-backed offline project design HTML. Poll running or draining with the same request ID and sources. Continue only with the resumeToken returned after physical cleanup.',
      { collectionId: id, requestId: id, title: z.string().trim().min(1).max(120), materials: z.array(material.strict()).min(1).optional(),
        resumeToken: id.optional(),
        sources: z.array(z.discriminatedUnion('kind', [material.extend({ kind: z.literal('text') }).strict(),
          z.object({ kind: z.literal('material'), id, sha256: hash }).strict()])).min(1).optional() }, (input, ctx) => {
        if (Boolean(input.materials) === Boolean(input.sources)) throw new Error('Provide exactly one materials or sources selection');
        return workflowUi.design(input, requestContext, ctx.signal);
      });
    tool('flowkit_get_workflow_draft', 'Read the current candidate and its preview after a user decision.',
      { collectionId: id, draftId: id }, async ({ collectionId, draftId }, ctx) =>
        draftView(await exactDraft(collectionId, draftId, ctx.signal)), true);
    if (workflowUi.recover) {
      tool('flowkit_recover_workflow', 'Reconcile an interrupted local Author draft without replaying unknown effects.',
        { collectionId: id, draftId: id, expectedStateVersion: z.number().int().positive() },
        async ({ collectionId, ...input }, ctx) => {
          await exactDraft(collectionId, input.draftId, ctx.signal);
          return draftView(await workflowUi.recover(input, requestContext, ctx.signal));
        });
    }
    if (workflowUi.relayout) tool('flowkit_relayout_workflow', 'Arrange an exact candidate again. Open the returned preview and pass its layout revision when exporting.',
      { collectionId: id, draftId: id, candidateHash: hash, expectedLayoutRevision: hash, requestId: id },
      async (input, ctx) => {
        await exactDraft(input.collectionId, input.draftId, ctx.signal);
        return workflowUi.relayout(input, requestContext, ctx.signal);
      });
    tool('flowkit_export_workflow', 'Export the three public files for an exact confirmed candidate, or renew download links using its export receipt.',
      { collectionId: id, draftId: id, candidateHash: hash, exportReceipt: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        ...(workflowUi.relayout ? { layoutRevision: hash.optional() } : {}) },
      (input, ctx) => workflowUi.export(input, requestContext, ctx.signal));
    tool('flowkit_add_workflow', 'Add a verified candidate or inspect the supported destinations for an external workflow.',
      { collectionId: id, requestId: id, sourceRef: id, candidateHash: hash.optional(), approvalRef: id.optional(),
        destination: z.enum(['flowkit','codex']).optional() }, (input, ctx) => workflowUi.add(input, requestContext, ctx.signal));
    return server;
  }

  function skillPath(candidate) {
    const { collectionId, skillId, name } = candidate.manifest;
    return [collectionId, skillId, candidate.hash.slice(7), name].map(encodeURIComponent).join('/');
  }

  async function findFile(uri, ctx) {
    if (typeof uri !== 'string' || !uri.startsWith(baseUri)) return undefined;
    const parts = uri.slice(baseUri.length).split('/');
    let collectionId;
    try { collectionId = decodeURIComponent(parts[0]); } catch { return undefined; }
    await access('resources/read', collectionId, ctx);
    if (parts.length < 5 || !/^[a-f0-9]{64}$/.test(parts[2])) return undefined;
    let skillId;
    try { skillId = decodeURIComponent(parts[1]); } catch { return undefined; }
    const candidate = store.readVersion(collectionId, skillId, `sha256:${parts[2]}`);
    if (!candidate) return undefined;
    const prefix = baseUri + skillPath(candidate) + '/';
    if (!uri.startsWith(prefix)) return undefined;
    const relative = uri.slice(prefix.length);
    if (!Object.hasOwn(candidate.files, relative)) return undefined;
    const text = candidate.files[relative];
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Resource exceeds this Host read budget');
    return { candidate, text };
  }

  const source = {
    async list({ cursor }, ctx) {
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || cursor !== undefined && String(offset) !== cursor) throw new Error('Invalid Skill cursor');
      const skills = [];
      for (const collectionId of allowed) {
        await access('skills/list', collectionId, ctx);
        const listed=catalog(collectionId).skills;
        if(skills.length+listed.length>maxMetadataEntries)throw new Error('Scope Skill discovery within the metadata entry budget');
        skills.push(...listed);
      }
      skills.sort((a, b) => skillPath(a).localeCompare(skillPath(b)));
      const selected = skills.slice(offset, offset + pageSize);
      const result={skills:await Promise.all(selected.map(async item=>{
        const candidate=item.files?item:store.readVersion(item.manifest.collectionId,item.manifest.skillId,item.hash);
        if(!candidate)throw new Error('Listed approved Skill is unavailable');
        return skillEntry(skillPath(candidate),candidate.files,{baseUri});
      })),...(offset+pageSize<skills.length?{nextCursor:String(offset+pageSize)}:{})};
      if(Buffer.byteLength(JSON.stringify(result))>maxBytes)throw new Error('Skill page exceeds the metadata byte budget');
      return result;
    },
    async get(uri, ctx) {
      const file = await findFile(uri, ctx);
      return file && uri.endsWith('/SKILL.md') ? skillEntry(skillPath(file.candidate), file.candidate.files, { baseUri }) : undefined;
    },
    async read(uri, ctx) {
      const file = await findFile(uri, ctx);
      return file ? { text: file.text, mimeType: uri.endsWith('.md') ? 'text/markdown' : 'text/plain' } : undefined;
    },
    async listResources(ctx) {
      const resources = [];
      let cursor;
      do {
        const page = await source.list({ cursor }, ctx);
        resources.push(...page.skills.map(skill => ({ uri: skill.uri, name: skill.frontmatter.name, mimeType: 'text/markdown' })));
        if (Buffer.byteLength(JSON.stringify(resources)) > maxBytes) throw new Error('Use scoped Skill discovery within the metadata budget');
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return resources;
    }
  };
  if (!nativeSkillDiscovery) new SkillsExtension({ source, baseUri, cacheHint: { ttlMs: 0, cacheScope: 'private' } }).attach(server);
  return server;
}

export async function connectFlowkitStdio(options) {
  const server = createFlowkitMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

/** HTTP integration authenticates every request before binding its services. */
export function createFlowkitHttpHandler(resolveHost) {
  if (typeof resolveHost !== 'function') throw new TypeError('HTTP requires a Host authentication resolver');
  return async (request, response) => {
    const options = await resolveHost(request);
    if (!options) { response.writeHead(401); response.end(); return; }
    const disconnect = new AbortController();
    const onClose = () => { if (!response.writableFinished) disconnect.abort(); };
    response.once('close', onClose);
    if (response.destroyed) onClose();
    const server = createFlowkitMcpServer(options, disconnect.signal);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      response.off('close', onClose);
      await server.close();
    }
  };
}
