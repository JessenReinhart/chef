/**
 * Chef P0 — workflow graph projection (spec §12.3).
 *
 * A durable, UI-independent serializable graph (nodes + edges) derived from
 * plans and tasks. The runtime stays authoritative; this graph is a read-only
 * projection recomputed on demand from a workspace snapshot.
 */

import type { PlanTask, Task, WorkspaceSnapshot } from "./types.ts";

// ---------------------------------------------------------------------------
// Graph model (UI-independent, serializable)
// ---------------------------------------------------------------------------

export type GraphNodeKind = "agent" | "tool" | "control" | "workflow" | "human";

export type GraphEdgeKind = "data" | "control" | "conditional" | "error" | "approval";

/** A workflow node: a task execution unit or a human/control gate. */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  type: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  taskId?: string;
  status?: string;
}

/** A directed dependency, control-flow, or approval relationship. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

/** Serializable workflow graph projection (spec §12.3). */
export interface WorkflowGraph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const NODE_TYPE_TASK = "task";
const NODE_TYPE_APPROVAL = "approval";
const COLUMN_GAP = 260;
const ROW_GAP = 120;

/**
 * Compute the dependency depth of every node id via BFS layering (Kahn).
 * Nodes with no in-snapshot dependencies sit at depth 0; every node is placed
 * one layer deeper than its deepest dependency. Cycle members that never
 * drain are pinned one layer past the deepest resolved layer.
 */
function computeDepths(ids: readonly string[], dependenciesById: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const idSet = new Set(ids);
  const depths = new Map<string, number>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    const unique = [...new Set(dependenciesById.get(id) ?? [])].filter((dep) => idSet.has(dep));
    inDegree.set(id, unique.length);
    for (const dep of unique) {
      const list = dependents.get(dep) ?? [];
      list.push(id);
      dependents.set(dep, list);
    }
  }
  const queue: string[] = [];
  for (const id of ids) {
    if ((inDegree.get(id) ?? 0) === 0) {
      depths.set(id, 0);
      queue.push(id);
    }
  }
  let maxDepth = 0;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const depth = depths.get(id) ?? 0;
    if (depth > maxDepth) maxDepth = depth;
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, remaining);
      if (remaining === 0) {
        depths.set(dependent, depth + 1);
        queue.push(dependent);
      }
    }
  }
  const cycleDepth = maxDepth + 1;
  for (const id of ids) {
    if (!depths.has(id)) depths.set(id, cycleDepth);
  }
  return depths;
}

/**
 * Build the workflow graph projection for a workspace snapshot (spec §12.3).
 *
 * - Task nodes are the union of plan task ids and task records; the runtime
 *   Task record is authoritative, with the PlanTask filling gaps.
 * - A gated task (approvalId) becomes a `human` node and gains an approval
 *   node (`approval-<taskId>`, kind `human`, type `approval`) with an
 *   `approval` edge into it.
 * - Control edges follow task dependencies (kind `control`).
 * - Positions use a deterministic grid: column = dependency depth, row =
 *   index within that depth, spacing {x: depth*260, y: row*120}.
 */
export function buildPlanGraph(snapshot: WorkspaceSnapshot): WorkflowGraph {
  const taskById = new Map<string, Task>();
  for (const task of snapshot.tasks) taskById.set(task.id, task);
  const planTaskById = new Map<string, PlanTask>();
  for (const plan of snapshot.plans) {
    for (const planTask of plan.tasks) planTaskById.set(planTask.id, planTask);
  }

  // Stable, deterministic node order: plan task ids first (plan order), then
  // task records not claimed by any plan (snapshot order).
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const plan of snapshot.plans) {
    for (const taskId of plan.taskIds) {
      if (!seen.has(taskId)) {
        seen.add(taskId);
        ids.push(taskId);
      }
    }
  }
  for (const task of snapshot.tasks) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      ids.push(task.id);
    }
  }

  const dependenciesById = new Map<string, string[]>();
  for (const id of ids) {
    const task = taskById.get(id);
    const planTask = planTaskById.get(id);
    dependenciesById.set(id, task?.dependencies ?? planTask?.dependencies ?? []);
  }

  const depths = computeDepths(ids, dependenciesById);
  const positions = new Map<string, { x: number; y: number }>();
  const rowByDepth = new Map<number, number>();
  for (const id of ids) {
    const depth = depths.get(id) ?? 0;
    const row = rowByDepth.get(depth) ?? 0;
    rowByDepth.set(depth, row + 1);
    positions.set(id, { x: depth * COLUMN_GAP, y: row * ROW_GAP });
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const idSet = new Set(ids);

  for (const id of ids) {
    const task = taskById.get(id);
    const planTask = planTaskById.get(id);
    const dependencies = dependenciesById.get(id) ?? [];
    const approvalId = task?.approvalId ?? planTask?.approvalId;
    const position = positions.get(id) ?? { x: 0, y: 0 };

    const taskNode: GraphNode = {
      id,
      kind: approvalId ? "human" : "agent",
      type: NODE_TYPE_TASK,
      position,
      config: {
        title: task?.title ?? planTask?.title ?? id,
        priority: task?.priority ?? planTask?.priority ?? 0,
      },
      taskId: id,
      ...(task ? { status: task.status } : {}),
    };

    if (approvalId) {
      const approvalNodeId = `approval-${id}`;
      // Emitted before the gated task node: the task node itself is kind
      // "human" when gated, and consumers expect the first human node to be
      // the approval gate.
      nodes.push({
        id: approvalNodeId,
        kind: "human",
        type: NODE_TYPE_APPROVAL,
        position: { x: position.x + COLUMN_GAP, y: position.y },
        config: { approvalId, taskId: id },
        taskId: id,
      });
      edges.push({
        id: `approval:${approvalId}:${id}`,
        source: approvalNodeId,
        target: id,
        kind: "approval",
      });
    }
    nodes.push(taskNode);

    for (const dep of new Set(dependencies)) {
      if (!idSet.has(dep)) continue;
      edges.push({ id: `control:${dep}:${id}`, source: dep, target: id, kind: "control" });
    }
  }

  return { version: 1, nodes, edges };
}
