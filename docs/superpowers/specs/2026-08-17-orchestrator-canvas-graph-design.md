# Orchestrator-Owned Canvas Graph — Design

**Date:** 2026-08-17
**Feature:** The orchestrator (and future LLM plans) can spawn, connect, and arrange canvas nodes. The runtime owns the canvas graph; the React Flow UI is a disposable projection.
**User decision:** Full orchestration — runtime owns the canvas graph.

## Problem

Today the canvas graph is ephemeral:
- `PlanTask` has no position/layout; edges derive only from plan `dependencies`.
- Positions live in React state corrupted by localStorage (`chef:canvas:*`).
- The orchestrator cannot move, rewire, delete, or arrange nodes after a plan.
- The AI Engineering OS spec (§5.4) defines `nodes`/`edges` tables; our `schema.sql` has none — a spec divergence from day one.

## Design

### 1. Durable graph tables (schema.sql)

Two new tables, both `workspaceId`-scoped with FKs:

```sql
CREATE TABLE IF NOT EXISTS canvas_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,   -- nullable: proxies don't need a task
  label TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'blueprint',           -- 'blueprint' | 'proxy'
  kind TEXT NOT NULL DEFAULT 'agent',                    -- palette color class
  harness_id TEXT,                                       -- optional harness assignment
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_canvas_nodes_workspace ON canvas_nodes(workspace_id);

CREATE TABLE IF NOT EXISTS canvas_edges (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(source, target)
);
CREATE INDEX idx_canvas_edges_workspace ON canvas_edges(workspace_id);
```

### 2. Repository API (database.ts)

```ts
interface CanvasNodeRecord { id, workspaceId, taskId, label, nodeType, kind, harnessId, positionX, positionY, updatedAt }
interface CanvasEdgeRecord { id, workspaceId, source, target, sourceHandle, targetHandle, updatedAt }

upsertCanvasNode(rec): void            // INSERT ... ON CONFLICT(id) DO UPDATE
upsertCanvasEdge(rec): void
deleteCanvasNode(id): void
deleteCanvasEdge(id): void
listCanvasNodes(workspaceId): CanvasNodeRecord[]
listCanvasEdges(workspaceId): CanvasEdgeRecord[]
```

All wrapped in `Repository` transactions like existing CRUD. No migrations (matches project convention).

### 3. Runtime surface (main.ts + saga)

New method on the runtime API:

```ts
/** Orchestrator canvas mutation — the ONLY way for plans/LLMs to reshape the graph. */
async patchCanvas(
  workspaceId: WorkspaceId,
  patch: CanvasPatch,
): Promise<{ ok: boolean; error?: string }>;

interface CanvasPatch {
  upsertNodes?: Array<{
    id: string; taskId?: string; label: string; nodeType?: "blueprint" | "proxy";
    kind?: NodeKind; harnessId?: string;
    position?: { x: number; y: number };
  }>;
  upsertEdges?: Array<{ source: string; target: string }>;
  deleteEdges?: Array<{ source: string; target: string }>;
  deleteNodes?: string[];
  arrange?: { mode: "columns" | "snake" | "radial" };
}
```

`patchCanvas`:
1. Validates: node refs exist, edges reference existing nodes, positions finite, no duplicate `(source,target)`.
2. Applies upserts/deletes transactionally.
3. On `arrange`, runs the layout algorithm **in the runtime** (deterministic):
   - topo sort by task/edge dependency depth → **columns** (left→right by depth)
   - **snake**: same columns but zigzag rows to stay compact
   - **radial**: `angle = (2π i)/n`, `r = 36*max(depth+1, 1)`
4. Emits `canvas.patched` SSE event with the full new snapshot so the UI syncs.
5. Completes → `chat.plan.applied` / equivalent report.

### 4. Layout engine (new `src/runtime/layout.ts`)

Pure, testable, no DOM:
```ts
export function computeLayout(
  nodes: CanvasNodeRecord[],
  edges: CanvasEdgeRecord[],
  mode: "columns" | "snake" | "radial",
): Map<nodeId, { x: number; y: number }>;
```
- `columns`: depth = longest path from roots; node at `(col*320 + 80, row*200 + 60)`; roots at depth 0.
- `snake`: `row` alternates direction per column (compact).
- `radial`: center-weighted circle by depth rings.
- Deterministic tie-break by `id` for equal depth (matches existing snapshot tie-break convention).
- Stable: nodes without edges stay in place unless they're the `arrange` target.

### 5. Orchestrator integration (orchestrator.ts)

- After `#executePlan` creates tasks (`orchestrator.task.created`), the orchestrator calls `patchCanvas({ upsertNodes: [...], upsertEdges: [...], arrange: "columns" })` — plans **always** lay out fresh (spawn + connect + arrange in one shot).
- Explicit failure → `chat.plan.applied { status: "failed", error }`; UI keeps last-good canvas.
- No removal of tasks → `deleteNodes` never used by the planner (reserved for LLM-driven edits later).

### 6. UI projection (web/App.tsx, BlueprintCanvas.tsx, api.ts, types.ts)

- **App**: canvas state now sourced from `GET /api/state`-included `canvasNodes`/`canvasEdges` (persisted) + live SSE `canvas.patched` → re-fetch. localStorage positions/view **removed** (runtime is source of truth — spec §5.4 "UI is a projection").
- **api.ts**: `patchCanvas(patch)` → `POST /api/canvas/patch`; `connect`/`disconnect`/`delete` become `patchCanvas` calls.
- **BlueprintCanvas**: controlled `useNodesState/useEdgesState` preserved for *live drag feel*, but every drag-end persists via `patchCanvas({ upsertNodes: [...new positions] })` (debounced). `onConnect` already calls `onConnect` → now patches edges. `onMoveEnd` viewport save **removed** (runtime owns graph; viewport can stay ephemeral or localStorage-only-pan/zoom).
- **NodePalette**: drag-drop → `patchCanvas({ upsertNodes: [...] })` then `POST /api/nodes` (task creation path reuses existing endpoint for task-backed nodes).

### 7. SSE & chat parity

- New event `canvas.patched { workspaceId, nodes: [...], edges: [...] }` (idempotent, replay-safe via `afterSeq` — same pattern as `live-events`).
- `patchCanvas` failures emit `canvas.patch.failed { error }` so the chat shows a red bubble instead of silently dropping the edit.

### 8. Error handling

| Failure | Behavior |
|---|---|
| Edge → missing node | reject patch, emit `canvas.patch.failed`, no partial write |
| Duplicate edge | UNIQUE constraint → upsert (no-op) not crash |
| Arrange on empty set | no-op success |
| Position non-finite | reject |
| DB write error | transaction rollback; `reject`; no partial state |
| SSE disconnected | client re-fetches `/api/state` on reconnect (existing pattern) |

### 9. Testing (tests/)

Real-SQLite + real harness pattern (matches existing suites):

1. `tests/canvas-patcher.ts` — node/edge CRUD via Repository + `patchCanvas`: upsert position, delete edge, delete cascade, transaction rollback on bad ref, uniqueness.
2. `tests/canvas-layout.ts` — pure `computeLayout`: DAG columns depth ordering, snake zigzag, radial ring count, determinism, unconnected-stays-put.
3. `tests/orchestrator-canvas.ts` — Orchestrator plan → nodes+edges persisted (`canvas_nodes`/`canvas_edges` rows appear), positions assigned, `canvas.patched` emitted; plan failure leaves last-good canvas.

### 10. What stays the same

- Backend API shape backward-compatible: `POST /api/nodes`, `POST /api/edges`, `DELETE /api/edges/:source->target` remain (now backed by durable tables instead of ephemeral React state).
- `TaskMachine`/lifecycle untouched. `dispatchPending` untouched.
- Web: `npm run dev` proxy → `:4321` untouched.

## Open Questions (resolved by defaults)

- **Proxy nodes** (non-task canvas nodes, e.g. "start"/"end" markers)? Spec's `nodes` table is generic; I'm adding `node_type: 'proxy'` + nullable `task_id` so user-dragged palette entries persist. Cheap now, avoids a migration later.
- **Viewport persistence**: stays localStorage-only (pan/zoom is user preference, not graph state). Documented divergence.

## Acceptance Criteria

1. Plan → `Post /api/chat` → nodes + edges appear in `canvas_nodes`/`canvas_edges` with valid positions.
2. Dragging a node then refreshing the page keeps it where you left it (server-persisted, NOT localStorage).
3. `POST /api/canvas/patch` with a bad edge ref rolls back atomically and emits `canvas.patch.failed`.
4. `canvas.patched` SSE drives UI sync without full page reload.
5. `tests/canvas-{patcher,layout,orchestrator-canvas}.ts` all pass; full `npm test` green.
6. No localStorage position write in `web/src/BlueprintCanvas.tsx` (runtime owns positions).

## Out of Scope (this pass)

- LLM-driven free-form canvas editing via chat ("move X next to Y") — the *plumbing* is in place (`patchCanvas`), the ScriptedDecisionProvider stays scripted.
- Approvals gating canvas mutations (P1).
- Hierarchical subgraph squads (P2).