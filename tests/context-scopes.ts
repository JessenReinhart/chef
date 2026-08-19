import assert from "node:assert/strict";
import test from "node:test";
import { materializeContextScope, nodeIsInsideScope, resolveScopeMembers } from "../src/core/context-scopes.ts";
import type { CanvasNode } from "../src/core/types.ts";

function node(id: string, x: number, y: number): CanvasNode {
  return { id, workspaceId: "ws", taskId: null, label: id, nodeType: "blueprint", kind: "agent", harnessId: null, position: { x, y }, updatedAt: 0 };
}

test("scope membership is derived from the node anchor position", () => {
  const scope = { x: 10, y: 20, width: 100, height: 80 };
  assert.equal(nodeIsInsideScope(node("inside", 50, 60), scope), true);
  assert.equal(nodeIsInsideScope(node("outside", 200, 60), scope), false);
  assert.equal(nodeIsInsideScope(node("edge", 110, 100), scope), true);
});

test("scope members are deterministic and sorted", () => {
  const nodes = [node("b", 40, 40), node("a", 20, 30), node("c", 200, 200)];
  assert.deepEqual(resolveScopeMembers({ x: 0, y: 0, width: 100, height: 100 }, nodes), ["a", "b"]);
});

test("materialized scope carries typed shared context without creating peer edges", () => {
  const nodes = [node("researcher", 20, 20), node("engineer", 80, 80), node("reviewer", 300, 300)];
  const result = materializeContextScope({
    id: "auth-refactor",
    workspaceId: "ws",
    name: "Authentication Refactor",
    bounds: { x: 0, y: 0, width: 120, height: 120 },
    contextRefs: [{ type: "artifact", id: "requirements" }, { type: "decision", id: "oauth" }],
  }, nodes);
  assert.deepEqual(result.memberNodeIds, ["engineer", "researcher"]);
  assert.deepEqual(result.contextRefs, [{ type: "artifact", id: "requirements" }, { type: "decision", id: "oauth" }]);
});
