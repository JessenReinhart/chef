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
    id: "plan-2", workspaceId, missionId: "mission-a", goal: "Replanned approach", status: "failed",
    tasks: [
      { id: "task-2", title: "Implement A", description: "", dependencies: [], priority: 1, assignedTo: "engineer" },
      { id: "task-3", title: "Implement B", description: "", dependencies: [], priority: 1, assignedTo: "engineer" },
      { id: "task-4", title: "Implement C", description: "", dependencies: [], priority: 1, assignedTo: "engineer" },
      { id: "task-5", title: "Implement D", description: "", dependencies: [], priority: 1, assignedTo: "engineer" },
      { id: "task-6", title: "Verify", description: "", dependencies: [], priority: 1, assignedTo: "critic" },
      { id: "task-7", title: "Recover", description: "", dependencies: [], priority: 1, assignedTo: "engineer" },
    ],
    taskIds: ["task-2", "task-3", "task-4", "task-5", "task-6", "task-7"], createdAt: 30, updatedAt: 40,
  },
  { id: "plan-unrelated", workspaceId, missionId: "different-mission", goal: "Unrelated", status: "draft", tasks: [], taskIds: [], createdAt: 50 },
];
const tasks = new Map([
  ["task-1", { id: "task-1", workspaceId, status: "failed", error: "tests failed" }],
  ["task-2", { id: "task-2", workspaceId, status: "completed", assignedTo: "engineer", resultSummary: "A done" }],
  ["task-3", { id: "task-3", workspaceId, status: "completed", assignedTo: "engineer", resultSummary: "B done" }],
  ["task-4", { id: "task-4", workspaceId, status: "completed", assignedTo: "engineer", resultSummary: "C done" }],
  ["task-5", { id: "task-5", workspaceId, status: "completed", assignedTo: "engineer", resultSummary: "D done" }],
  ["task-6", { id: "task-6", workspaceId, status: "failed", assignedTo: "critic", error: "verification failed" }],
  ["task-7", { id: "task-7", workspaceId, status: "blocked", assignedTo: "engineer", error: "waiting on recovery" }],
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

  const currentTaskStates = body.data.plans[1]?.taskStates as Array<{ id: string; status: string; assignedTo?: string; resultSummary?: string; error?: string }>;
  assert.deepEqual(
    currentTaskStates.map((task) => task.id),
    ["task-6", "task-7", "task-2", "task-3", "task-4", "task-5"],
    "unresolved failed/blocked work should consume bounded outcome-summary attention before completed result history",
  );
  assert.deepEqual(currentTaskStates.slice(0, 2), [
    { id: "task-6", status: "failed", assignedTo: "critic", error: "verification failed" },
    { id: "task-7", status: "blocked", assignedTo: "engineer", error: "waiting on recovery" },
  ]);
  assert.deepEqual(
    currentTaskStates.slice(2).map((task) => task.id),
    ["task-2", "task-3", "task-4", "task-5"],
    "equal-priority completed history should preserve durable plan order",
  );

  assert.equal((await fetch(`${origin}/api/missions/nope/plans`)).status, 404);
  assert.equal((await fetch(`${origin}/api/missions/mission-other/plans`)).status, 404);

  const fallback = await fetch(`${origin}/api/state`);
  assert.equal(fallback.status, 200);
  assert.deepEqual(await fallback.json(), { fallback: "/api/state" });
  console.log("mission-plan-http: ok — unresolved outcome details are projected before completed history");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
