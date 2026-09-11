import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { ChefRuntime } from "../src/main.ts";
import type { RuntimeEvent, Task } from "../src/core/types.ts";
import { createRecoveryServer } from "../src/server/recovery-http.ts";

const tasks = new Map<string, Task>([
  ["failed-mission-task", {
    id: "failed-mission-task",
    workspaceId: "workspace-a",
    title: "Recover the todo worker",
    description: "belongs to a failed Mission that should reconnect during Retry",
    status: "failed",
    missionId: "failed-mission",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    error: "worker failed during Mission execution",
    createdAt: 1,
    updatedAt: 1,
  }],
  ["standalone-failed-task", {
    id: "standalone-failed-task",
    workspaceId: "workspace-a",
    title: "Retry standalone work",
    description: "failed work without a Mission owner",
    status: "failed",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  ["terminal-mission-task", {
    id: "terminal-mission-task",
    workspaceId: "workspace-a",
    title: "Keep cancelled history final",
    description: "belongs to a hard-terminal Mission",
    status: "failed",
    missionId: "terminal-mission",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    error: "worker failed before cancellation",
    createdAt: 1,
    updatedAt: 1,
  }],
  ["exhausted-task", {
    id: "exhausted-task",
    workspaceId: "workspace-a",
    title: "No retries left",
    description: "failed after every configured retry",
    status: "failed",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 2,
    createdAt: 1,
    updatedAt: 1,
  }],
  ["approval-task", {
    id: "approval-task",
    workspaceId: "workspace-a",
    title: "Wait for approval",
    description: "blocked by a human gate",
    status: "blocked",
    approvalId: "approval-pending",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  ["done-task", {
    id: "done-task",
    workspaceId: "workspace-a",
    title: "Already done",
    description: "completed work",
    status: "completed",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  ["other-task", {
    id: "other-task",
    workspaceId: "workspace-b",
    title: "Other workspace",
    description: "must stay isolated",
    status: "failed",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
]);

type TestMission = {
  id: string;
  workspaceId: string;
  status: string;
  planId?: string;
  taskIds: string[];
};
const missions = new Map<string, TestMission>([
  ["failed-mission", {
    id: "failed-mission",
    workspaceId: "workspace-a",
    status: "failed",
    planId: "failed-plan",
    taskIds: ["failed-mission-task"],
  }],
  ["terminal-mission", {
    id: "terminal-mission",
    workspaceId: "workspace-a",
    status: "cancelled",
    planId: "terminal-plan",
    taskIds: ["terminal-mission-task"],
  }],
]);
const planStatuses = new Map<string, string>([
  ["failed-plan", "failed"],
  ["terminal-plan", "failed"],
]);

const retryCalls: string[] = [];
const missionStatusEvents: string[] = [];
const listeners = new Set<(event: RuntimeEvent) => void>();
const runtime = {
  workspaceId: "workspace-a",
  repository: {
    getTask(taskId: string) {
      return tasks.get(taskId) ?? null;
    },
    updateTask(taskId: string, patch: Partial<Task>) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      const updated = { ...task, ...patch, error: patch.error === null ? undefined : patch.error ?? task.error } as Task;
      tasks.set(taskId, updated);
      return updated;
    },
    getMission(missionId: string) {
      return missions.get(missionId) ?? null;
    },
    updateMission(missionId: string, patch: { status?: string }) {
      const mission = missions.get(missionId);
      if (!mission) throw new Error(`Mission ${missionId} not found`);
      const updated = { ...mission, ...patch };
      missions.set(missionId, updated);
      return updated;
    },
    updatePlanStatus(planId: string, status: string) {
      planStatuses.set(planId, status);
    },
    appendEvent(input: { type: string; payload?: unknown }) {
      if (input.type === "mission.status") {
        const payload = input.payload as { status?: string } | undefined;
        if (payload?.status) missionStatusEvents.push(payload.status);
      }
      return {} as RuntimeEvent;
    },
    getApproval(approvalId: string) {
      return approvalId === "approval-pending" ? { id: approvalId, status: "pending" } : null;
    },
  },
  async retryTask(taskId: string) {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.retryCount >= 2) throw new Error(`Task ${taskId} exceeds retry budget (${task.retryCount}/2)`);
    retryCalls.push(taskId);
    tasks.set(taskId, {
      ...task,
      status: "running",
      retryCount: task.retryCount + 1,
      error: undefined,
      resultSummary: undefined,
      updatedAt: task.updatedAt + 1,
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
  assert.equal(missions.get("failed-mission")?.status, "active", "a genuine retry must make its failed Mission visibly active again");
  assert.equal(planStatuses.get("failed-plan"), "executing", "the owning Plan must no longer look failed while retry work is active");
  assert.deepEqual(retryCalls, ["failed-mission-task"]);

  tasks.set("failed-mission-task", {
    ...tasks.get("failed-mission-task")!,
    status: "failed",
    error: "retry attempt failed",
  });
  emitTaskTerminal("failed-mission-task", "task.failed");
  assert.equal(missions.get("failed-mission")?.status, "failed", "a failed retry must return the Mission to truthful failure");
  assert.equal(planStatuses.get("failed-plan"), "failed", "a failed retry must return the Plan to truthful failure");

  const secondRetry = await post("/api/nodes/failed-mission-task/retry");
  assert.equal(secondRetry.status, 200);
  assert.equal(secondRetry.json.ok, true);
  assert.equal(secondRetry.json.data?.status, "running");
  assert.equal(missions.get("failed-mission")?.status, "active");
  assert.equal(planStatuses.get("failed-plan"), "executing");
  assert.deepEqual(retryCalls, ["failed-mission-task", "failed-mission-task"]);

  tasks.set("failed-mission-task", {
    ...tasks.get("failed-mission-task")!,
    status: "completed",
    resultSummary: "todo app recovered",
  });
  emitTaskTerminal("failed-mission-task", "task.completed");
  assert.equal(missions.get("failed-mission")?.status, "completed", "successful recovery must close the same Mission lifecycle");
  assert.equal(planStatuses.get("failed-plan"), "completed", "successful recovery must restore the owning Plan outcome");
  assert.deepEqual(
    missionStatusEvents,
    ["active", "failed", "active", "verifying", "completed"],
    "Mission recovery must expose working, repeated failure, and verifying/completed transitions in order",
  );

  const success = await post("/api/nodes/standalone-failed-task/retry");
  assert.equal(success.status, 200);
  assert.equal(success.json.ok, true);
  assert.equal(success.json.data?.status, "running");
  assert.deepEqual(retryCalls, ["failed-mission-task", "failed-mission-task", "standalone-failed-task"], "ordinary non-Mission failed work must remain retryable");

  const terminalMission = await post("/api/nodes/terminal-mission-task/retry");
  assert.equal(terminalMission.status, 409);
  assert.match(terminalMission.json.error ?? "", /Mission was cancelled/i);
  assert.match(terminalMission.json.error ?? "", /Continue it as new work/i);
  assert.equal(tasks.get("terminal-mission-task")?.status, "failed");
  assert.equal(tasks.get("terminal-mission-task")?.retryCount, 0);

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

  console.log("simple-mode-recovery-http: ok — bounded Retry reconnects Task, Mission, and Plan through repeated failure to verified completion");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
