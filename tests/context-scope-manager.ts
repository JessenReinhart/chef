import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextScopeManager } from "../src/context/context-scope-manager.ts";
import type { CanvasNode } from "../src/core/types.ts";
const dir = mkdtempSync(join(tmpdir(), "chef-context-scope-")); const storagePath = join(dir, "context-scopes.json");
const nodes: CanvasNode[] = [
  { id: "agent-a", workspaceId: "ws", taskId: null, label: "Researcher", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 100, y: 100 }, updatedAt: 1 },
  { id: "agent-b", workspaceId: "ws", taskId: null, label: "Engineer", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 300, y: 120 }, updatedAt: 1 },
  { id: "agent-outside", workspaceId: "ws", taskId: null, label: "Reviewer", nodeType: "blueprint", kind: "agent", harnessId: "generic", position: { x: 800, y: 800 }, updatedAt: 1 },
];
try {
  const manager = new ContextScopeManager(storagePath);
  const created = manager.create({ id: "auth", workspaceId: "ws", name: "Authentication", bounds: { x: 0, y: 0, width: 500, height: 300 }, contextRefs: ["artifact:requirements", "decision:oauth"] }, nodes);
  assert.deepEqual(created.memberNodeIds, ["agent-a", "agent-b"]); assert.deepEqual(manager.contextRefsForNode("ws", "agent-a", nodes), ["artifact:requirements", "decision:oauth"]); assert.deepEqual(manager.contextRefsForNode("ws", "agent-outside", nodes), []);
  manager.update("ws", "auth", { bounds: { x: 0, y: 0, width: 1000, height: 1000 } }, nodes); assert.deepEqual(manager.get("ws", "auth", nodes)?.memberNodeIds, ["agent-a", "agent-b", "agent-outside"]);
  const moved = nodes.map((node) => node.id === "agent-b" ? { ...node, position: { x: 1200, y: 1200 } } : node); assert.deepEqual(manager.get("ws", "auth", moved)?.memberNodeIds, ["agent-a", "agent-outside"]);
  const reloaded = new ContextScopeManager(storagePath); assert.deepEqual(reloaded.get("ws", "auth", nodes)?.contextRefs, ["artifact:requirements", "decision:oauth"]); assert.deepEqual(reloaded.get("ws", "auth", nodes)?.memberNodeIds, ["agent-a", "agent-b", "agent-outside"]);
  assert.equal(reloaded.delete("ws", "auth"), true); assert.equal(reloaded.get("ws", "auth", nodes), undefined); assert.match(readFileSync(storagePath, "utf8"), /\"scopes\": \[\]/); console.log("context-scope-manager: all assertions passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
