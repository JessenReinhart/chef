import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { ChefRuntime } from "../src/main.ts";
import type { Task } from "../src/core/types.ts";
import { createRecoveryServer } from "../src/server/recovery-http.ts";

const tasks = new Map<string, Task>([
  ["failed-task", {
    id: "failed-task",
    workspaceId: "workspace-a",
    title: "Retry me",
    description: "failed work",
    status: "failed",
    dependencies: [],
    contextRefs: [],
    priority: 0,
    retryCount: 0,
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

const retryCalls: string[] = [];
const runtime = {
  workspaceId: "workspace-a",
  repository: {
    getTask(taskId: string) {
      return tasks.get(taskId) ?? null;
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
    tasks.set(taskId, { ...task, status: "running", retryCount: task.retryCount + 1, updatedAt: task.updatedAt + 1 });
  },
} as unknown as ChefRuntime;

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

  const success = await post("/api/nodes/failed-task/retry");
  assert.equal(success.status, 200);
  assert.equal(success.json.ok, true);
  assert.equal(success.json.data?.status, "running");
  assert.deepEqual(retryCalls, ["failed-task"]);

  const exhausted = await post("/api/nodes/exhausted-task/retry");
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.json.error, "This work step has used all available retries.");
  assert.doesNotMatch(exhausted.json.error ?? "", /exhausted-task|retry budget/i, "Simple Mode must not leak scheduler/task jargon when recovery is exhausted");
  assert.deepEqual(retryCalls, ["failed-task"], "exhausted recovery must not dispatch another worker attempt");

  const approvalBlocked = await post("/api/nodes/approval-task/retry");
  assert.equal(approvalBlocked.status, 409);
  assert.match(approvalBlocked.json.error ?? "", /waiting for approval/);
  assert.deepEqual(retryCalls, ["failed-task"], "pending approval must remain authoritative over retry");

  const completed = await post("/api/nodes/done-task/retry");
  assert.equal(completed.status, 409);
  assert.match(completed.json.error ?? "", /not retryable/);
  assert.deepEqual(retryCalls, ["failed-task"], "non-retryable work must not reach the runtime retry mutation");

  const otherWorkspace = await post("/api/nodes/other-task/retry");
  assert.equal(otherWorkspace.status, 404);
  assert.deepEqual(retryCalls, ["failed-task"], "retry must never cross the active workspace boundary");

  const fallbackResult = await post("/api/unrelated");
  assert.equal(fallbackResult.status, 418);
  assert.equal(fallbackResult.json.fallback, true);

  console.log("simple-mode-recovery-http: ok — retry is reachable, bounded, approval-safe, workspace-scoped, and understandable when exhausted");
} finally {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
