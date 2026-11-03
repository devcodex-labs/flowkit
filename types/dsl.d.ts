/** JSON Schema 2020-12 的扩展关键词保留为 JSON 数据；flowkit 不内置校验器。 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };
export interface JsonSchemaObject { readonly [keyword: string]: JsonValue | undefined }
export type ObjectSchema = JsonSchemaObject & { readonly type: 'object' };
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Retries = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type MaxIterations =
  1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 |
  21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 | 40 |
  41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49 | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 |
  61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77 | 78 | 79 | 80 |
  81 | 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97 | 98 | 99 | 100;

interface Named { readonly name: string }
interface AgentFields extends Named {
  readonly output: ObjectSchema;
  readonly inputs?: readonly string[];
  readonly retries?: Retries;
  readonly verify?: string;
  readonly overview?: boolean;
  readonly integrity?: string;
  readonly next?: string;
}
export type AgentOptions = AgentFields & (
  { readonly agent: string; readonly skill?: string } | { readonly agent?: string; readonly skill: string }
);
export interface ActionOptions extends Named { readonly action: string; readonly writes?: readonly string[]; readonly next?: string }
export interface VerificationOptions extends Named { readonly verifier: string; readonly onSuccess?: string; readonly onFailure?: string }
export interface ParallelOptions extends Named {
  readonly branches: readonly [string, string, ...string[]];
  readonly join: { readonly strategy: 'all_succeeded' | 'any'; readonly next: string };
}
export interface ConditionOptions extends Named { readonly branches: readonly [{ readonly when: string; readonly next: string }, ...{ readonly when: string; readonly next: string }[]] }
export interface LoopOptions extends Named { readonly maxIterations: MaxIterations; readonly body: string; readonly onSuccess: string; readonly onMaxExceeded: string }
export interface HumanOptions extends Named { readonly onApprove: string; readonly onReject: string }
export interface TerminalOptions extends Named { readonly status: 'succeeded' | 'failed' }

export type AgentNode = AgentOptions & { readonly id: string; readonly type: 'agent' };
export type ActionNode = ActionOptions & { readonly id: string; readonly type: 'action' };
export type VerificationNode = VerificationOptions & { readonly id: string; readonly type: 'verification' };
export type ParallelNode = ParallelOptions & { readonly id: string; readonly type: 'parallel' };
export type ConditionNode = ConditionOptions & { readonly id: string; readonly type: 'condition' };
export type LoopNode = LoopOptions & { readonly id: string; readonly type: 'loop' };
export type HumanNode = HumanOptions & { readonly id: string; readonly type: 'human' };
export type TerminalNode = TerminalOptions & { readonly id: string; readonly type: 'terminal' };
export type DslNode = AgentNode | ActionNode | VerificationNode | ParallelNode | ConditionNode | LoopNode | HumanNode | TerminalNode;
export interface WorkflowDefinition { readonly id: string; readonly version: string; readonly name: string; readonly nodes: readonly DslNode[] }

type NoExtra<T, Shape> = Record<Exclude<keyof T, keyof Shape>, never>;
type BranchExtras<B> = B extends object ? Exclude<keyof B, 'when' | 'next'> : never;
type OptionErrors<O, Shape> = Exclude<keyof O, keyof Shape>
  | (O extends ParallelOptions ? Exclude<keyof O['join'], keyof ParallelOptions['join']> : never)
  | (O extends ConditionOptions ? BranchExtras<O['branches'][number]> : never);
type Defined<I extends string, T extends string, O> = DeepReadonly<O & { id: I; type: T }>;
export declare function node<const I extends string, const O extends AgentOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, AgentOptions> extends never ? [] : [error: never]): Defined<I, 'agent', O>;
export declare function action<const I extends string, const O extends ActionOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, ActionOptions> extends never ? [] : [error: never]): Defined<I, 'action', O>;
export declare function verification<const I extends string, const O extends VerificationOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, VerificationOptions> extends never ? [] : [error: never]): Defined<I, 'verification', O>;
export declare function parallel<const I extends string, const O extends ParallelOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, ParallelOptions> extends never ? [] : [error: never]): Defined<I, 'parallel', O>;
export declare function condition<const I extends string, const O extends ConditionOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, ConditionOptions> extends never ? [] : [error: never]): Defined<I, 'condition', O>;
export declare function loop<const I extends string, const O extends LoopOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, LoopOptions> extends never ? [] : [error: never]): Defined<I, 'loop', O>;
export declare function human<const I extends string, const O extends HumanOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, HumanOptions> extends never ? [] : [error: never]): Defined<I, 'human', O>;
export declare function terminal<const I extends string, const O extends TerminalOptions>(id: I, options: O, ...unknownFields: OptionErrors<O, TerminalOptions> extends never ? [] : [error: never]): Defined<I, 'terminal', O>;

type ValueAt<T, K extends PropertyKey> = T extends Record<K, infer V> ? Extract<V, string> : never;
/** 只检查真正的 id 字段，不把 agent、verifier、when 或 schema 字符串误当引用。 */
type References<T> = T extends { type: 'parallel'; branches: readonly string[]; join: { next: string } }
  ? T['branches'][number] | T['join']['next']
  : T extends { type: 'condition'; branches: readonly { next: string }[] } ? T['branches'][number]['next']
  : T extends { type: 'loop' } ? ValueAt<T, 'body'> | ValueAt<T, 'onSuccess'> | ValueAt<T, 'onMaxExceeded'>
  : T extends { type: 'human' } ? ValueAt<T, 'onApprove'> | ValueAt<T, 'onReject'>
  : T extends { type: 'verification' } ? ValueAt<T, 'onSuccess'> | ValueAt<T, 'onFailure'>
  : ValueAt<T, 'next'>;
type Members<N extends readonly DslNode[]> = Extract<N[number], { type: 'parallel' }>['branches'][number];
type ContextError<T extends DslNode, N extends readonly DslNode[]> =
  T['id'] extends Members<N> ? (
    T extends AgentNode | ActionNode ? ('next' extends keyof T ? T['id'] : never)
    : T extends VerificationNode ? ('onSuccess' extends keyof T ? T['id'] : 'onFailure' extends keyof T ? T['id'] : never)
    : T['id']
  ) : T extends AgentNode | ActionNode ? (T extends { next: string } ? never : T['id'])
    : T extends VerificationNode ? (T extends { onSuccess: string; onFailure: string } ? never : T['id'])
    : T extends LoopNode ? (string extends T['body'] ? never : Extract<N[number], { id: T['body'] }> extends VerificationNode ? never : T['id'])
    : never;
type ContextErrors<N extends readonly DslNode[]> = { [K in keyof N]: N[K] extends DslNode ? ContextError<N[K], N> : never }[number];
type CheckReferences<N extends readonly DslNode[]> = Exclude<References<N[number]>, N[number]['id']> extends never ? unknown
  : { readonly __unknownNodeReferences: Exclude<References<N[number]>, N[number]['id']> };
// 动态 string id 无法证明成员身份，交给静态编译器；字面量工作流保留完整上下文检查。
type CheckContext<N extends readonly DslNode[]> = string extends N[number]['id'] ? unknown
  : [ContextErrors<N>] extends [never] ? unknown : { readonly __invalidNodeContext: ContextErrors<N> };
type CheckNonempty<N extends readonly DslNode[]> = N extends readonly [] ? { readonly __emptyWorkflow: never } : unknown;
type WorkflowErrors<W extends WorkflowDefinition> = NoExtra<W, WorkflowDefinition> & CheckReferences<W['nodes']> & CheckContext<W['nodes']> & CheckNonempty<W['nodes']>;
/** 检查放在条件rest，避免TS5.0自引用参数交叉类型使const推断退宽。合法调用仍只有一个参数。 */
export declare function defineWorkflow<const W extends WorkflowDefinition>(
  definition: W, ...validation: keyof WorkflowErrors<W> extends never ? [] : [error: never]
): DeepReadonly<W>;
