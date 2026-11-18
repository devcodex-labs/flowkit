import { randomUUID } from 'node:crypto';
import { stageCollectionForDiscovery } from './collection-layout.mjs';
import { removeCollectionGeneration } from './collection-layout.mjs';
import { planCollectionGeneration } from './generation.mjs';
import { authorIdentity as hash } from './host-target.mjs';
import { authorError } from './host-budget.mjs';

const currentSnapshot = (store, id) => store.readCollectionMetadata(id, { limit: 10001 });
function expand(store, frozen) {
  return { collection: frozen.collection, skills: frozen.skills.map(item => {
    const candidate = store.readVersion(frozen.collection.id, item.manifest.skillId, item.hash);
    if (!candidate) throw authorError('author-reconcile', 'Frozen approved version is unavailable');
    return candidate;
  }) };
}

/** Reconcile one immutable saved operation. A replay never writes the active Skill pointer. */
export async function discoverPublication({ store, options, draftId, publicationId, context, signal, read, mutate, authorize }) {
  let draft = read(draftId), op = draft.publications[publicationId];
  if (op.generationRemoved) return;
  const writeOp = operation => mutate(draftId, undefined, current => {
    const currentOp = current.publications[publicationId];
    operation(currentOp);
    if (current.savedReceipt?.publicationId === publicationId) current.savedReceipt = currentOp;
  });
  const stale = () => hash(currentSnapshot(store, draft.collectionId)) !== op.snapshotHash ||
    store.readActive(draft.collectionId, draft.target.skillId)?.hash !== op.candidateHash;
  const supersede = () => writeOp(current => { current.discovery = 'superseded'; });
  if (stale()) { supersede(); return; }
  const discovery = options.discovery;
  if (!discovery?.root || typeof discovery.readMapping !== 'function' || typeof discovery.compareAndSetMapping !== 'function') return;
  const scope = { namespace: options.namespace, collectionId: draft.collectionId, requestContext: context, signal };
  try {
    await authorize('discovery', draft.collectionId, context, signal, { draftId, publicationId });
    if (!op.plannedGeneration) {
      const snapshot = expand(store, op.collectionSnapshot);
      const plan = planCollectionGeneration(snapshot, discovery.root, { namespace: options.namespace, publicationId, operationId: op.operationId,
        generationId: randomUUID(), snapshotHash: op.snapshotHash });
      const expected = await discovery.readMapping(scope);
      writeOp(current => {
        if (!current.plannedGeneration) { current.plannedGeneration = plan; current.mappingExpected = expected ?? null; }
      });
    }
    draft = read(draftId); op = draft.publications[publicationId];
    if (stale()) { supersede(); return; }
    const generated = await stageCollectionForDiscovery(store, draft.collectionId, discovery.root,
      { snapshot: expand(store, op.collectionSnapshot), plan: op.plannedGeneration, signal });
    writeOp(current => { current.generation = generated; });
    await authorize('discovery-switch', draft.collectionId, context, signal, { draftId, publicationId, generation: generated });
    if (stale()) { supersede(); return; }
    const matches = mapping => mapping?.generationId === generated.generationId && mapping?.snapshotHash === op.snapshotHash && mapping?.operationId === op.operationId &&
      mapping?.discoveryRoot === generated.discoveryRoot && mapping?.manifestHash === generated.manifestHash;
    let mapping = await discovery.readMapping(scope);
    if (!matches(mapping)) {
      let expected = op.mappingExpected;
      if (hash(mapping ?? null) !== hash(expected ?? null)) {
        const predecessor = store.authorTransaction(state => state.findPublication(mapping?.operationId));
        if (!predecessor || predecessor.collectionId !== draft.collectionId || predecessor.sequence >= op.sequence) {
          supersede(); return;
        }
        expected = mapping;
        writeOp(current => { current.mappingExpected = expected; });
      }
      if (stale()) { supersede(); return; }
      await authorize('discovery-switch', draft.collectionId, context, signal, { draftId, publicationId, generation: generated, mappingExpected: expected });
      await discovery.compareAndSetMapping({ ...scope, expected: expected ?? null,
        next: { generationId: generated.generationId, discoveryRoot: generated.discoveryRoot,
          snapshotHash: op.snapshotHash, manifestHash: generated.manifestHash, operationId: op.operationId }, operationId: op.operationId });
      mapping = await discovery.readMapping(scope);
    }
    if (stale()) { supersede(); return; }
    if (!matches(mapping)) {
      writeOp(current => { current.discovery = 'pending'; current.discoveryError = { code: 'FKA_MAPPING_PENDING', message: 'Host mapping CAS/readback did not confirm this operation' }; });
      return;
    }
    writeOp(current => { current.discovery = 'active'; current.mappingReceipt = mapping; delete current.discoveryError; });
  } catch (error) {
    // Retain saved data and exact owned paths. Never remove an orphan or downgrade a completed winner.
    writeOp(current => {
      if (current.discovery === 'active' || current.discovery === 'superseded') return;
      current.discovery = 'pending'; current.discoveryError = { code: error.code ?? 'FKA_DISCOVERY_PENDING', message: error.message };
    });
  }
}

/** Host reference evidence must close admission of new Runs before an owned generation can be removed. */
export async function cleanupPublicationGeneration({ store, options, draft, generationId, context, signal, authorize }) {
  const op = Object.values(draft.publications).find(value => value.generation?.generationId === generationId);
  const discovery = options.discovery;
  if (!op?.plannedGeneration || !discovery?.readMapping || !discovery.compareAndSetMapping || !discovery.readReferences) {
    throw authorError('author-executor', 'Generation cleanup needs an exact owned generation, mapping CAS and Host Run reference evidence');
  }
  const scope = { namespace: options.namespace, collectionId: draft.collectionId, requestContext: context, signal,
    generationId, discoveryRoot: op.generation.discoveryRoot };
  const references = async () => {
    await authorize('discovery-cleanup', draft.collectionId, context, signal, { draftId: draft.id, generationId });
    const proof = await discovery.readReferences(scope);
    if (!proof?.evidenceRef || proof.generationId !== generationId || proof.referenced !== false || proof.closedForNewRuns !== true) {
      throw authorError('author-reconcile', 'Generation is referenced or Host has not closed new Run admission');
    }
  };
  await references();
  let mapping = await discovery.readMapping(scope);
  const mapped = value => value?.generationId === generationId || value?.discoveryRoot === scope.discoveryRoot;
  if (mapped(mapping)) {
    await discovery.compareAndSetMapping({ ...scope, expected: mapping, next: null, operationId: op.operationId + ':cleanup' });
    mapping = await discovery.readMapping(scope);
    if (mapped(mapping)) throw authorError('author-reconcile', 'Generation remains mapped; retain it');
  }
  await references();
  return removeCollectionGeneration({ hostOwnedRoot: discovery.root, discoveryRoot: scope.discoveryRoot, collectionId: draft.collectionId,
    authorizeRemoval: async ({ manifestHash }) => {
      if (manifestHash !== op.generation.manifestHash) return false;
      await references();
      return !mapped(await discovery.readMapping(scope));
    } });
}
