import { createWorkflowAuthorHost, type AuthorHostOptions, type AuthorRequestContext } from '@devcodex-labs/flowkit/host';
export async function connect(options: AuthorHostOptions, context: AuthorRequestContext) {
  const host = await createWorkflowAuthorHost(options);
  try {
    const draft = await host.start({ collectionId: context.authorizedCollections[0], requestId: 'first', goal: 'Inspect' }, context);
    return await host.readDraft({ draftId: draft.id }, context);
  } finally { await host.close({ mode: 'cancel' }); }
}
