import type { CanvasNode, WorkspaceId } from "./types.ts";

/**
 * A visual context scope is a shared-knowledge boundary, not an execution node.
 * Nodes inside the rectangle can resolve the same context references without
 * becoming direct communication peers.
 */
export interface ContextScopeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContextScope {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextScopeBounds;
  contextRefs: string[];
  memberNodeIds: string[];
}

export interface ContextScopeInput {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextScopeBounds;
  contextRefs?: string[];
}

/** Return true when a node's center point falls inside a scope rectangle. */
export function nodeIsInsideScope(node: CanvasNode, scope: ContextScopeBounds): boolean {
  // Canvas nodes currently expose their anchor position rather than dimensions.
  // Treating the anchor as the membership point keeps membership deterministic
  // until node dimensions become part of the durable canvas contract.
  return (
    node.position.x >= scope.x &&
    node.position.x <= scope.x + scope.width &&
    node.position.y >= scope.y &&
    node.position.y <= scope.y + scope.height
  );
}

/**
 * Derive membership from the durable canvas projection instead of persisting a
 * second source of truth in the UI. The returned ids are stable and sorted.
 */
export function resolveScopeMembers(scope: ContextScopeBounds, nodes: CanvasNode[]): string[] {
  return nodes
    .filter((node) => nodeIsInsideScope(node, scope))
    .map((node) => node.id)
    .sort();
}

/**
 * Build a scope from a rectangle and the current canvas snapshot.
 * Membership is intentionally derived, so moving a node in/out of a scope
 * immediately changes which agents receive its shared context.
 */
export function materializeContextScope(input: ContextScopeInput, nodes: CanvasNode[]): ContextScope {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    bounds: { ...input.bounds },
    contextRefs: [...(input.contextRefs ?? [])],
    memberNodeIds: resolveScopeMembers(input.bounds, nodes),
  };
}
