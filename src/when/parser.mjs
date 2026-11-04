const forbidden = new Set(['this', 'globalThis', 'constructor', '__proto__', 'prototype']);
const comparisons = new Set(['===', '!==', '>', '>=', '<', '<=']);

/** Syntax errors share the compile-time codes even when parsing for evaluation. */
export class WhenSyntaxError extends Error {
  constructor(code, message, column) {
    super(`${message} (expression column ${column})`);
    this.code = code;
    this.column = column;
  }
}

function tokenize(source) {
  const tokens = [];
  const forbiddenCharacter = source.search(/[\r\n\u2028\u2029\\]/);
  if (forbiddenCharacter !== -1) throw new WhenSyntaxError('FK_C034', 'Line breaks and backslashes are forbidden', forbiddenCharacter + 1);
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (/[ \t\f\v]/.test(character)) { offset++; continue; }
    const column = offset + 1;
    if (character === "'") {
      const end = source.indexOf("'", offset + 1);
      if (end === -1) throw new WhenSyntaxError('FK_C032', 'Unclosed string', column);
      tokens.push({ kind: 'literal', value: source.slice(offset + 1, end), column });
      offset = end + 1;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(offset));
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new WhenSyntaxError('FK_C032', 'Number must be finite', column);
      tokens.push({ kind: 'literal', value, column }); offset += number[0].length; continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(offset));
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier[0], column }); offset += identifier[0].length; continue;
    }
    const operator = ['===', '!==', '>=', '<=', '&&', '||', '>', '<', '!', '(', ')', '.'].find(op => source.startsWith(op, offset));
    if (!operator) throw new WhenSyntaxError('[`='.includes(character) || character === ']' ? 'FK_C033' : 'FK_C032',
      `Unsupported character ${character}`, column);
    tokens.push({ kind: 'operator', value: operator, column }); offset += operator.length;
  }
  tokens.push({ kind: 'eof', column: source.length + 1 });
  return tokens;
}

/** An explicit recursive-descent stack preserves the grammar without a call-stack limit. */
export function parseWhen(source) {
  if (typeof source !== 'string') throw new TypeError('when must be a string');
  const tokens = tokenize(source);
  let position = 0;
  let result;
  const peek = () => tokens[position];
  const is = value => peek().kind === 'operator' && peek().value === value;
  const fail = message => { throw new WhenSyntaxError('FK_C032', message, peek().column); };
  const stack = [{ rule: 'or', stage: 0 }];
  const descend = rule => stack.push({ rule, stage: 0 });
  const finish = value => { result = value; stack.pop(); };
  while (stack.length) {
    const frame = stack.at(-1);
    if (frame.rule === 'or' || frame.rule === 'and') {
      const operator = frame.rule === 'or' ? '||' : '&&';
      const child = frame.rule === 'or' ? 'and' : 'not';
      if (frame.stage === 0) { frame.stage = 1; descend(child); }
      else {
        frame.left = frame.stage === 2 ? { kind: frame.rule, left: frame.left, right: result, column: frame.column } : result;
        if (is(operator)) { frame.column = peek().column; position++; frame.stage = 2; descend(child); }
        else finish(frame.left);
      }
    } else if (frame.rule === 'not') {
      if (frame.stage === 0) {
        frame.columns = [];
        while (is('!')) { frame.columns.push(peek().column); position++; }
        frame.stage = 1; descend('cmp');
      } else {
        for (const column of frame.columns.reverse()) result = { kind: 'not', operand: result, column };
        finish(result);
      }
    } else if (frame.rule === 'cmp') {
      if (frame.stage === 0) { frame.stage = 1; descend('value'); }
      else if (frame.stage === 1 && peek().kind === 'operator' && comparisons.has(peek().value)) {
        frame.left = result; frame.operator = peek().value; frame.column = peek().column;
        position++; frame.stage = 2; descend('value');
      } else if (frame.stage === 2) finish({ kind: 'compare', operator: frame.operator, left: frame.left, right: result, column: frame.column });
      else finish(result);
    } else if (frame.rule === 'value') {
      const token = peek();
      if (frame.stage === 1) {
        if (is('(')) throw new WhenSyntaxError('FK_C033', 'Calls are forbidden', peek().column);
        if (!is(')')) fail('Expected closing parenthesis');
        position++; finish(result);
      } else if (is('(')) { position++; frame.stage = 1; descend('or'); }
      else if (token.kind === 'literal') { position++; finish({ kind: 'literal', value: token.value, column: token.column }); }
      else if (token.kind === 'identifier') {
        if (['true', 'false', 'null'].includes(token.value)) {
          position++; finish({ kind: 'literal', value: token.value === 'null' ? null : token.value === 'true', column: token.column });
        } else {
          const parts = [];
          for (;;) {
            const part = peek();
            if (part.kind !== 'identifier') fail('Expected path identifier');
            if (forbidden.has(part.value)) throw new WhenSyntaxError('FK_C033', `Forbidden identifier ${part.value}`, part.column);
            parts.push(part.value); position++;
            if (is('(')) throw new WhenSyntaxError('FK_C033', 'Calls are forbidden', peek().column);
            if (!is('.')) break;
            position++;
          }
          finish({ kind: 'path', parts, column: token.column });
        }
      } else fail('Expected a value');
    }
  }
  if (peek().kind !== 'eof') {
    if (is('(')) throw new WhenSyntaxError('FK_C033', 'Calls are forbidden', peek().column);
    fail('Unexpected trailing token');
  }
  return result;
}
