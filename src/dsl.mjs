import { NODE_TYPES } from './shared/contracts.mjs';

/**
 * 复制字面量后冻结，避免冻结调用者对象；特殊键始终定义为自身数据属性。
 * 静态编译器将独立提取源 AST，不执行这些定义函数。
 * @param {unknown} value
 * @param {WeakMap<object, object>} copies
 * @param {WeakSet<object>} active
 * @returns {unknown}
 */
function cloneFrozen(value, copies = new WeakMap(), active = new WeakSet()) {
  if (value === null || typeof value !== 'object') {
    if (['function', 'symbol', 'bigint'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError('DSL 定义只能包含有限数字、字符串、布尔、null、undefined、数组和数据对象');
    }
    return value;
  }
  if (active.has(value)) throw new TypeError('DSL 定义不能循环引用');
  if (copies.has(value)) return copies.get(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('DSL 定义必须使用普通数据对象');
  }
  const result = array ? [] : {};
  copies.set(value, result);
  active.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError('DSL 定义不支持 Symbol 键');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('DSL 定义不支持 getter/setter');
    Object.defineProperty(result, key, {
      value: cloneFrozen(descriptor.value, copies, active),
      enumerable: descriptor.enumerable, writable: true, configurable: true,
    });
  }
  if (array) result.length = value.length;
  active.delete(value);
  return Object.freeze(result);
}

/** @param {unknown} value @param {string} label */
function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是数据对象`);
  }
}

/**
 * 定义函数只负责数据与冻结；字段、图和 FK 诊断归后续静态编译器。
 * @param {string} type @param {string} id @param {object} options
 * @returns {Readonly<object>}
 */
function defineNode(type, id, options) {
  if (typeof id !== 'string') throw new TypeError('节点 id 必须是字符串');
  requireObject(options, '节点选项');
  if (Object.hasOwn(options, 'id') || Object.hasOwn(options, 'type')) {
    throw new TypeError('id 与 type 由构造器定义，不能写入选项');
  }
  // 先复制再添加标识，不读取调用者 getter，也不触发 __proto__ setter。
  const copied = cloneFrozen(options);
  const result = {};
  for (const key of Reflect.ownKeys(copied)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(copied, key));
  }
  Object.defineProperties(result, {
    id: { value: id, enumerable: true }, type: { value: type, enumerable: true },
  });
  return Object.freeze(result);
}

/** @param {object} definition @returns {Readonly<object>} */
export function defineWorkflow(definition) {
  requireObject(definition, '工作流');
  return cloneFrozen(definition);
}

/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function node(id, options) { return defineNode(NODE_TYPES.node, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function parallel(id, options) { return defineNode(NODE_TYPES.parallel, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function condition(id, options) { return defineNode(NODE_TYPES.condition, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function loop(id, options) { return defineNode(NODE_TYPES.loop, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function human(id, options) { return defineNode(NODE_TYPES.human, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function verification(id, options) { return defineNode(NODE_TYPES.verification, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function action(id, options) { return defineNode(NODE_TYPES.action, id, options); }
/** @param {string} id @param {object} options @returns {Readonly<object>} */
export function terminal(id, options) { return defineNode(NODE_TYPES.terminal, id, options); }
