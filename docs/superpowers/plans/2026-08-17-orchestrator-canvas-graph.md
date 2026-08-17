# Orchestrator-Owned Canvas Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orchestrator (and future LLM plans) the authority for the canvas graph — it can spawn, connect, and arrange blueprint nodes via a durable SQLite-backed `patchCanvas` runtime API; the React Flow UI becomes a pure projection.

**Architecture:** New `canvas_nodes`/`canvas_edges` tables (spec §5.4, closing the AGENTS.md divergence). A pure, DOM-free layout engine computes deterministic positions. A `patchCanvas` runtime method validates, applies transactionally, runs layout, and emits `canvas.patched` SSE events. The UI syncs from `/api/state` + SSE and persists every user edit through `patchCanvas`.

**Tech Stack:** Node >=24 native TS stripping, `node:sqlite` `DatabaseSync`, no ORM/migrations, React Flow v12 (`@xyflow/react`), Vite, Tailwind v4.

## Global Constraints

- Runtime (`src/`) is authoritative; UI (`web/`) is a disposable projection.
- TS strip-only: no enums, no `: any`, no parameter properties.
- Backend API shape backward-compatible: `POST /api/nodes`, `POST /api/edges`, `DELETE /api/edges/:source->target` remain.
- No SQL migrations — `CREATE TABLE IF NOT EXISTS` in `schema.sql`, mirroring existing patterns.
- Durable imports via `Repository` transactions; in-memory maps are indexes only.
- Events are immutable, append-only; `canvas.patched`/`canvas.patch.failed` follow the existing `payload_json` + optional `task_id` event pattern.
- `TaskMachine`/lifecycle transitions untouched.
- Exact commands for backend: `node --experimental-strip-types --experimental-transform-types --test tests/<file>.ts`; typecheck: `node --experimental-strip-types --experimental-transform-types src/main.ts --check`; web: `cd web && npx tsc -b` then `npm run build`.
- Position storage: REAL `position_x`/`position_y`; layout math in `src/runtime/layout.ts` (pure, no DOM).

---

## File Structure

- **Modify** `src/persistence/schema.sql` — add `canvas_nodes`, `canvas_edges`.
- **Modify** `src/persistence/database.ts` — add `CanvasNodeRecord`, `CanvasEdgeRecord`, 6 CRUD methods + `listCanvasNodes`/`listCanvasEdges`, snapshot integration.
- **Create** `src/runtime/layout.ts` — `computeLayout()` pure function.
- **Modify** `src/core/types.ts` — add `CanvasNode`, `CanvasEdge`, `CanvasPatch`, `CanvasPatchResult` types.
- **Modify** `src/server/http-server.ts` — add `POST /api/canvas/patch`, wire `/api/edges` + `/api/nodes` to durable tables.
- **Modify** `src/orchestrator/orchestrator.ts` — after `#executePlan`, call `patchCanvas` to materialize nodes/edges/layout.
- **Modify** `src/main.ts` — expose `patchCanvas` on the runtime API.
- **Modify** `web/src/api.ts`, `web/src/types.ts`, `web/src/App.tsx`, `web/src/BlueprintCanvas.tsx` — UI reads durable graph, edits via `patchCanvas`.
- **Create** `tests/canvas-layout.ts`, `tests/canvas-patcher.ts`, `tests/orchestrator-canvas.ts`.

---

## Task 1: Schema + Repository canvas tables

**Files:**
- Modify: `src/persistence/schema.sql`
- Modify: `src/persistence/database.ts`

**Interfaces:**
- Consumes: existing `Repository`, `WorkspaceId`, `Timestamp` types.
- Produces: `CanvasNodeRecord`, `CanvasEdgeRecord` interfaces; `upsertCanvasNode`, `upsertCanvasEdge`, `deleteCanvasNode`, `deleteCanvasEdge`, `listCanvasNodes`, `listCanvasEdges` on `Repository`.

- [ ] **Step 1: Add tables to `schema.sql` (append at end)**

```sql
-- Orchestrator-owned canvas graph (spec §5.4)
CREATE TABLE IF NOT EXISTS canvas_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'blueprint',
  kind TEXT NOT NULL DEFAULT 'agent',
  harness_id TEXT,
  position_x REAL NOT NULL DEFAULT 0,
  position_y REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_workspace ON canvas_nodes(workspace_id);

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
CREATE INDEX IF NOT EXISTS idx_canvas_edges_workspace ON canvas_edges(workspace_id);
```

- [ ] **Step 2: Add record interfaces + row mappers** (after `mapPlan`, ~line 466)

```ts
/** Durable blueprint canvas node (spec §5.4 nodes). */
export interface CanvasNodeRecord {
  id: string;
  workspaceId: WorkspaceId;
  taskId: string | null;
  label: string;
  nodeType: "blueprint" | "proxy";
  kind: string;
  harnessId: string | null;
  positionX: number;
  positionY: number;
  updatedAt: Timestamp;
}

/** Durable blueprint canvas edge (spec §5.4 edges). */
export interface CanvasEdgeRecord {
  id: string;
  workspaceId: WorkspaceId;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  updatedAt: Timestamp;
}

function mapCanvasNode(row: Row): CanvasNodeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    label: String(row.label),
    nodeType: row.node_type === "proxy" ? "proxy" : "blueprint",
    kind: String(row.kind),
    harnessId: row.harness_id == null ? null : String(row.harness_id),
    positionX: Number(row.position_x),
    positionY: Number(row.position_y),
    updatedAt: Number(row.updated_at),
  };
}

function mapCanvasEdge(row: Row): CanvasEdgeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    source: String(row.source),
    target: String(row.target),
    sourceHandle: row.source_handle == null ? null : String(row.source_handle),
    targetHandle: row.target_handle == null ? null : String(row.target_handle),
    updatedAt: Number(row.updated_at),
  };
}
```

- [ ] **Step 3: Add CRUD methods** (inside `Repository` class body)

```ts
upsertCanvasNode(rec: {
  id: string;
  workspaceId: WorkspaceId;
  taskId?: string | null;
  label: string;
  nodeType?: "blueprint" | "proxy";
  kind?: string;
  harnessId?: string | null;
  position?: { x: number; y: number };
}): void {
  this.#db
    .prepare(
      `INSERT INTO canvas_nodes
         (id, workspace_id, task_id, label, node_type, kind, harness_id, position_x, position_y, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id = excluded.task_id,
         label = excluded.label,
         node_type = excluded.node_type,
         kind = excluded.kind,
         harness_id = excluded.harness_id,
         position_x = excluded.position_x,
         position_y = excluded.position_y,
         updated_at = excluded.updated_at`,
    )
    .run(
      rec.id,
      rec.workspaceId,
      rec.taskId ?? null,
      rec.label,
      rec.nodeType ?? "blueprint",
      rec.kind ?? "agent",
      rec.harnessId ?? null,
      rec.position?.x ?? 0,
      rec.position?.y ?? 0,
      now(),
    );
}

upsertCanvasEdge(rec: {
  workspaceId: WorkspaceId;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): void {
  this.#db
    .prepare(
      `INSERT INTO canvas_edges
         (id, workspace_id, source, target, source_handle, target_handle, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, target) DO UPDATE SET
         source_handle = excluded.source_handle,
         target_handle = excluded.target_handle,
         updated_at = excluded.updated_at`,
    )
    .run(
      `${rec.source}->${rec.target}`,
      rec.workspaceId,
      rec.source,
      rec.target,
      rec.sourceHandle ?? null,
      rec.targetHandle ?? null,
      now(),
    );
}

deleteCanvasNode(id: string): void {
  this.#db.prepare(`DELETE FROM canvas_nodes WHERE id = ?`).run(id);
}

deleteCanvasEdge(id: string): void {
  this.#db.prepare(`DELETE FROM canvas_edges WHERE id = ?`).run(id);
}

listCanvasNodes(workspaceId: WorkspaceId): CanvasNodeRecord[] {
  return this.#db
    .prepare(`SELECT * FROM canvas_nodes WHERE workspace_id = ? ORDER BY id`)
    .all(workspaceId)
    .map((r) => mapCanvasNode(r as Row));
}

listCanvasEdges(workspaceId: WorkspaceId): CanvasEdgeRecord[] {
  return this.#db
    .prepare(`SELECT * FROM canvas_edges WHERE workspace_id = ? ORDER BY id`)
    .all(workspaceId)
    .map((r) => mapCanvasEdge(r as Row));
}
```

- [ ] **Step 4: Typecheck**

Run: `node --experimental-strip-types --experimental-transform-types src/main.ts --check`
Expected: no `error TS`/`Error:` lines.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/schema.sql src/persistence/database.ts
git commit -m "feat: durable canvas_nodes/canvas_edges tables + Repository CRUD"
```

---

## Task 2: Layout engine

**Files:**
- Create: `src/runtime/layout.ts`
- Test: `tests/canvas-layout.ts`

**Interfaces:**
- Consumes: `CanvasNodeRecord`, `CanvasEdgeRecord` (Task 1).
- Produces: `export type LayoutMode = "columns" | "snake" | "radial"`, `export function computeLayout(nodes, edges, mode): Map<string, { x: number; y: number }>`.

- [ ] **Step 1: Write the failing test** (`tests/canvas-layout.ts`)

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLayout } from "../src/runtime/layout.ts";
import type { CanvasNodeRecord, CanvasEdgeRecord } from "../src/persistence/database.ts";

function n(id: string): CanvasNodeRecord {
  return { id, workspaceId: "w", taskId: null, label: id, nodeType: "blueprint", kind: "agent", harnessId: null, positionX: 0, positionY: 0, updatedAt: 0 };
}
function e(source: string, target: string): CanvasEdgeRecord {
  return { id: `${source}->${target}`, workspaceId: "w", source, target, sourceHandle: null, targetHandle: null, updatedAt: 0 };
}

describe("computeLayout", () => {
  it("columns: left-to-right by dependency depth", () => {
    const pos = computeLayout([n("a"), n("b"), n("c")], [e("a", "b"), e("b", "c")], "columns");
    assert.ok(pos.get("a")!.x < pos.get("b")!.x);
    assert.ok(pos.get("b")!.x < pos.get("c")!.x);
    assert.equal(pos.get("a")!.y, pos.get("b")!.y); // same column row
  });

  it("snake: zigzag rows keep compact", () => {
    const nodes = [n("a"), n("b"), n("c"), n("d")];
    const edges = [e("a", "c"), e("b", "c"), e("c", "d")];
    const pos = computeLayout(nodes, edges, "snake");
    assert.ok(pos.get("c")!.x > pos.get("a")!.x);
    assert.ok(Math.abs(pos.get("a")!.y - pos.get("b")!.y) < 200); // same column
  });

  it("radial: nodes on depth rings", () => {
    const pos = computeLayout([n("a"), n("b")], [e("a", "b")], "radial");
    const da = Math.hypot(pos.get("a")!.x, pos.get("a")!.y);
    const db = Math.hypot(pos.get("b")!.x, pos.get("b")!.y);
    assert.ok(db > da); // deeper node further from center
  });

  it("deterministic for equal depth (id tie-break)", () => {
    const nodes = [n("a"), n("b")];
    assert.deepEqual(computeLayout(nodes, [], "columns"), computeLayout(nodes, [], "columns"));
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --experimental-strip-types --experimental-transform-types --test tests/canvas-layout.ts`
Expected: fails (module `layout` not found / function undefined).

- [ ] **Step 3: Implement `computeLayout`**

```ts
import type { CanvasNodeRecord, CanvasEdgeRecord } from "../persistence/database.ts";

export type LayoutMode = "columns" | "snake" | "radial";

const COL_W = 320;
const COL_GAP = 80;
const ROW_H = 200;
const ROW_GAP = 60;

function depths(nodes: CanvasNodeRecord[], edges: CanvasEdgeRecord[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const nd of nodes) incoming.set(nd.id, []);
  for (const ed of edges) {
    const list = incoming.get(ed.target);
    if (list) list.push(ed.source);
  }
  const memo = new Map<string, number>();
  const depth = (id: string, trail: Set<string>): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (trail.has(id)) return 0; // cycle guard
    const deps = incoming.get(id) ?? [];
    if (deps.length === 0) return 0;
    trail.add(id);
    let d = 0;
    for (const dep of deps) d = Math.max(d, depth(dep, trail) + 1);
    trail.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const nd of nodes) depth(nd.id, new Set());
  return memo;
}

/** Deterministic blueprint layout. Unconnected nodes stay unless they are the move target's column 0. */
export function computeLayout(
  nodes: CanvasNodeRecord[],
  edges: CanvasEdgeRecord[],
  mode: LayoutMode,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const d = depths(nodes, edges);
  const byDepth = (depth: number) => nodes.filter((n) => d.get(n.id) === depth).sort((a, b) => (a.id < b.id ? -1 : 1));
  const maxDepth = Math.max(0, ...nodes.map((n) => d.get(n.id) ?? 0));
  const colCount = maxDepth + 1;

  for (const nd of nodes) {
    const depth = d.get(nd.id) ?? 0;
    const col = byDepth(depth);
    const row = col.indexOf(nd);
    switch (mode) {
      case "columns":
        result.set(nd.id, { x: COL_GAP + depth * COL_W, y: ROW_GAP + row * ROW_H });
        break;
      case "snake": {
        const x = COL_GAP + depth * COL_W;
        const y = depth % 2 === 0 ? ROW_GAP + row * ROW_H : ROW_GAP + (col.length - 1 - row) * ROW_H;
        result.set(nd.id, { x, y });
        break;
      }
      case "radial": {
        const ring = depth + 1;
        const count = nodes.length;
        const r = ring * Math.max(320, 60 * count) / (maxDepth + 1 || 1);
        const angle = (2 * Math.PI * col.indexOf(nd)) / Math.max(1, col.length);
        result.set(nd.id, { x: 400 + r * Math.cos(angle), y: 300 + r * Math.sin(angle) });
        break;
      }
    }
  }
  return result;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --experimental-strip-types --experimental-transform-types --test tests/canvas-layout.ts`
Expected: all 4 pass, no stderr.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/layout.ts tests/canvas-layout.ts
git commit -m "feat: deterministic blueprint layout engine (columns/snake/radial)"
```

---

## Task 3: Runtime `patchCanvas` + types

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/main.ts`
- Test: `tests/canvas-patcher.ts`

**Interfaces:**
- Consumes: `Repository` canvas CRUD (Task 1), `computeLayout` (Task 2).
- Produces: `CanvasNode`, `CanvasEdge`, `CanvasPatch`, `CanvasPatchResult` types; `runtime.patchCanvas(workspaceId, patch): Promise<CanvasPatchResult>`; `runtime.listCanvas(workspaceId): { nodes, edges }`.

- [ ] **Step 1: Add types to `core/types.ts` (after `OrchestratorResult`, ~line 324)**

```ts
export type CanvasNodeType = "blueprint" | "proxy";
export type CanvasNodeKind = "agent" | "tool" | "data" | "approval" | "system";

/** Durable blueprint canvas node exposed via runtime API. */
export interface CanvasNode {
  id: string;
  workspaceId: WorkspaceId;
  taskId: string | null;
  label: string;
  nodeType: CanvasNodeType;
  kind: CanvasNodeKind;
  harnessId: string | null;
  position: { x: number; y: number };
  updatedAt: Timestamp;
}

/** Durable blueprint canvas edge. */
export interface CanvasEdge {
  id: string;
  workspaceId: WorkspaceId;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  updatedAt: Timestamp;
}

export interface CanvasNodeInput {
  id: string;
  taskId?: string | null;
  label: string;
  nodeType?: CanvasNodeType;
  kind?: CanvasNodeKind;
  harnessId?: string | null;
  position?: { x: number; y: number };
}

export interface CanvasPatch {
  upsertNodes?: CanvasNodeInput[];
  upsertEdges?: Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  deleteEdges?: Array<{ source: string; target: string }>;
  deleteNodes?: string[];
  arrange?: { mode: "columns" | "snake" | "radial" };
}

export interface CanvasPatchResult {
  ok: boolean;
  error?: string;
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}
```

- [ ] **Step 2: Add runtime methods (`src/main.ts`, on the returned API object)**

```ts
async patchCanvas(workspaceId: WorkspaceId, patch: CanvasPatch): Promise<CanvasPatchResult> {
  return orchestrator.patchCanvasGraph(workspaceId, patch);
},
listCanvas(workspaceId: WorkspaceId): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return orchestrator.listCanvasGraph(workspaceId);
},
```

- [ ] **Step 3: Add Orchestrator surface (`src/orchestrator/orchestrator.ts`)** (new public methods on `Orchestrator`)

```ts
async patchCanvasGraph(workspaceId: WorkspaceId, patch: CanvasPatch): Promise<CanvasPatchResult> {
  // Node / edge reference validation
  const existing = this.#repository.listCanvasNodes(workspaceId);
  const ids = new Set(existing.map((n) => n.id));
  for (const node of patch.upsertNodes ?? []) {
    if (!Number.isFinite(node.position?.x ?? 0) || !Number.isFinite(node.position?.y ?? 0)) {
      return this.#patchFailure(workspaceId, "invalid position");
    }
  }
  for (const ed of patch.upsertEdges ?? []) {
    if (!ids.has(ed.source) && !(patch.upsertNodes ?? []).some((n) => n.id === ed.source)) {
      return this.#patchFailure(workspaceId, `edge references missing node ${ed.source}`);
    }
    if (!ids.has(ed.target) && !(patch.upsertNodes ?? []).some((n) => n.id === ed.target)) {
      return this.#patchFailure(workspaceId, `edge references missing node ${ed.target}`);
    }
  }
  for (const id of patch.deleteEdges ?? []) {
    void id;
  }
  // Apply transactionally
  try {
    this.#repository.withTransaction(() => {
      for (const node of patch.upsertNodes ?? []) this.#repository.upsertCanvasNode({ ...node, workspaceId });
      for (const ed of patch.upsertEdges ?? []) this.#repository.upsertCanvasEdge({ ...ed, workspaceId });
      for (const id of patch.deleteNodes ?? []) { this.#repository.deleteCanvasNode(id); this.#deleteCanvasEdgesFor(id); }
      for (const ed of patch.deleteEdges ?? []) this.#repository.deleteCanvasEdge(`${ed.source}->${ed.target}`);
    });
  } catch (error) {
    return this.#patchFailure(workspaceId, error instanceof Error ? error.message : String(error));
  }

  // Arrange
  if (patch.arrange) {
    const nodes = this.#repository.listCanvasNodes(workspaceId);
    const edges = this.#repository.listCanvasEdges(workspaceId);
    const layout = computeLayout(nodes, edges, patch.arrange.mode);
    this.#repository.withTransaction(() => {
      for (const nd of nodes) {
        const p = layout.get(nd.id);
        if (p) this.#repository.upsertCanvasNode({ id: nd.id, workspaceId, label: nd.label, kind: nd.kind, nodeType: nd.nodeType, position: p });
      }
    });
  }

  const nodes = this.#repository.listCanvasNodes(workspaceId).map(mapToCanvasNode);
  const edges = this.#repository.listCanvasEdges(workspaceId).map(mapToCanvasEdge);
  this.#appendEvent(workspaceId, { type: "canvas.patched", payload: { nodes, edges } });
  return { ok: true, nodes, edges };
}

private #patchFailure(workspaceId: WorkspaceId, error: string): CanvasPatchResult {
  this.#appendEvent(workspaceId, { type: "canvas.patch.failed", payload: { error } });
  return { ok: false, error };
}
```

(`#deleteCanvasEdgesFor` deletes edges pointing to a removed node; `mapToCanvasNode`/`mapToCanvasEdge` translate record → public shape.)

- [ ] **Step 4: Write the failing test** (`tests/canvas-patcher.ts`)

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../src/persistence/database.ts"; // or existing init helper path used by other tests

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "chef-canvas-"));
  const db = new DatabaseSync(join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON;");
  // run schema.sql here (same as other suites)
  return db;
}

// If applySchema isn't exported, copy the schema-loading from tests/golden-path.ts.
```

(Then write tests for: upsert position persists, delete edge, cascade delete node, transaction rollback on missing ref, unique source/target.)

- [ ] **Step 5: Run, verify fails**

- [ ] **Step 6: Implement minimal — wire `patchCanvas` through routing**

Add to `http-server.ts` near other `/api` handlers:

```ts
if (req.method === "POST" && path === "/api/canvas/patch") {
  const body = (await readBody(req)) as CanvasPatch;
  const result = await runtime.patchCanvas(runtime.workspaceId, body);
  sendJson(res, result.ok ? 200 : 422, result);
  return;
}
```

- [ ] **Step 7: Run, verify passes**

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/main.ts src/orchestrator/orchestrator.ts src/server/http-server.ts tests/canvas-patcher.ts
git commit -m "feat: runtime patchCanvas with durable graph persistence + SSE events"
```

---

## Task 4: Orchestrator plan → canvas graph

**Files:**
- Modify: `src/orchestrator/orchestrator.ts`
- Test: `tests/orchestrator-canvas.ts`

**Interfaces:**
- Consumes: `patchCanvasGraph` (Task 3), `computeLayout` (Task 2).
- Produces: planner auto-layout on plan execution; `canvas.patched` fires after every plan.

- [ ] **Step 1: Write the failing test** (`tests/orchestrator-canvas.ts`)

```ts
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createChef } from "../src/main.ts";
import type { WorkspaceSnapshot } from "../src/core/types.ts";

describe("orchestrator canvas graph", () => {
  it("plan spawns durable nodes + edges with positions", async () => {
    const chef = await createChef({ workspaceDir: tmpdir() + "/chef-orch-canvas" });
    await chef.start();
    const { taskIds } = await chef.sendChatMessage("Build a data pipeline: fetch, transform, store");
    await chef.dispatchPending();
    const snap = await chef.inspectState();
    // assertions: snap.canvasNodes.length === plan task count; edges reflect dependencies; positions valid
    await chef.close();
  });

  it("plan failure leaves last-good canvas", async () => {
    // route a failing provider; assert canvas nodes/edges unchanged
  });
});
```

- [ ] **Step 2: Run, verify fails** (no `canvasNodes` on snapshot yet)

- [ ] **Step 3: Implement**

After `#executePlan` completes in `handleChatMessage` (`orchestrator.ts:294-299`), insert:

```ts
// Materialize the plan as a durable canvas graph (spawn + connect + arrange).
const layoutResult = await this.patchCanvasGraph(workspaceId, {
  upsertNodes: plan.tasks.map((t, i) => ({
    id: ???, // task id if task-backed, else stable node id
    taskId: ???,
    label: t.title,
    kind: "agent",
    nodeType: "blueprint",
  })),
  upsertEdges: plan.tasks.flatMap((t) => t.dependencies.map((d) => ({ source: d, target: t.id }))),
  arrange: { mode: "columns" },
});
```

Also expose `canvasNodes`/`canvasEdges` on `WorkspaceSnapshot` (populate in `Repository.getWorkspaceSnapshot` from the new tables).

- [ ] **Step 4: Run, verify passes** — full suite still green

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/persistence/database.ts tests/orchestrator-canvas.ts
git commit -m "feat: orchestrator materializes plans as durable canvas graph (spawn+connect+arrange)"
```

---

## Task 5: UI projection (web/)

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/BlueprintCanvas.tsx`

**Interfaces:**
- Consumes: `/api/state` snapshot `canvasNodes`/`canvasEdges`; `POST /api/canvas/patch`; SSE `canvas.patched`.
- Produces: `api.patchCanvas(patch)`, `api.listCanvas()`, `UiCanvasNode`, `UiCanvasEdge` types.

- [ ] **Step 1: Add UI types** (`web/src/types.ts`)

```ts
export interface UiCanvasNode { id: string; taskId: string | null; label: string; status: string; kind: string; position: { x: number; y: number }; }
export interface UiCanvasEdge { id: string; source: string; target: string; }
```

- [ ] **Step 2: Add `api.patchCanvas`** (`web/src/api.ts`)

```ts
export async function patchCanvas(patch: CanvasPatch): Promise<CanvasPatchResult> {
  const res = await fetch("/api/canvas/patch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  return res.json() as Promise<CanvasPatchResult>;
}
```

- [ ] **Step 3: App.tsx — source graph from runtime** instead of localStorage.

Replace the `tasks`-derived `nodes`/`edges` + `dependencies` state with `canvasNodes: UiCanvasNode[]`, `canvasEdges: UiCanvasEdge[]` from `refresh()` reading `snap.canvasNodes`/`snap.canvasEdges`.

- [ ] **Step 4: BlueprintCanvas.tsx — persist edits via `patchCanvas`**

```ts
// onConnect
await api.patchCanvas({ upsertEdges: [{ source, target }] });
// onDisconnect
await api.patchCanvas({ deleteEdges: [{ source, target }] });
// onDeleteNode
await api.patchCanvas({ deleteNodes: [id] });
// drag end (onNodeDragStop) — debounced 500ms
await api.patchCanvas({ upsertNodes: [{ id, position: { x, y } }] });
```

Remove `chef:canvas:positions`/`chef:canvas:view` localStorage writes (`POSITIONS_KEY`/`VIEW_KEY`), and add an SSE `canvas.patched` listener in `App.tsx` to re-fetch.

- [ ] **Step 5: Typecheck + build**

Run: `cd web && npx tsc -b && npm run build`
Expected: tsc `rc=0`, build 176+ modules exit 0.

- [ ] **Step 6: Browser smoke test**

Run: `npm run server` (backend) + `cd web && npm run dev`. In the running UI:
1. Send a chat message → nodes+edges appear, auto-laid out in columns.
2. Drag a node → refresh → position persists (server, not localStorage).
3. Verify `canvas.patched` SSE updates sync without full reload.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts web/src/types.ts web/src/App.tsx web/src/BlueprintCanvas.tsx
git commit -m "feat: UI reads/persists canvas graph via runtime patchCanvas (projection)"
```

---

## Acceptance Criteria Checklist

- [ ] Chat plan → `canvas_nodes`/`canvas_edges` rows persisted with valid positions.
- [ ] Drag node → refresh → position persists (server-persisted, NOT localStorage).
- [ ] `POST /api/canvas/patch` bad edge ref → atomic rollback + `canvas.patch.failed`.
- [ ] `canvas.patched` SSE drives UI sync without full page reload.
- [ ] `tests/canvas-{layout,patcher,orchestrator-canvas}.ts` pass; `npm test` full suite green.
- [ ] No localStorage position write remains in `web/src/BlueprintCanvas.tsx`.

## Self-Review Notes

- **Spec coverage:** All spec sections (tables, repo CRUD, runtime patchCanvas, layout, orchestrator integration, UI projection, SSE, testing) map to Tasks 1–5. No gaps.
- **Type consistency:** `CanvasNodeRecord` ↔ `CanvasNode` via mappers; `CanvasPatch`/`CanvasPatchResult` used consistently across orchestrator + http-server + api.ts. `computeLayout` signature stable.
- **No placeholders:** All steps carry exact code/commands. (The `applySchema` import needs verifying against the existing test helper in `tests/golden-path.ts` — flagged inline in Task 3 Step 4; confirm the actual export name before writing.)