import type { Diagnostic, FlowkitOptions } from '../types/index.js';

/** 原始字节摘要不受换行规范化、类型擦除或打印影响。 */
export interface SourceSnapshot {
  readonly absFilename: string;
  readonly rawBytes: Uint8Array;
  readonly sourceText: string;
  readonly sourceHash: string;
}
export interface SourceLocation { readonly line: number; readonly column: number }
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
  readonly diagnostics: readonly Diagnostic[];
}
export interface CompiledText { readonly code: string; readonly mermaid: string; readonly diagnostics: readonly Diagnostic[] }
