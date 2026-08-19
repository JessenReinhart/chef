import type { CanvasNode, ContextReference, WorkspaceId } from "./types.ts";

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
  contextRefs: ContextReference[];
  memberNodeIds: string[];
}

export interface ContextScopeInput {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextScopeBounds;
  contextRefs?: ContextReference[];
  /** Explicit authoritative membership. Geometry is never consulted when set. */
  memberNodeIds?: string[];
}

/** Return true when a node's anchor point falls inside a scope rectangle. */
export function nodeIsInsideScope(node: CanvasNode, scope: ContextScopeBounds): boolean {
  return (
    node.position.x >= scope.x &&
    node.position.x <= scope.x + scope.width &&
    node.position.y >= scope.y &&
    node.position.y <= scope.y + scope.height
  );
}

/** Derive membership from the authoritative canvas projection. */
export function resolveScopeMembers(scope: ContextScopeBounds, nodes: CanvasNode[]): string[] {
  return nodes
    .filter((node) => nodeIsInsideScope(node, scope))
    .map((node) => node.id)
    .sort();
}

/** Build a scope from a rectangle and the current canvas snapshot. */
export function materializeContextScope(input: ContextScopeInput, nodes: CanvasNode[]): ContextScope {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    bounds: { ...input.bounds },
    contextRefs: input.contextRefs?.map((ref) => ({ ...ref })) ?? [],
    memberNodeIds: input.memberNodeIds === undefined
      ? resolveScopeMembers(input.bounds, nodes)
      : [...new Set(input.memberNodeIds)].sort(),
  };
}
