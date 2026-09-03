import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChef } from "../src/main.ts";
import { createHttpServer } from "../src/server/http-server.ts";
import { createBlockerServer } from "../src/server/blocker-http.ts";
import { createRecoveryServer } from "../src/server/recovery-http.ts";

const dir = await mkdtemp(join(tmpdir(), "chef-blocker-http-"));
const runtime = createChef({ dbPath: join(dir, "chef.sqlite"), projectDir: dir });
const server = createRecoveryServer(runtime, createBlockerServer(runtime, createHttpServer(runtime)));

const request = async (path: string, method = "GET") => {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
  return { status: response.status, json: await response.json() as { ok?: boolean; data?: unknown; error?: string } };
};

try {
  const mission = runtime.repository.insertMission({
    id: "mission-review",
    workspaceId: runtime.workspaceId,
    goal: "Ship the reviewed result",
    status: "waiting_for_approval",
  });
  runtime.repository.insertTask({
    id: "task-approval",
    workspaceId: runtime.workspaceId,
    title: "Publish result",
    description: "Wait for human approval",
    status: "blocked",
    missionId: mission.id,
  });
  runtime.repository.insertApproval({
    id: "approval-publish",
    workspaceId: runtime.workspaceId,
    taskId: "task-approval",
    status: "pending",
    requester: "orchestrator",
    reason: "Human approval is required before publish",
  });
  runtime.repository.updateTask("task-approval", { approvalId: "approval-publish" });
  runtime.repository.insertTask({
    id: "task-failed",
    workspaceId: runtime.workspaceId,
    title: "Verify output",
    description: "Run verification",
    status: "failed",
    missionId: mission.id,
    error: "verification failed",
    retryCount: 1,
  });
  runtime.repository.insertApproval({
    id: "approval-resolved",
    workspaceId: runtime.workspaceId,
    taskId: "task-failed",
    status: "accepted",
    requester: "orchestrator",
    reason: "Already resolved",
    approver: "user",
    resolvedAt: Date.now(),
  });

  const otherWorkspace = runtime.repository.createWorkspace({ name: "Other workspace" });
  runtime.repository.insertTask({
    id: "task-other",
    workspaceId: otherWorkspace.id,
    title: "Private blocker",
    description: "Must not leak",
    status: "blocked",
  });
  runtime.repository.insertApproval({
    id: "approval-other",
    workspaceId: otherWorkspace.id,
    taskId: "task-other",
    status: "pending",
    requester: "other",
    reason: "Private approval",
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const result = await request("/api/blockers");
  assert.equal(result.status, 200);
  const data = result.json.data as {
    counts: { pendingApprovals: number; blockedTasks: number; failedTasks: number };
    pendingApprovals: Array<{ id: string; task: { id: string; title: string; missionId?: string }; mission: { id: string; goal: string; status: string } | null }>;
    blockedTasks: Array<{ id: string; approvalId?: string }>;
    failedTasks: Array<{ id: string; error?: string; retryCount: number; missionId?: string }>;
  };
  assert.deepEqual(data.counts, { pendingApprovals: 1, blockedTasks: 1, failedTasks: 1 });
  assert.equal(data.pendingApprovals[0].id, "approval-publish");
  assert.equal(data.pendingApprovals[0].task.id, "task-approval");
  assert.equal(data.pendingApprovals[0].task.title, "Publish result");
  assert.equal(data.pendingApprovals[0].mission?.id, mission.id);
  assert.equal(data.pendingApprovals[0].mission?.goal, mission.goal);
  assert.equal(data.pendingApprovals[0].mission?.status, "waiting_for_approval");
  assert.deepEqual(data.blockedTasks.map((task) => task.id), ["task-approval"]);
  assert.equal(data.blockedTasks[0].approvalId, "approval-publish");
  assert.deepEqual(data.failedTasks.map((task) => task.id), ["task-failed"]);
  assert.equal(data.failedTasks[0].error, "verification failed");
  assert.equal(data.failedTasks[0].retryCount, 1);
  assert.equal(data.failedTasks[0].missionId, mission.id);
  assert.ok(!JSON.stringify(data).includes("approval-other"));
  assert.ok(!JSON.stringify(data).includes("task-other"));

  const retry = await request("/api/nodes/task-failed/retry", "POST");
  assert.equal(retry.status, 200);
  assert.equal(retry.json.ok, true);

  const retriedTask = runtime.repository.getTask("task-failed");
  assert.ok(retriedTask);
  assert.notEqual(retriedTask.status, "failed");
  assert.equal(retriedTask.error, undefined);
  assert.equal(retriedTask.retryCount, 2);

  const afterRetry = await request("/api/blockers");
  assert.equal(afterRetry.status, 200);
  const afterRetryData = afterRetry.json.data as {
    counts: { pendingApprovals: number; blockedTasks: number; failedTasks: number };
    failedTasks: Array<{ id: string }>;
  };
  assert.equal(afterRetryData.counts.failedTasks, 0);
  assert.ok(!afterRetryData.failedTasks.some((task) => task.id === "task-failed"));

  const state = await request("/api/state");
  assert.equal(state.status, 200);
  console.log("blocker-http: ok");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
}
