/** Optional adapter: the Graph object is supplied by the host, not bundled. */
export interface GraphContext { facts?: Record<string, string | number | boolean>; notes?: string }
export interface GraphResolvedNode {
  capability: { id: string; [key: string]: unknown };
  applicability: { status: 'applicable' | 'inapplicable' | 'unknown'; [key: string]: unknown };
}
export interface GraphResolution {
  nodes: GraphResolvedNode[];
  unresolved: unknown[];
  meta: { completeness: 'complete' | 'partial'; [key: string]: unknown };
}
export interface GraphResolver {
  resolve(query: { ids: string[]; context?: GraphContext; relations?: 'requires'[] }): Promise<GraphResolution>;
}
export interface GraphActionBinding {
  capabilityId: string;
  execute(args: { action: string; name: string; ctx: unknown; resolution: GraphResolution; capability: GraphResolvedNode['capability'] }): void | Promise<void>;
}
export declare const flowkitProvider: {
  readonly schemaVersion: 1;
  readonly providerId: 'flowkit';
  readonly name: 'FlowKit';
  readonly version: string;
  readonly description: string;
  readonly capabilities: readonly Record<string, unknown>[];
};
export declare function createCapabilityGraphActionAdapter(options: {
  graph: GraphResolver;
  bindings: Record<string, GraphActionBinding>;
  getContext?: (ctx: unknown) => GraphContext;
}): { runAction(action: string, name: string, ctx: unknown): Promise<void> };
