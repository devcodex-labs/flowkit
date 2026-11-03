import type { Diagnostic, FlowkitOptions } from '../types/index.js';
import type { WorkflowDefinition } from '../types/dsl.js';

/** 原始字节摘要不受换行规范化、类型擦除或打印影响。 */
export interface SourceSnapshot {
  readonly absFilename: string;
  readonly rawBytes: Uint8Array;
  readonly sourceText: string;
  readonly sourceHash: string;
}
export interface SourceLocation { readonly file: string; readonly line: number; readonly column: number }
export interface LiteralWorkflow {
  readonly definition: WorkflowDefinition;
  readonly locations: ReadonlyMap<string, SourceLocation>;
}
/** API边界解析后向内部传递；不在深层模块重复猜测cwd。 */
export interface CompileContext {
  readonly source: SourceSnapshot;
  readonly projectRoot: string;
  readonly skillsRoot: string;
  readonly skillCheck: boolean;
  readonly remoteSkillHosts: readonly string[];
  readonly trace: boolean;
  readonly options: Readonly<FlowkitOptions>;
}
export interface CompiledText { readonly code: string; readonly mermaid: string; readonly diagnostics: readonly Diagnostic[] }
