import { DSL_FIELDS } from '../shared/contracts.mjs';
import { diagnostic, pointerChild } from './source.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const idValid = value => typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.exec(value)?.[0] === value;
const lineBreak = /[\r\n\u2028\u2029]/;

/** SemVer 2.0 validation without coercing identifiers to bounded JS numbers. */
export function isSemVer(value) {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && match[0] === value && (!match[4] || match[4].split('.').every(part => !/^\d+$/.test(part) || part === '0' || part[0] !== '0'));
}

/** Validate local fields only; reference existence and regions belong to the graph pass. */
export function validateFields(literal, context) {
  const { definition, locations, keyLocations, constructors } = literal;
  const diagnostics = [];
  function report(code, pointer, message, nodeId, key = false) {
    let parent = pointer;
    while (!locations.has(parent) && parent) parent = parent.slice(0, parent.lastIndexOf('/'));
    diagnostics.push(diagnostic(context.source, code, message,
      (key ? keyLocations.get(pointer) : undefined) ?? locations.get(pointer) ?? locations.get(parent), nodeId));
  }
  function unknown(value, allowed, pointer, code, nodeId) {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) {
      report(code, pointerChild(pointer, key), `Unknown field: ${key}`, nodeId, true);
    }
  }
  unknown(definition, DSL_FIELDS.defineWorkflow, '', 'FK_C006');
  if (!idValid(definition.id)) report('FK_C001', '/id', 'Workflow id must be kebab-case with at most 64 characters');
  if (!isSemVer(definition.version)) report('FK_C002', '/version', 'Version must follow SemVer 2.0');
  if (!nonempty(definition.name) || definition.name.length > 80 || lineBreak.test(definition.name) || definition.name.includes('*/')) {
    report('FK_C003', '/name', 'Invalid workflow name');
  }
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    report('FK_C004', '/nodes', 'Workflow nodes must be a nonempty array');
    return diagnostics;
  }
  if (definition.nodes.length > 500) report('FK_C005', '/nodes', 'Workflow exceeds 500 nodes');
  const ids = new Set();
  const names = new Set();
  // Membership only selects local successor rules; graph ownership is validated later.
  const members = new Set();
  definition.nodes.forEach((node, index) => {
    if (constructors.get(`/nodes/${index}`).kind === 'parallel' && Array.isArray(node.branches)) {
      node.branches.forEach(id => { if (typeof id === 'string') members.add(id); });
    }
  });
  definition.nodes.forEach((node, index) => {
    const pointer = `/nodes/${index}`;
    const { kind, type, optionKeys } = constructors.get(pointer);
    const at = key => pointerChild(pointer, key);
    const emit = (code, key, message) => report(code, at(key), message, node.id);
    const present = key => optionKeys.includes(key);
    const requiredString = key => {
      if (!nonempty(node[key])) emit('FK_C007', key, `${key} must be a nonempty string`);
    };
    const successor = key => {
      if (!nonempty(node[key])) emit('FK_C016', key, `Missing successor: ${key}`);
    };
    const stringArray = key => {
      if (!present(key)) return;
      if (!Array.isArray(node[key])) { emit('FK_C019', key, `${key} must be an array`); return; }
      const seen = new Set();
      node[key].forEach((item, position) => {
        if (!nonempty(item) || seen.has(item)) report('FK_C056', pointerChild(at(key), position),
          `${key} entries must be nonempty unique strings`, node.id);
        seen.add(item);
      });
    };
    if (!idValid(node.id)) emit('FK_C010', 'id', 'Node id must be kebab-case with at most 64 characters');
    if (ids.has(node.id)) emit('FK_C011', 'id', 'Duplicate node id');
    ids.add(node.id);
    if (!nonempty(node.name) || node.name.length > 40 || /[\r\n\u2028\u2029'"`\\]/.test(node.name) || node.name.includes('*/')) {
      emit('FK_C012', 'name', 'Invalid node name');
    }
    if (typeof node.name === 'string' && names.has(node.name)) emit('FK_C013', 'name', 'Duplicate node name');
    names.add(node.name);
    if (node.type !== type) emit('FK_C014', 'type', `Constructor ${kind} requires type ${type}`);
    for (const key of optionKeys) if (key !== 'type' && !DSL_FIELDS[kind].includes(key)) {
      report('FK_C018', at(key), `Unknown ${kind} field: ${key}`, node.id, true);
    }
    if (['node', 'action'].includes(kind)) {
      if (members.has(node.id)) { if (present('next')) emit('FK_C021', 'next', 'Parallel members cannot have next'); }
      else successor('next');
    }
    if (kind === 'node') {
      if (!nonempty(node.agent) && !nonempty(node.skill)) emit('FK_C050', 'agent', 'An agent or skill is required');
      for (const key of ['agent', 'skill']) if (present(key) && typeof node[key] !== 'string') {
        emit('FK_C007', key, `${key} must be a string`);
      }
      if (!object(node.output) || node.output.type !== 'object' ||
        Object.hasOwn(node.output, 'properties') && !object(node.output.properties)) {
        emit('FK_C054', 'output', 'Output must be a literal object schema with type object');
      }
      stringArray('inputs');
      if (present('retries') && (!Number.isInteger(node.retries) || node.retries < 0 || node.retries > 10)) {
        emit('FK_C055', 'retries', 'Retries must be an integer from 0 to 10');
      }
      if (present('overview') && typeof node.overview !== 'boolean') emit('FK_C007', 'overview', 'Overview must be boolean');
      if (present('verify')) requiredString('verify');
    } else if (kind === 'action') {
      requiredString('action');
      stringArray('writes');
    } else if (kind === 'verification') {
      requiredString('verifier');
      for (const key of ['onSuccess', 'onFailure']) {
        if (members.has(node.id)) { if (present(key)) emit('FK_C025', key, 'Parallel verification cannot have successors'); }
        else successor(key);
      }
    } else if (kind === 'parallel') {
      if (!Array.isArray(node.branches) || node.branches.length < 2 || node.branches.length > 16 || !node.branches.every(nonempty)) {
        emit('FK_C020', 'branches', 'Parallel requires 2 to 16 branch ids');
      }
      if (!object(node.join)) emit('FK_C007', 'join', 'Join must be an object');
      else {
        unknown(node.join, ['strategy', 'next'], at('join'), 'FK_C018', node.id);
        if (!['all_succeeded', 'any'].includes(node.join.strategy)) {
          report('FK_C023', `${pointer}/join/strategy`, 'Invalid join strategy', node.id);
        }
        if (!nonempty(node.join.next)) report('FK_C016', `${pointer}/join/next`, 'Missing join successor', node.id);
      }
    } else if (kind === 'condition') {
      if (!Array.isArray(node.branches) || node.branches.length < 1 || node.branches.length > 20) {
        emit('FK_C030', 'branches', 'Condition requires 1 to 20 branches');
      }
      if (Array.isArray(node.branches)) {
        if (node.branches.at(-1)?.when !== 'true') emit('FK_C031', 'branches', 'Last branch must have when true');
        node.branches.forEach((branch, branchIndex) => {
          const base = `${pointer}/branches/${branchIndex}`;
          if (!object(branch)) { report('FK_C007', base, 'Branch must be an object', node.id); return; }
          unknown(branch, ['when', 'next'], base, 'FK_C018', node.id);
          if (!nonempty(branch.when)) report('FK_C007', `${base}/when`, 'When must be a nonempty string', node.id);
          else if (/[\r\n\u2028\u2029\\]/.test(branch.when)) report('FK_C034', `${base}/when`, 'When cannot contain line breaks or backslashes', node.id);
          if (!nonempty(branch.next)) report('FK_C016', `${base}/next`, 'Missing branch successor', node.id);
        });
      }
    } else if (kind === 'loop') {
      if (!Number.isInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > 100) {
        emit('FK_C040', 'maxIterations', 'Max iterations must be an integer from 1 to 100');
      }
      for (const key of ['body', 'onSuccess', 'onMaxExceeded']) successor(key);
    } else if (kind === 'human') {
      successor('onApprove'); successor('onReject');
    } else if (kind === 'terminal' && !['succeeded', 'failed'].includes(node.status)) {
      emit('FK_C070', 'status', 'Terminal status must be succeeded or failed');
    }
  });
  return diagnostics;
}
