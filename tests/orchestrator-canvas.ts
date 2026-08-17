/**
 * Orchestrator plan → canvas graph integration (plan Task 4):
 *  after a chat plan executes, the plan is materialized as a durable canvas
 *  graph — one node per plan task (taskId linked, kind from assignedTo),
 *  edges from plan dependencies, and server-side "columns" layout positions.
 *
 * Uses the real runtime + real sqlite temp dir. The default decision provider
 * (no LLM env) is ScriptedDecisionProvider, which proposes the same 2-task
 * plan for any goal:
 *   - "Investigate" (assignedTo: investigator) — no dependencies
 *   - "Verify findings" (assignedTo: verifier) — depends on investigator
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChef } from "../src/main.ts";
import type { WorkspaceSnapshot } from "../src/core/types.ts";

async function main(): Promise<void> {
  const projectDir = await mkdtemp(join(tmpdir(), "chef-orch-canvas-"));
  const dbPath = join(projectDir, "chef.sqlite");

  try {
    const chef = createChef({ dbPath, projectDir });
    await chef.start();
    const workspaceId = chef.workspaceId;

    const result = await chef.sendChatMessage("Investigate and fix the login bug");
    assert.equal(result.ok, true, `orchestrator failed: ${result.report}`);
    assert.equal(result.taskIds.length, 2, "scripted plan must produce exactly 2 tasks");

    const snap: WorkspaceSnapshot = await chef.inspectState();

    // Nodes: one per plan task, linked to the created task ids.
    assert.ok(Array.isArray(snap.canvasNodes), "snapshot must expose canvasNodes");
    assert.equal(snap.canvasNodes.length, 2, "one canvas node per plan task");
    const nodeIds = snap.canvasNodes.map((n) => n.id).sort();
    assert.deepEqual(nodeIds, [...result.taskIds].sort(), "canvas node ids must match plan task ids");
    for (const node of snap.canvasNodes) {
      assert.equal(node.taskId, node.id, "canvas node must be task-backed");
      assert.equal(node.nodeType, "blueprint");
      assert.equal(node.kind, "agent", "scripted plan tasks are all agent-assigned");
      assert.ok(node.label.length > 0, "canvas node must carry the plan task title");
    }

    // Edges: plan task dependencies materialized as canvas edges.
    assert.ok(Array.isArray(snap.canvasEdges), "snapshot must expose canvasEdges");
    assert.equal(snap.canvasEdges.length, 1, "one edge for the verify→investigate dependency");
    const edge = snap.canvasEdges[0];
    assert.equal(edge.source, result.taskIds[0], "edge source must be the dependency (investigate)");
    assert.equal(edge.target, result.taskIds[1], "edge target must be the dependent (verify)");

    // Arranged: positions must be non-zero (columns layout offsets) and
    // the dependent node must sit to the RIGHT of its dependency.
    const pos = new Map(snap.canvasNodes.map((n) => [n.id, n.position]));
    for (const node of snap.canvasNodes) {
      assert.ok(pos.get(node.id)!.x > 0, `node ${node.id} must have an arranged x`);
      assert.ok(pos.get(node.id)!.y > 0, `node ${node.id} must have an arranged y`);
    }
    assert.ok(
      pos.get(edge.source)!.x < pos.get(edge.target)!.x,
      "dependency must be laid out left of its dependent",
    );

    // Durable: survives a close/reopen cycle.
    await chef.close();
    const reopened = createChef({ dbPath, projectDir });
    await reopened.start();
    const restored: WorkspaceSnapshot = await reopened.inspectState();
    assert.equal(restored.canvasNodes.length, 2, "canvas nodes must survive reopen");
    assert.equal(restored.canvasEdges.length, 1, "canvas edges must survive reopen");
    await reopened.close();

    console.log("orchestrator-canvas: ok");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
