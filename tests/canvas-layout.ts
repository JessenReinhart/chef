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
    assert.ok(Math.abs(pos.get("a")!.y - pos.get("b")!.y) <= 200); // same column, adjacent rows
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
