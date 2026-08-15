/**
 * Canvas graph projection regression (spec §12.3):
 *  1. GET /api/graph returns a serializable workflow graph (version 1).
 *  2. Every plan task appears as a node; dependencies become control edges.
 *  3. Approval-gated tasks expose an approval node + approval edge.
 */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { buildPlanGraph } from "../src/core/graph.ts";
import type { Plan, PlanProposalContext, WorkspaceSnapshot } from "../src/core/types.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-canvas-test-"));
const chef = createChef({
  dbPath: join(dir, "chef.sqlite"),
  projectDir: dir,
  decisionProvider: {
    name: "canvas-test",
    async proposePlan(input: PlanProposalContext): Promise<Plan> {
      const a = randomUUID();
      const b = randomUUID();
      const gated = randomUUID();
      const approvalId = randomUUID();
      return {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        goal: input.goal,
        status: "proposed",
        tasks: [
          { id: a, title: "Alpha", description: "", dependencies: [], priority: 1, assignedTo: "investigator" },
          { id: b, title: "Beta", description: "", dependencies: [a], priority: 1, assignedTo: "verifier" },
          { id: gated, title: "Gated", description: "", dependencies: [b], priority: 1, assignedTo: "verifier", approvalId },
        ],
        taskIds: [a, b, gated],
        createdAt: Date.now(),
      };
    },
    async evaluate(outcome) {
      return { id: randomUUID(), workspaceId: "", type: "task.evaluation", summary: outcome.status, payload: outcome, madeBy: "canvas-test", timestamp: Date.now(), status: "accepted" };
    },
  },
});

try {
  await chef.start();

  // Direct graph builder over an empty snapshot.
  const empty = buildPlanGraph({ tasks: [], plans: [], sessions: [], artifacts: [], decisions: [], events: [], approvals: [], workspaceId: chef.workspaceId, generatedAt: Date.now() } as WorkspaceSnapshot);
  assert.equal(empty.version, 1, "graph must be version 1");
  assert.equal(empty.nodes.length, 0, "empty snapshot must produce an empty graph");

  const execution = chef.sendUserMessage("canvas plan");
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  const snapshot = await chef.inspectState();
  assert.ok(snapshot.plans.length === 1, "plan must be persisted");
  const graph = buildPlanGraph(snapshot);
  const planTasks = snapshot.plans[0].taskIds;
  assert.equal(graph.nodes.length, planTasks.length + 1, "one node per plan task plus the approval node");
  for (const taskId of planTasks) {
    assert.ok(graph.nodes.some((n) => n.taskId === taskId), `task ${taskId} must have a graph node`);
  }
  const controlEdges = graph.edges.filter((e) => e.kind === "control");
  assert.equal(controlEdges.length, 2, "two dependency edges (a→b, b→gated)");
  const approvalEdges = graph.edges.filter((e) => e.kind === "approval");
  assert.equal(approvalEdges.length, 1, "one approval edge for the gated task");
  const approvalNode = graph.nodes.find((n) => n.kind === "human");
  assert.ok(approvalNode, "gated task must expose a human approval node");
  assert.equal(approvalNode!.type, "approval");
  assert.equal(graph.nodes.every((n) => typeof n.position.x === "number" && typeof n.position.y === "number"), true, "nodes must carry deterministic positions");

  // HTTP projection endpoint.
  const server = createHttpServer(chef);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const graphRes = await fetch(`http://127.0.0.1:${address.port}/api/graph`);
  assert.equal(graphRes.status, 200, "graph endpoint must return 200");
  const viaHttp = (await graphRes.json()) as { version: number; nodes: unknown[]; edges: unknown[] };
  assert.equal(viaHttp.version, 1, "HTTP graph must be version 1");
  assert.ok(viaHttp.nodes.length >= 3, "HTTP graph must include plan nodes");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await execution;
  await chef.close();
  console.log("canvas-graph: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
