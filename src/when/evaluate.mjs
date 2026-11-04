import { parseWhen } from './parser.mjs';

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw Object.assign(new Error('When operand and final result must be boolean'), { code: 'FK_R002' });
  return value;
}

/** Evaluate only parser-produced data, with own-property reads and strict short circuiting. */
export function evaluateWhenAst(ast, state) {
  const stack = [{ node: ast, stage: 0 }];
  let result;
  const finish = value => { result = value; stack.pop(); };
  while (stack.length) {
    const frame = stack.at(-1);
    const node = frame.node;
    if (node.kind === 'literal') finish(node.value);
    else if (node.kind === 'path') {
      let value = state;
      for (const key of node.parts) value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
      finish(value);
    } else if (node.kind === 'not') {
      if (frame.stage === 0) { frame.stage = 1; stack.push({ node: node.operand, stage: 0 }); }
      else finish(!requireBoolean(result));
    } else if (['and', 'or', 'compare'].includes(node.kind)) {
      if (frame.stage === 0) { frame.stage = 1; stack.push({ node: node.left, stage: 0 }); }
      else if (frame.stage === 1) {
        frame.left = node.kind === 'compare' ? result : requireBoolean(result);
        if (node.kind === 'and' && !frame.left || node.kind === 'or' && frame.left) finish(frame.left);
        else { frame.stage = 2; stack.push({ node: node.right, stage: 0 }); }
      } else if (node.kind !== 'compare') finish(requireBoolean(result));
      else {
        const left = frame.left;
        const right = result;
        if (node.operator === '===') finish(left === right);
        else if (node.operator === '!==') finish(left !== right);
        else {
          if (!(typeof left === 'number' && typeof right === 'number' || typeof left === 'string' && typeof right === 'string')) {
            throw Object.assign(new Error('When ordering requires two numbers or two strings'), { code: 'FK_R002' });
          }
          if (node.operator === '>') finish(left > right);
          else if (node.operator === '>=') finish(left >= right);
          else if (node.operator === '<') finish(left < right);
          else if (node.operator === '<=') finish(left <= right);
          else throw new TypeError('Unknown when comparison');
        }
      }
    } else throw new TypeError('Unknown when AST node');
  }
  return requireBoolean(result);
}

/** Private implementation of the confirmed evalWhen(ctx, when) contract. */
export function evalWhen(ctx, when) {
  return evaluateWhenAst(parseWhen(when), ctx.state);
}
