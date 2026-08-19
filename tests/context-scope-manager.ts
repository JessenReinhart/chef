import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextScopeManager } from "../src/context/context-scope-manager.ts";
import type { CanvasNode } from "../src/core/types.ts";

const dir = mkdtempSync(join(tmpdir(), "chef-context-scope-"));
const storagePath = join(dir, "context-scopes.json");
const nodes: CanvasNode[] = [
  { id: "agent-a", workspaceId: "ws", taskId: null, label: "Researcher", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 100, y: 100 }, updatedAt: 1 },
  { id: "agent-b", workspaceId: "ws", taskId: null, label: "Engineer", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 300, y: 120 }, updatedAt: 1 },
  { id: "agent-outside", workspaceId: "ws", taskId: null, label: "Reviewer", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 800, y: 800 }, updatedAt: 1 },
];

try {
  const manager = new ContextScopeManager(storagePath);
  const created = manager.create({
    id: "auth",
    workspaceId: "ws",
    name: "Authentication",
    bounds: { x: 0, y: 0, width: 500, height: 300 },
    contextRefs: [
      { type: "artifact", id: "requirements" },
      { type: "decision", id: "oauth" },
      { type: "artifact", id: "requirements" },
    ],
  }, nodes);
  assert.deepEqual(created.memberNodeIds, ["agent-a", "agent-b"]);
  assert.deepEqual(manager.contextRefsForNode("ws", "agent-a", nodes), [
    { type: "artifact", id: "requirements" },
    { type: "decision", id: "oauth" },
  ]);
  assert.deepEqual(manager.contextRefsForNode("ws", "agent-outside", nodes), []);

  const persisted = JSON.parse(readFileSync(storagePath, "utf8")) as { scopes: Array<Record<string, unknown>> };
  assert.equal("memberNodeIds" in persisted.scopes[0], false, "membership must be derived, not persisted");

  manager.update("ws", "auth", { bounds: { x: 0, y: 0, width: 1000, height: 1000 } }, nodes);
  assert.deepEqual(manager.get("ws", "auth", nodes)?.memberNodeIds, ["agent-a", "agent-b", "agent-outside"]);

  const moved = nodes.map((node) => node.id === "agent-b" ? { ...node, position: { x: 1200, y: 1200 } } : node);
  assert.deepEqual(manager.get("ws", "auth", moved)?.memberNodeIds, ["agent-a", "agent-outside"]);

  assert.throws(() => manager.create({ id: "bad", workspaceId: "ws", name: "Bad", bounds: { x: 0, y: 0, width: -1, height: 10 } }, nodes), /non-negative/);
  assert.throws(() => manager.create({ id: "nan", workspaceId: "ws", name: "Bad", bounds: { x: Number.NaN, y: 0, width: 10, height: 10 } }, nodes), /finite/);

  const reloaded = new ContextScopeManager(storagePath);
  assert.deepEqual(reloaded.get("ws", "auth", nodes)?.contextRefs, [
    { type: "artifact", id: "requirements" },
    { type: "decision", id: "oauth" },
  ]);
  assert.deepEqual(reloaded.get("ws", "auth", nodes)?.memberNodeIds, ["agent-a", "agent-b", "agent-outside"]);

  assert.equal(reloaded.delete("ws", "auth"), true);
  assert.equal(reloaded.get("ws", "auth", nodes), undefined);
  assert.match(readFileSync(storagePath, "utf8"), /\"scopes\": \[\]/);
  console.log("context-scope-manager: all assertions passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
