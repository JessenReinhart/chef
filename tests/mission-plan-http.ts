import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createMissionPlanServer } from "../src/server/mission-plan-http.ts";

const workspaceId = "workspace-a";
const missions = new Map([
  ["mission-a", { id: "mission-a", workspaceId, planId: "plan-2" }],
  ["mission-other", { id: "mission-other", workspaceId: "workspace-b", planId: "other-plan" }],
]);
const plans = [
  {
    id: "plan-1", workspaceId, missionId: "mission-a", goal: "Initial approach", status: "failed",
    tasks: [{ id: "task-1", title: "Investigate", description: "", dependencies: [], priority: 1 }],
    taskIds: ["task-1"], createdAt: 10, updatedAt: 20,
  },
  {
    id: "plan-2", workspaceId, missionId: "mission-a", goal: "Replanned approach", status: "executing",
    tasks: [{ id: "task-2", title: "Implement", description: "", dependencies: [], priority: 1, assignedTo: "engineer" }],
    taskIds: ["task-2"], createdAt: 30, updatedAt: 40,
  },
  { id: "plan-unrelated", workspaceId, missionId: "different-mission", goal: "Unrelated", status: "draft", tasks: [], taskIds: [], createdAt: 50 },
];
const tasks = new Map([
  ["task-1", { id: "task-1", workspaceId, status: "failed", error: "tests failed" }],
  ["task-2", { id: "task-2", workspaceId, status: "running", assignedTo: "engineer", resultSummary: undefined }],
]);

const runtime = {
  workspaceId,
  repository: {
    getMission: (id: string) => missions.get(id) ?? null,
    listPlans: (requestedWorkspaceId: string) => requestedWorkspaceId === workspaceId ? plans : [],
    getTask: (id: string) => tasks.get(id) ?? null,
  },
} as never;

const baseServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ fallback: req.url }));
});
const server = createMissionPlanServer(runtime, baseServer);

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const response = await fetch(`${origin}/api/missions/mission-a/plans`);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; data: { missionId: string; currentPlanId?: string; plans: Array<Record<string, unknown>> } };
  assert.equal(body.ok, true);
  assert.equal(body.data.missionId, "mission-a");
  assert.equal(body.data.currentPlanId, "plan-2");
  assert.deepEqual(body.data.plans.map((plan) => plan.id), ["plan-1", "plan-2"]);
  assert.equal(body.data.plans[0]?.isCurrent, false);
  assert.equal(body.data.plans[1]?.isCurrent, true);
  assert.deepEqual(body.data.plans[1]?.taskStates, [{ id: "task-2", status: "running", assignedTo: "engineer" }]);

  assert.equal((await fetch(`${origin}/api/missions/nope/plans`)).status, 404);
  assert.equal((await fetch(`${origin}/api/missions/mission-other/plans`)).status, 404);

  const fallback = await fetch(`${origin}/api/state`);
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { fallback: "/api/state" });
  console.log("mission-plan-http: ok");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
