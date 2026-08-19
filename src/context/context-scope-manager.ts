import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CanvasNode, WorkspaceId } from "../core/types.ts";
import { materializeContextScope, type ContextScope, type ContextScopeBounds } from "../core/context-scopes.ts";

export interface ContextScopeCreateInput {
  id?: string;
  workspaceId: WorkspaceId;
  name: string;
  bounds: ContextScopeBounds;
  contextRefs?: string[];
}

export interface ContextScopeUpdateInput {
  name?: string;
  bounds?: ContextScopeBounds;
  contextRefs?: string[];
}

type PersistedContextScope = Omit<ContextScope, "memberNodeIds">;
export interface ContextScopeStoreSnapshot { scopes: PersistedContextScope[]; }

export class ContextScopeManager {
  readonly #storagePath: string;
  readonly #scopes = new Map<string, ContextScope>();

  constructor(storagePath: string) {
    this.#storagePath = storagePath;
    this.#load();
  }

  list(workspaceId: WorkspaceId, nodes: CanvasNode[] = []): ContextScope[] {
    return [...this.#scopes.values()]
      .filter((scope) => scope.workspaceId === workspaceId)
      .map((scope) => materializeContextScope(scope, nodes))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(workspaceId: WorkspaceId, scopeId: string, nodes: CanvasNode[] = []): ContextScope | undefined {
    const scope = this.#scopes.get(scopeId);
    if (!scope || scope.workspaceId !== workspaceId) return undefined;
    return materializeContextScope(scope, nodes);
  }

  create(input: ContextScopeCreateInput, nodes: CanvasNode[] = []): ContextScope {
    const id = input.id ?? randomUUID();
    if (this.#scopes.has(id)) throw new Error(`context scope already exists: ${id}`);
    this.#validateBounds(input.bounds);
    const scope = materializeContextScope({
      id,
      workspaceId: input.workspaceId,
      name: input.name.trim() || "Shared Context",
      bounds: { ...input.bounds },
      contextRefs: [...(input.contextRefs ?? [])],
    }, nodes);
    this.#scopes.set(id, scope);
    this.#persist();
    return scope;
  }

  update(workspaceId: WorkspaceId, scopeId: string, input: ContextScopeUpdateInput, nodes: CanvasNode[] = []): ContextScope {
    const current = this.#scopes.get(scopeId);
    if (!current || current.workspaceId !== workspaceId) throw new Error(`context scope not found: ${scopeId}`);
    const bounds = input.bounds ? { ...input.bounds } : { ...current.bounds };
    this.#validateBounds(bounds);
    const scope = materializeContextScope({
      id: current.id,
      workspaceId: current.workspaceId,
      name: input.name === undefined ? current.name : input.name.trim() || "Shared Context",
      bounds,
      contextRefs: input.contextRefs === undefined ? [...current.contextRefs] : [...input.contextRefs],
    }, nodes);
    this.#scopes.set(scopeId, scope);
    this.#persist();
    return scope;
  }

  delete(workspaceId: WorkspaceId, scopeId: string): boolean {
    const scope = this.#scopes.get(scopeId);
    if (!scope || scope.workspaceId !== workspaceId) return false;
    this.#scopes.delete(scopeId);
    this.#persist();
    return true;
  }

  contextRefsForNode(workspaceId: WorkspaceId, nodeId: string, nodes: CanvasNode[]): string[] {
    const refs = new Set<string>();
    for (const scope of this.list(workspaceId, nodes)) {
      if (!scope.memberNodeIds.includes(nodeId)) continue;
      for (const ref of scope.contextRefs) refs.add(ref);
    }
    return [...refs].sort();
  }

  snapshot(): ContextScopeStoreSnapshot {
    return {
      scopes: [...this.#scopes.values()].map(({ memberNodeIds: _memberNodeIds, ...scope }) => ({
        ...scope,
        contextRefs: [...scope.contextRefs],
        bounds: { ...scope.bounds },
      })),
    };
  }

  #validateBounds(bounds: ContextScopeBounds): void {
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
      throw new Error("context scope bounds must be finite");
    }
    if (bounds.width < 0 || bounds.height < 0) {
      throw new Error("context scope width and height must be non-negative");
    }
  }

  #load(): void {
    try {
      const raw = readFileSync(this.#storagePath, "utf8");
      const parsed = JSON.parse(raw) as ContextScopeStoreSnapshot;
      for (const scope of parsed.scopes ?? []) {
        if (scope?.id && scope.workspaceId && scope.bounds) {
          this.#scopes.set(scope.id, { ...scope, memberNodeIds: [] });
        }
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }
  }

  #persist(): void {
    mkdirSync(dirname(this.#storagePath), { recursive: true });
    writeFileSync(this.#storagePath, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }
}
