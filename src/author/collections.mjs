import { randomUUID } from 'node:crypto';
import { artifactDigest } from '../shared/artifact-identity.mjs';
import { skillDocument, validateSkillName } from './skill-document.mjs';

const DEFAULT_NAME = 'flowkit-workflows';
const DEFAULT_DESCRIPTION = 'Find, use, and author workflows and their Professional Skills for this collection.';
const ROOT_GUIDE = [
  '# Workflow collection',
  'Select an existing Workflow Skill or Professional Skill under `skills/`. Both types live at that same level.',
  'To create or update a Workflow Skill, use `flowkit-workflow-author`. Clarify the intent with Intent Runtime, ' +
    'discover relevant capabilities and documentation with Capability Graph, compile, review the semantics and ' +
    'obtain user approval before publishing.',
  'For existing workflows, follow the selected Skill’s entry instructions. See the [FlowKit documentation](https://devcodex-labs.github.io/flowkit/).'
].join('\n\n');

function collection(id, name, description) {
  if (typeof id !== 'string' || !id.trim() || /\s/.test(id)) throw new TypeError('A logical collection ID is required');
  const rootSkill = skillDocument(name, description, ROOT_GUIDE);
  return Object.freeze({ id, name, directory: name, description, rootSkill });
}

export function verifiedCollectionPlan(proposedPlan) {
  const plan = structuredClone(proposedPlan);
  const { destination, operation, sourceId } = plan;
  const { id, name, description } = destination;
  const expected = collection(id, name, description);
  if (destination.directory !== expected.directory || destination.rootSkill !== expected.rootSkill ||
    !['create', 'copy', 'migrate', 'rename'].includes(operation) ||
    (operation === 'create' && sourceId !== null) ||
    (operation === 'copy' && (!sourceId || sourceId === id)) ||
    (['migrate', 'rename'].includes(operation) && sourceId !== id)) {
    throw new TypeError('Collection plan does not match its operation, identity or layout');
  }
  if (operation === 'rename' && (!Array.isArray(plan.directory) || !Array.isArray(plan.skillName) ||
    plan.directory[1] !== destination.directory || plan.skillName[1] !== destination.name ||
    !Array.isArray(plan.workflowReferences) || !Array.isArray(plan.mcpResources) || !Object.hasOwn(plan, 'hostMapping'))) {
    throw new TypeError('Collection rename needs the reviewed mapping and affected references');
  }
  if (operation === 'rename' && !/^sha256:[0-9a-f]{64}$/.test(plan.expectedSnapshotHash ?? '')) {
    throw new TypeError('Collection rename needs the reviewed collection snapshot hash');
  }
  return { plan: Object.freeze({ ...plan, destination: expected }), planHash: artifactDigest(JSON.stringify(plan)) };
}

/** One snapshot covers one Host discovery scope. `directoryOwner` checks reserved/unmanaged directories. */
export function planNewCollection({ name = DEFAULT_NAME, description = DEFAULT_DESCRIPTION, source, preserveId = false },
  discovered, directoryOwner) {
  if (typeof preserveId !== 'boolean' || preserveId && !source) throw new TypeError('Explicit migration needs a source collection');
  const destination = collection(preserveId ? source.id : randomUUID(), name, description);
  rejectConflicts(destination, discovered, directoryOwner);
  const operation = !source ? 'create' : preserveId ? 'migrate' : 'copy';
  return Object.freeze({ operation, destination, sourceId: source?.id ?? null });
}

function rejectConflicts(destination, discovered, directoryOwner, previous) {
  for (const current of discovered) {
    if (current === previous) continue;
    if (current.id === destination.id) {
      throw new Error(`Collection ID ${destination.id} belongs to ${current.directory}. Import as a new collection or resolve the existing mapping.`);
    }
    if (current.name.toLowerCase() === destination.name || current.directory.toLowerCase() === destination.directory) {
      throw new Error(`Collection name or directory ${destination.name} is in use by ${current.id}. Choose another name.`);
    }
  }
  const occupied = directoryOwner(destination.directory);
  if (occupied && occupied !== previous?.id) {
    throw new Error(`Directory ${destination.directory} is occupied by ${occupied}. Choose another name.`);
  }
}

/** Host mappings and affected references come from discovery, so preview uses the real namespace. */
export function planCollectionRename({ id, name }, discovered, host) {
  const previous = discovered.find(entry => entry.id === id);
  if (!previous) throw new Error(`Unknown collection ${id}`);
  const destination = collection(id, name, previous.description);
  if (previous.name === name && previous.directory === name) throw new Error('Choose a different collection name');
  rejectConflicts(destination, discovered, directory => host.directoryOwner(directory), previous);
  const changes = host.previewMigration(previous, destination);
  if (!changes || !/^sha256:[0-9a-f]{64}$/.test(changes.expectedSnapshotHash ?? '') || !Array.isArray(changes.workflowReferences) || !Array.isArray(changes.mcpResources) ||
    !Object.hasOwn(changes, 'hostMapping')) {
    throw new Error(`Host cannot verify the migration and references for ${id}`);
  }
  return Object.freeze({ operation: 'rename', destination, sourceId: id,
    directory: [previous.directory, destination.directory], skillName: [previous.name, destination.name],
    ...structuredClone({ expectedSnapshotHash: changes.expectedSnapshotHash, hostMapping: changes.hostMapping, mcpResources: changes.mcpResources,
      workflowReferences: changes.workflowReferences }) });
}

/** A collection-qualified identity and a two-layer path apply to both second-layer Skill kinds. */
export function collectionSkill(current, { id, name }) {
  validateSkillName(current.name);
  validateSkillName(name);
  if (current.directory !== current.name || typeof id !== 'string' || !id || /\s/.test(id)) {
    throw new TypeError('Skill identity needs a consistent collection directory and logical Skill ID');
  }
  return Object.freeze({ collectionId: current.id, skillId: id, directory: `${current.directory}/skills/${name}` });
}
