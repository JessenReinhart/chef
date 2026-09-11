import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { ChefRuntime } from "../src/main.ts";
import type { RuntimeEvent, Task } from "../src/core/types.ts";
import { Repository } from "../src/persistence/database.ts";
import { createRecoveryServer } from "../src/server/recovery-http.ts";

const repo = new Repository(":memory:");
repo.createWorkspace({ id: "workspace-a", name: "Recovery workspace" });
repo.createWorkspace({ id: "workspace-b", name: "Other workspace" });

function createTerminalMission(input: {
  missionId: string;
  planId: string;
  taskId: string;
  missionStatus: "failed" | "cancelled";
  taskError: string;
}): void {
  repo.insertMission({
    id: input.missionId,
    workspaceId: "workspace-a",
    goal: "Create a simple todo app",
    status: "planning",
    taskIds: [],
  });
  repo.insertPlan({
    id: input.planId,
    workspaceId: "workspace-a",
    goal: "Create a simple todo app",
    missionId: input.missionId,
    status: "failed",
    tasks: [],
    taskIds: [input.taskId],
  });
  repo.updateMission(input.missionId, {
    status: "active",
    planId: input.planId,
    taskIds: [input.taskId],
  });
  repo.insertTask({
    id: input.taskId,
    workspaceId: "workspace-a",
    title: "Build todo app",
    description: "Create and verify the todo app",
    status: "failed",
    missionId: input.missionId,
    dependencies: [],
    contextRefs: [],
    retryCount: 0,
    error: input.taskError,
  });
  repo.updateMission(input.missionId, { status: input.missionStatus });
}

createTerminalMission({
  missionId: "failed-mission",
  planId: "failed-plan",
  taskId: "failed-mission-task",
  missionStatus: "failed",
  taskError: "worker failed during Mission execution",
});
createTerminalMission({
  missionId: "terminal-mission",
  planId: "terminal-plan",
  taskId: "terminal-mission-task",
  missionStatus: "cancelled",
  taskError: "worker failed before cancellation",
});

repo.insertMission({
  id: "partial-mission",
  workspaceId: "workspace-a",
  goal: "Build a multi-step todo app",
  status: "planning",
  taskIds: [],
});
repo.insertPlan({
  id: "partial-plan",
  workspaceId: "workspace-a",
  goal: "Build a multi-step todo app",
  missionId: "partial-mission",
  status: "failed",
  tasks: [],
  taskIds: ["partial-retry-task", "partial-pending-task"],
});
repo.updateMission("partial-mission", {
  status: "active",
  planId: "partial-plan",
  taskIds: ["partial-retry-task", "partial-pending-task"],
});
repo.insertTask({
  id: "partial-retry-task",
  workspaceId: "workspace-a",
  title: "Recover first step",
  description: "retryable failed step",
  status: "failed",
  missionId: "partial-mission",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
  error: "first step failed",
});
repo.insertTask({
  id: "partial-pending-task",
  workspaceId: "workspace-a",
  title: "Unfinished dependent step",
  description: "the original plan dispatcher has already stopped",
  status: "pending",
  missionId: "partial-mission",
  dependencies: ["partial-retry-task"],
  contextRefs: [],
  retryCount: 0,
});
repo.updateMission("partial-mission", { status: "failed" });

repo.insertMission({
  id: "orphaned-mission",
  workspaceId: "workspace-a",
  goal: "Recover work with missing plan linkage",
  status: "planning",
  taskIds: [],
});
repo.updateMission("orphaned-mission", {
  status: "active",
  taskIds: ["orphaned-mission-task"],
});
repo.insertTask({
  id: "orphaned-mission-task",
  workspaceId: "workspace-a",
  title: "Do not dispatch broken recovery",
  description: "failed Mission task whose owning Plan is missing",
  status: "failed",
  missionId: "orphaned-mission",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
  error: "previous attempt failed",
});
repo.updateMission("orphaned-mission", { status: "failed" });

repo.insertTask({
  id: "missing-mission-task",
  workspaceId: "workspace-a",
  title: "Do not dispatch orphaned Mission work",
  description: "failed Task still points at a Mission record that no longer exists",
  status: "failed",
  missionId: "missing-mission",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
  error: "previous Mission attempt failed",
});

repo.insertTask({
  id: "standalone-failed-task",
  workspaceId: "workspace-a",
  title: "Retry standalone work",
  description: "failed work without a Mission owner",
  status: "failed",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
});
repo.insertTask({
  id: "exhausted-task",
  workspaceId: "workspace-a",
  title: "No retries left",
  description: "failed after every configured retry",
  status: "failed",
  dependencies: [],
  contextRefs: [],
  retryCount: 2,
});
repo.insertTask({
  id: "approval-task",
  workspaceId: "workspace-a",
  title: "Wait for approval",
  description: "blocked by a human gate",
  status: "blocked",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
});
repo.insertApproval({
  id: "approval-pending",
  workspaceId: "workspace-a",
  taskId: "approval-task",
  status: "pending",
  requester: "worker",
  reason: "human confirmation required",
});
repo.updateTask("approval-task", { approvalId: "approval-pending" });
repo.insertTask({
  id: "done-task",
  workspaceId: "workspace-a",
  title: "Already done",
  description: "completed work",
  status: "completed",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
});
repo.insertTask({
  id: "other-task",
  workspaceId: "workspace-b",
  title: "Other workspace",
  description: "must stay isolated",
  status: "failed",
  dependencies: [],
  contextRefs: [],
  retryCount: 0,
});

const retryCalls: string[] = [];
const listeners = new Set<(event: RuntimeEvent) => void>();
const runtime = {
  workspaceId: "workspace-a",
  repository: repo,
  async retryTask(taskId: string) {
    const task = repo.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.retryCount >= 2) throw new Error(`Task ${taskId} exceeds retry budget (${task.retryCount}/2)`);
    retryCalls.push(taskId);
    repo.updateTask(taskId, {
      status: "running",
      retryCount: task.retryCount + 1,
      error: null as never,
      resultSummary: null as never,
    });
  },
  subscribeEvents(listener: (event: RuntimeEvent) => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
} as unknown as ChefRuntime;

function emitTaskTerminal(taskId: string, type: "task.completed" | "task.failed" | "task.cancelled"): void {
  const event = { taskId, type } as RuntimeEvent;
  for (const listener of [...listeners]) listener(event);
}

const fallback = createServer((_req, res) => {
  res.writeHead(418, { "content-type": "application/json" });
  res.end(JSON.stringify({ fallback: true }));
});
const server = createRecoveryServer(runtime, fallback);

async function post(path: string) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST" });
  return {
    status: response.status,
    json: await response.json() as { ok?: boolean; data?: Task; error?: string; fallback?: boolean },
  };
}

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const firstRetry = await post("/api/nodes/failed-mission-task/retry");
  assert.equal(firstRetry.status, 200);
  assert.equal(firstRetry.json.ok, true);
  assert.equal(firstRetry.json.data?.status, "running");
  assert.equal(repo.getMission("failed-mission")?.status, "active", "a genuine retry must make its failed Mission visibly active again");
  assert.equal(repo.getPlan("failed-plan")?.status, "executing", "the owning Plan must no longer look failed while retry work is active");
  assert.deepEqual(retryCalls, ["failed-mission-task"]);

  repo.updateTask("failed-mission-task", { status: "failed", error: "retry attempt failed" });
  emitTaskTerminal("failed-mission-task", "task.failed");
  assert.equal(repo.getMission("failed-mission")?.status, "failed", "a failed retry must return the Mission to truthful failure");
  assert.equal(repo.getPlan("failed-plan")?.status, "failed", "a failed retry must return the Plan to truthful failure");

  const secondRetry = await post("/api/nodes/failed-mission-task/retry");
  assert.equal(secondRetry.status, 200);
  assert.equal(secondRetry.json.ok, true);
  assert.equal(secondRetry.json.data?.status, "running");
  assert.equal(repo.getMission("failed-mission")?.status, "active");
  assert.equal(repo.getPlan("failed-plan")?.status, "executing");
  assert.deepEqual(retryCalls, ["failed-mission-task", "failed-mission-task"]);

  repo.updateTask("failed-mission-task", { status: "completed", resultSummary: "todo app recovered" });
  emitTaskTerminal("failed-mission-task", "task.completed");
  assert.equal(repo.getMission("failed-mission")?.status, "completed", "successful recovery must close the same Mission lifecycle");
  assert.equal(repo.getPlan("failed-plan")?.status, "completed", "successful recovery must restore the owning Plan outcome");
  const recoveryMissionStatuses = repo.getWorkspaceSnapshot("workspace-a").events
    .filter((event) => event.type === "mission.status" && event.source.type === "runtime" && event.source.id === "recovery")
    .map((event) => (event.payload as { status?: string }).status);
  assert.deepEqual(
    recoveryMissionStatuses,
    ["active", "failed", "active", "verifying", "completed"],
    "Mission recovery must expose working, repeated failure, and verifying/completed transitions in order",
  );

  const partialRetry = await post("/api/nodes/partial-retry-task/retry");
  assert.equal(partialRetry.status, 200);
  assert.equal(partialRetry.json.data?.status, "running");
  assert.equal(repo.getMission("partial-mission")?.status, "active");
  assert.equal(repo.getPlan("partial-plan")?.status, "executing");
  repo.updateTask("partial-retry-task", { status: "completed", resultSummary: "first step recovered" });
  emitTaskTerminal("partial-retry-task", "task.completed");
  assert.equal(
    repo.getMission("partial-mission")?.status,
    "failed",
    "a same-task retry must not leave a multi-step Mission permanently active when other plan work never restarted",
  );
  assert.equal(repo.getPlan("partial-plan")?.status, "failed");
  assert.equal(repo.getTask("partial-pending-task")?.status, "pending", "recovery must not pretend the stopped plan dispatcher ran unfinished work");

  const brokenLineage = await post("/api/nodes/orphaned-mission-task/retry");
  assert.equal(brokenLineage.status, 409);
  assert.match(brokenLineage.json.error ?? "", /complete recovery path/i);
  assert.match(brokenLineage.json.error ?? "", /Start it as new work/i);
  assert.equal(repo.getMission("orphaned-mission")?.status, "failed", "rejected recovery must not reactivate a Mission whose Plan linkage is missing");
  assert.equal(repo.getTask("orphaned-mission-task")?.status, "failed", "broken Mission lineage must be rejected before worker dispatch");
  assert.deepEqual(
    retryCalls,
    ["failed-mission-task", "failed-mission-task", "partial-retry-task"],
    "broken Mission lineage must not dispatch hidden retry work underneath an error response",
  );

  const missingMission = await post("/api/nodes/missing-mission-task/retry");
  assert.equal(missingMission.status, 409);
  assert.match(missingMission.json.error ?? "", /complete recovery path/i);
  assert.match(missingMission.json.error ?? "", /Start it as new work/i);
  assert.equal(repo.getTask("missing-mission-task")?.status, "failed", "a Task that claims a missing Mission owner must remain failed instead of becoming hidden standalone work");
  assert.deepEqual(
    retryCalls,
    ["failed-mission-task", "failed-mission-task", "partial-retry-task"],
    "a missing Mission owner must be rejected before retry dispatch",
  );

  const success = await post("/api/nodes/standalone-failed-task/retry");
  assert.equal(success.status, 200);
  assert.equal(success.json.ok, true);
  assert.equal(success.json.data?.status, "running");
  assert.deepEqual(
    retryCalls,
    ["failed-mission-task", "failed-mission-task", "partial-retry-task", "standalone-failed-task"],
    "ordinary non-Mission failed work must remain retryable",
  );

  const terminalMission = await post("/api/nodes/terminal-mission-task/retry");
  assert.equal(terminalMission.status, 409);
  assert.match(terminalMission.json.error ?? "", /Mission was cancelled/i);
  assert.match(terminalMission.json.error ?? "", /Continue it as new work/i);
  assert.equal(repo.getTask("terminal-mission-task")?.status, "failed");
  assert.equal(repo.getTask("terminal-mission-task")?.retryCount, 0);

  const exhausted = await post("/api/nodes/exhausted-task/retry");
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.json.error, "This work step has used all available retries.");
  assert.doesNotMatch(exhausted.json.error ?? "", /exhausted-task|retry budget/i, "Simple Mode must not leak scheduler/task jargon when recovery is exhausted");

  const approvalBlocked = await post("/api/nodes/approval-task/retry");
  assert.equal(approvalBlocked.status, 409);
  assert.match(approvalBlocked.json.error ?? "", /waiting for approval/);

  const completed = await post("/api/nodes/done-task/retry");
  assert.equal(completed.status, 409);
  assert.match(completed.json.error ?? "", /not retryable/);

  const otherWorkspace = await post("/api/nodes/other-task/retry");
  assert.equal(otherWorkspace.status, 404);

  const fallbackResult = await post("/api/unrelated");
  assert.equal(fallbackResult.status, 418);
  assert.equal(fallbackResult.json.fallback, true);

  console.log("simple-mode-recovery-http: ok — bounded Retry reconnects Task, Mission, and Plan without dispatching broken recovery lineage");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  repo.close();
}
