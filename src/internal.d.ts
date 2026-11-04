import type { Diagnostic, FlowkitOptions } from '../types/index.js';
import type { Ctx, WorkflowResult } from '../types/index.js';
import type { DslNode } from '../types/dsl.js';

/** 原始字节摘要不受换行规范化、类型擦除或打印影响。 */
export interface SourceSnapshot {
  readonly absFilename: string;
  readonly rawBytes: Uint8Array;
  readonly sourceText: string;
  readonly sourceHash: string;
}
export interface SourceLocation { readonly line: number; readonly column: number }
export type ExecutableWorkflow = (ctx: Ctx) => Promise<WorkflowResult>;
export type LiteralValue = string | number | boolean | null | readonly LiteralValue[] | { readonly [key: string]: LiteralValue };
export interface LiteralWorkflow {
  /** Values are still unvalidated at this stage. */
  readonly definition: { readonly [key: string]: LiteralValue };
  readonly locations: ReadonlyMap<string, SourceLocation>;
  readonly keyLocations: ReadonlyMap<string, SourceLocation>;
  readonly propertyOrder: ReadonlyMap<string, readonly string[]>;
  readonly constructors: ReadonlyMap<string, {
    readonly kind: 'node' | 'action' | 'verification' | 'parallel' | 'condition' | 'loop' | 'human' | 'terminal';
    readonly type: string;
    readonly optionKeys: readonly string[];
  }>;
}
/** API边界解析后向内部传递；不在深层模块重复猜测cwd。 */
export interface CompileContext {
  readonly source: SourceSnapshot;
  readonly projectRoot: string;
  readonly skillsRoot: string;
  readonly skillCheck: boolean;
  readonly remoteSkillHosts: readonly string[];
  readonly trace: boolean;
  readonly options: Readonly<FlowkitOptions & { filename?: string }>;
}
export interface FrontendAnalysis {
  readonly snapshot: SourceSnapshot;
  readonly context: CompileContext;
  readonly literal: LiteralWorkflow | null;
  readonly graph: GraphAnalysis | null;
  readonly dataflow: DataflowAnalysis | null;
  readonly conditions: ReadonlyMap<string, WhenAst>;
  readonly diagnostics: readonly Diagnostic[];
}
export type WhenAst = { readonly kind: 'literal'; readonly value: string | number | boolean | null; readonly column: number }
  | { readonly kind: 'path'; readonly parts: readonly string[]; readonly column: number }
  | { readonly kind: 'not'; readonly operand: WhenAst; readonly column: number }
  | { readonly kind: 'and' | 'or'; readonly left: WhenAst; readonly right: WhenAst; readonly column: number }
  | { readonly kind: 'compare'; readonly operator: '===' | '!==' | '>' | '>=' | '<' | '<=';
      readonly left: WhenAst; readonly right: WhenAst; readonly column: number };
export interface GraphEdge<Id = string> {
  readonly from: Id;
  readonly to: Id;
  readonly role: string;
  readonly path: string;
  readonly sourceNode?: string;
  readonly targetNode?: string;
}
export interface ForwardGraph {
  readonly entry: string;
  readonly entryTarget?: string;
  readonly exit: symbol;
  readonly ids: readonly (string | symbol)[];
  readonly edges: readonly GraphEdge<string | symbol>[];
  readonly outgoing: ReadonlyMap<string | symbol, readonly GraphEdge<string | symbol>[]>;
  readonly topologicalOrder: readonly (string | symbol)[];
  readonly postDominators: ReadonlyMap<string | symbol, ReadonlySet<string | symbol>>;
  readonly immediatePostDominators: ReadonlyMap<string, string | symbol | null>;
  readonly joins: ReadonlyMap<string, string | symbol | null>;
}
export interface GraphRegion {
  readonly id: string;
  readonly kind: 'parallel' | 'loop' | 'human';
  readonly members: ReadonlySet<string>;
  readonly body?: string;
  readonly backEdges: ReadonlySet<string>;
  readonly forward: ForwardGraph;
  readonly entryTargets: ReadonlySet<string>;
  readonly entryForwards: ReadonlyMap<string, ForwardGraph>;
}
export interface GraphAnalysis {
  readonly byId: ReadonlyMap<string, DslNode>;
  readonly referenceEdges: readonly GraphEdge[];
  readonly executionEdges: readonly GraphEdge[];
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly regions: ReadonlyMap<string, GraphRegion>;
  readonly owners: ReadonlyMap<string, string>;
  readonly parallelOwners: ReadonlyMap<string, string>;
  readonly legalBackEdges: ReadonlySet<string>;
  readonly writeSets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dominators: ReadonlyMap<string, ReadonlySet<string>>;
  readonly forward: ForwardGraph;
}
export interface DataflowAnalysis {
  readonly inputs: ReadonlyMap<string, ReadonlySet<string>>;
  readonly outputs: ReadonlyMap<string, ReadonlySet<string>>;
  readonly declared: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}
export interface CompiledText { readonly code: string; readonly mermaid: string; readonly diagnostics: readonly Diagnostic[] }
export interface CompilationPaths {
  readonly source: string;
  readonly outDir: string;
  readonly codeFile: string;
  readonly mermaidFile: string;
}
export type EmitStep = { readonly kind: 'enter'; readonly target: string }
  | { readonly kind: 'node'; readonly id: string }
  | { readonly kind: 'decision'; readonly id: string; readonly branches: readonly EmitSequence[] }
  | { readonly kind: 'crossing'; readonly context: EmitContext };
export interface EmitSequence { readonly kind: 'sequence'; readonly steps: readonly EmitStep[] }
export interface EmitContext {
  readonly key: string;
  readonly mode: 'structured' | 'topological';
  readonly entry: string;
  readonly ids: readonly string[];
  readonly body?: EmitSequence;
  readonly order?: readonly string[];
  readonly resolve: (target: string | symbol | undefined) => string | symbol;
}
export interface EmitPlan {
  readonly root: EmitContext;
  readonly contexts: ReadonlyMap<string, EmitContext>;
  readonly layouts: readonly { readonly key: string; readonly mode: EmitContext['mode'] }[];
}
/** Text generation stays internal; filesystem output belongs to the later public compiler API. */
export interface InternalCompilation extends CompiledText {
  readonly analysis: FrontendAnalysis;
  readonly plan: EmitPlan | null;
  readonly paths: CompilationPaths;
}
