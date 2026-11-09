import { stripTypeScriptTypes } from 'node:module';
import { parse } from 'acorn';
import { NODE_TYPES } from '../shared/contracts.mjs';
import { diagnostic, nodeLocation, pointerChild } from './source.mjs';

class Unsupported extends Error {
  constructor(message, node) { super(message); this.location = nodeLocation(node); }
}

/** Node versions expose TS locations through different diagnostic frames. */
function typescriptFrame(error) {
  const legacy = error.message.match(/\[(\d+):(\d+)\]/) ??
    (/^\s*\d+ \|/m.test(error.message) ? ['', '1'] : null);
  const frame = error.stack?.match(/^:(\d+)\r?\n([\s\S]*?)(?:\r?\n\r?\nSyntaxError|$)/);
  if (!legacy && !frame) return { line: 1 };
  let line = Number((legacy ?? frame)[1]);
  let visualColumn;
  if (legacy) {
    for (const text of error.message.split('\n')) {
      const sourceLine = /^\s*(\d+) \|/.exec(text);
      if (sourceLine) line = Number(sourceLine[1]);
      const marker = /^\s*: ([ \t]*)\^/.exec(text);
      if (marker) { visualColumn = marker[1].length; break; }
      if (sourceLine && text.includes('| ,->')) break;
    }
  } else {
    const caret = frame[2].split('\n').find(text => /^[ \t]*\^/.test(text));
    if (caret) visualColumn = caret.indexOf('^');
  }
  return { line, visualColumn };
}

const characterWidths = new Map();
function displayWidth(character) {
  if (/^[\x20-\x7e]$/.test(character)) return 1;
  if (character === '\t') return 4;
  if (!characterWidths.has(character)) {
    // Ask the same renderer, keeping its Unicode version and width rules in sync.
    // The synthetic source is never evaluated; a comment cannot close on this code point.
    try { stripTypeScriptTypes(`/*${character}*/enum E{}`, { mode: 'strip' }); }
    catch (error) {
      const width = typescriptFrame(error).visualColumn;
      if (width !== undefined) characterWidths.set(character, Math.max(0, width - 4));
    }
  }
  return characterWidths.get(character) ?? character.length;
}

function typescriptLocation(error, sourceText) {
  const { line, visualColumn } = typescriptFrame(error);
  const original = sourceText.split(/\r\n|[\n\r\u2028\u2029]/)[line - 1] ?? '';
  if (visualColumn === undefined) return { line, column: original.search(/\S/) + 1 || 1 };
  let visual = 0;
  let column = 0;
  for (const character of original) {
    if (visual >= visualColumn && character !== '\uFEFF') break;
    visual += displayWidth(character);
    column += character.length;
  }
  return { line, column: column + 1 };
}

/** Interpret a small AST whitelist as data, without importing or executing source. */
export function extractWorkflow(snapshot) {
  const locations = new Map();
  const keyLocations = new Map();
  const constructors = new Map();
  const propertyOrder = new Map();
  const bindings = new Map();
  const fail = (message, node) => { throw new Unsupported(message, node); };
  const mark = (pointer, node) => locations.set(pointer, nodeLocation(node));
  const own = (target, key, value) => Object.defineProperty(target, key,
    { value, enumerable: true, writable: true, configurable: true });

  function object(node, pointer, allowNodes = false) {
    if (node?.type !== 'ObjectExpression') fail('Expected an object literal', node);
    mark(pointer, node);
    const result = {};
    const order = [];
    propertyOrder.set(pointer, order);
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init' || property.shorthand) {
        fail('Only ordinary literal properties are supported', property);
      }
      const key = property.key.type === 'Identifier' ? property.key.name
        : property.key.type === 'Literal' && ['string', 'number'].includes(typeof property.key.value)
          ? String(property.key.value) : fail('Unsupported property key', property.key);
      if (Object.hasOwn(result, key)) fail(`Duplicate property: ${key}`, property.key);
      const child = pointerChild(pointer, key);
      keyLocations.set(child, nodeLocation(property.key));
      order.push(key);
      own(result, key, value(property.value, child, allowNodes && key === 'nodes'));
    }
    return result;
  }

  function construct(node, pointer) {
    const kind = node.callee.type === 'Identifier' ? bindings.get(node.callee.name) : undefined;
    if (!Object.hasOwn(NODE_TYPES, kind) || node.optional || node.arguments.length !== 2) {
      fail('Expected a named DSL node constructor with two arguments', node);
    }
    const [id, options] = node.arguments;
    if (id.type !== 'Literal' || typeof id.value !== 'string') fail('Node id must be a string literal', id);
    const fields = object(options, pointer);
    constructors.set(pointer, { kind, type: NODE_TYPES[kind], optionKeys: propertyOrder.get(pointer) });
    const result = { id: id.value, type: NODE_TYPES[kind] };
    for (const key of Object.keys(fields)) {
      if (key !== 'id') own(result, key, fields[key]);
    }
    mark(pointer, node);
    mark(pointerChild(pointer, 'id'), id);
    return result;
  }

  function value(node, pointer, nodesArray = false) {
    mark(pointer, node);
    if (node.type === 'Literal' && !node.regex && !node.bigint &&
      (node.value === null || ['string', 'boolean'].includes(typeof node.value) ||
        typeof node.value === 'number' && Number.isFinite(node.value))) return node.value;
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.prefix &&
      node.argument.type === 'Literal' && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) {
      return -node.argument.value;
    }
    if (node.type === 'ObjectExpression') return object(node, pointer);
    if (node.type === 'ArrayExpression') return node.elements.map((element, index) => {
      if (!element) fail('Array holes are unsupported', node);
      const child = pointerChild(pointer, index);
      if (nodesArray && element.type === 'CallExpression') return construct(element, child);
      return value(element, child);
    });
    fail('Expected static literal data; expressions and arbitrary calls are unsupported', node);
  }

  try {
    const text = snapshot.absFilename.endsWith('.ts')
      ? stripTypeScriptTypes(snapshot.sourceText, { mode: 'strip' }) : snapshot.sourceText;
    const program = parse(text, { ecmaVersion: 2025, sourceType: 'module', locations: true });
    let exported;
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        if (statement.source.value !== '@devcodex-labs/flowkit/dsl' || statement.specifiers.length === 0 || statement.attributes?.length) {
          fail('Only named imports from @devcodex-labs/flowkit/dsl are supported', statement);
        }
        for (const specifier of statement.specifiers) {
          const name = specifier.imported?.name;
          if (specifier.type !== 'ImportSpecifier' || name !== 'defineWorkflow' && !Object.hasOwn(NODE_TYPES, name)) {
            fail('Unsupported DSL import', specifier);
          }
          bindings.set(specifier.local.name, name);
        }
      } else if (statement.type === 'ExportDefaultDeclaration' && !exported) {
        exported = statement.declaration;
      } else fail('Only DSL imports and one default workflow export are supported', statement);
    }
    if (exported?.type !== 'CallExpression' || exported.callee.type !== 'Identifier' ||
      bindings.get(exported.callee.name) !== 'defineWorkflow' || exported.optional || exported.arguments.length !== 1) {
      fail('Expected export default defineWorkflow({...})', exported);
    }
    const definition = object(exported.arguments[0], '', true);
    // Reject literal node objects too: constructor identity is part of the contract.
    if (Array.isArray(definition.nodes)) definition.nodes.forEach((node, index) => {
      if (!constructors.has(`/nodes/${index}`)) throw new Unsupported('Each node must use a DSL constructor',
        { loc: { start: { line: locations.get(`/nodes/${index}`).line, column: locations.get(`/nodes/${index}`).column - 1 } } });
    });
    return { literal: { definition, locations, keyLocations, constructors, propertyOrder }, diagnostics: [] };
  } catch (error) {
    if (!(error instanceof Unsupported) && !(error instanceof SyntaxError) &&
      !['ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', 'ERR_INVALID_TYPESCRIPT_SYNTAX'].includes(error.code)) throw error;
    const location = error.location ?? (error.loc ? nodeLocation(error) :
      typescriptLocation(error, snapshot.sourceText));
    return { literal: null, diagnostics: [diagnostic(snapshot, 'FK_C007', error.message, location)] };
  }
}
