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
    if (deps.length === 0) {
      memo.set(id, 0);
      return 0;
    }
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

/** Deterministic blueprint layout. Unconnected nodes land at depth 0 (column 0). */
export function computeLayout(
  nodes: CanvasNodeRecord[],
  edges: CanvasEdgeRecord[],
  mode: LayoutMode,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const d = depths(nodes, edges);
  const byDepth = (depth: number) => nodes.filter((n) => d.get(n.id) === depth).sort((a, b) => (a.id < b.id ? -1 : 1));
  const maxDepth = Math.max(0, ...nodes.map((n) => d.get(n.id) ?? 0));

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
        const r = (ring * Math.max(320, 60 * count)) / (maxDepth + 1 || 1);
        const angle = (2 * Math.PI * col.indexOf(nd)) / Math.max(1, col.length);
        result.set(nd.id, { x: 400 + r * Math.cos(angle), y: 300 + r * Math.sin(angle) });
        break;
      }
    }
  }
  return result;
}
