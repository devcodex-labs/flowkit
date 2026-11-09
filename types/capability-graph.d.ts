/** Optional SDK bridge; the host supplies a Graph instance. */
export interface GraphContext { facts?: Record<string, string | number | boolean>; notes?: string }
export interface GraphResolvedNode {
  capability: { id: string };
  applicability: { status: 'applicable' | 'inapplicable' | 'unknown' };
}
export interface GraphResolution {
  nodes: GraphResolvedNode[];
  unresolved: unknown[];
  meta: { completeness: 'complete' | 'partial' };
}
export interface GraphResolver {
  resolve(query: { ids: string[]; context?: GraphContext; relations?: 'requires'[] }): Promise<GraphResolution>;
}
export interface GraphActionBinding {
  capabilityId: string;
  execute(args: { action: string; name: string; ctx: unknown; resolution: GraphResolution; capability: GraphResolvedNode['capability'] }): void | Promise<void>;
}
export interface FlowkitCapabilityDeclaration {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  usage?: { instructions?: string };
  relations?: { requires?: string[] };
}
export declare const flowkitProvider: {
  schemaVersion: 1;
  providerId: 'flowkit';
  name: 'FlowKit';
  version: string;
  description: string;
  capabilities: FlowkitCapabilityDeclaration[];
};
export declare function createCapabilityGraphActionAdapter(options: {
  graph: GraphResolver;
  bindings: Record<string, GraphActionBinding>;
  getContext?: (ctx: unknown) => GraphContext;
}): { runAction(action: string, name: string, ctx: unknown): Promise<void> };
