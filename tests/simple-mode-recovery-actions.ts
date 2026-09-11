import { strict as assert } from "node:assert";
import { TaskMachine } from "../src/runtime/task-machine.ts";
import { Scheduler, type HarnessLike, type HarnessRegistry } from "../src/runtime/scheduler.ts";
import { Repository } from "../src/persistence/database.ts";
import type { Task } from "../src/core/types.ts";
import { canRetryMissionTask, createTaskRetryOwnership } from "../web/src/missionRecovery.ts";

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "failed",
  retryCount: 1,
  blockedByApproval: false,
  readOnly: false,
}), false, "failed Mission history must continue as new work instead of advertising an orphan Task retry");

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "failed",
  retryCount: 2,
  blockedByApproval: false,
  readOnly: false,
}), false, "failed Mission work at the retry budget must not advertise a dead Retry action");

assert.equal(canRetryMissionTask({
  missionStatus: "blocked",
  taskStatus: "blocked",
  retryCount: 2,
  blockedByApproval: false,
  readOnly: false,
}), false, "blocked Mission work at the retry budget must not advertise a dead Retry action");

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), false, "failed Mission history stays final even when old projections lack retry metadata");

assert.equal(canRetryMissionTask({
  missionStatus: "blocked",
  taskStatus: "blocked",
  blockedByApproval: false,
  readOnly: false,
}), true, "ordinary blocked Mission work must remain retryable");

assert.equal(canRetryMissionTask({
  missionStatus: "paused",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), false, "paused Missions must keep their pause gate instead of exposing Task Retry");

assert.equal(canRetryMissionTask({
  missionStatus: "waiting_for_approval",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), false, "approval-waiting Missions must resolve the approval gate before Task Retry is offered");

assert.equal(canRetryMissionTask({
  missionStatus: "waiting_for_approval",
  taskStatus: "blocked",
  blockedByApproval: false,
  readOnly: false,
}), false, "approval-waiting Missions must not advertise an independent blocked-Task Retry path");

assert.equal(canRetryMissionTask({
  missionStatus: "cancelled",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), false, "cancelled Mission history must not expose a dead task Retry action");

assert.equal(canRetryMissionTask({
  missionStatus: "completed",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), false, "completed Mission history must not expose a dead task Retry action");

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "blocked",
  blockedByApproval: true,
  readOnly: false,
}), false, "approval-blocked work must stay in the approval flow");

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: true,
}), false, "archived Thread history must remain read-only");

assert.equal(canRetryMissionTask({
  missionStatus: undefined,
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), true, "temporary Mission projection lag must not hide a valid recovery action");

const retryOwnership = createTaskRetryOwnership();
assert.equal(retryOwnership.begin("thread-a-task"), true, "the first retry for a Task must acquire ownership");
assert.equal(retryOwnership.begin("thread-a-task"), false, "the same Task must remain single-flight while its retry is pending");
assert.equal(retryOwnership.begin("thread-b-task"), true, "an unrelated Task must remain retryable while another Thread has a retry pending");
assert.deepEqual(
  [...retryOwnership.snapshot()].sort(),
  ["thread-a-task", "thread-b-task"],
  "independent pending retries must be tracked together rather than replacing one another",
);
retryOwnership.finish("thread-a-task");
assert.deepEqual(
  [...retryOwnership.snapshot()],
  ["thread-b-task"],
  "late settlement of one Thread's retry must not clear another Task's pending ownership",
);
assert.equal(retryOwnership.begin("thread-a-task"), true, "a settled Task must become retryable again without disturbing other pending work");
retryOwnership.finish("thread-b-task");
assert.deepEqual(
  [...retryOwnership.snapshot()],
  ["thread-a-task"],
  "settling the second retry must preserve a newer retry acquired by the first Task",
);
retryOwnership.finish("thread-a-task");
assert.equal(retryOwnership.snapshot().size, 0, "all ownership must clear once each Task settles");

const failedTask: Task = {
  id: "task-retry-failed",
  workspaceId: "workspace-recovery",
  title: "Build todo app",
  description: "Create and verify the todo app",
  status: "failed",
  assignedTo: "worker-1",
  dependencies: [],
  contextRefs: [],
  priority: 1,
  retryCount: 1,
  error: "npm test failed on the first attempt",
  resultSummary: "stale partial result",
  createdAt: 1,
  updatedAt: 2,
};

const failedRetry = TaskMachine.transition(failedTask, "running", { retryCount: 2 });
assert.equal(failedRetry.task.status, "running", "a failed Task retry should re-enter running state");
assert.equal(failedRetry.task.error, undefined, "a healthy retry must not retain the previous failure error");
assert.equal(failedRetry.task.resultSummary, undefined, "a healthy retry must not retain a stale prior result summary");
assert.equal(failedRetry.task.retryCount, 2, "retry metadata must still be applied while stale state is cleared");
assert.equal(failedRetry.task.assignedTo, "worker-1", "retry cleanup must preserve unrelated Task ownership metadata");
assert.equal(failedRetry.event.type, "task.running", "retry cleanup must preserve the normal transition event");

const blockedTask: Task = {
  ...failedTask,
  id: "task-retry-blocked",
  status: "blocked",
  error: "tool temporarily unavailable",
  resultSummary: "blocked partial output",
};
const blockedRetry = TaskMachine.transition(blockedTask, "running");
assert.equal(blockedRetry.task.error, undefined, "blocked Task retry must clear the prior blocker error");
assert.equal(blockedRetry.task.resultSummary, undefined, "blocked Task retry must clear stale partial output");

const explicitReplacement = TaskMachine.transition(failedTask, "running", {
  error: "replacement diagnostic",
  resultSummary: "replacement context",
});
assert.equal(explicitReplacement.task.error, "replacement diagnostic", "explicit retry metadata must override the default cleanup");
assert.equal(explicitReplacement.task.resultSummary, "replacement context", "explicit result metadata must override the default cleanup");

const repo = new Repository(":memory:");
const workspace = repo.createWorkspace({ id: "workspace-durable-retry", name: "Durable retry" });
repo.seedAgent({ id: "worker-durable", workspaceId: workspace.id, name: "Worker", role: "implementation" });
const durableFailed = repo.insertTask({
  id: "task-durable-retry",
  workspaceId: workspace.id,
  title: "Build todo app",
  description: "Create and verify the todo app",
  status: "failed",
  assignedTo: "worker-durable",
  retryCount: 1,
  error: "first attempt failed",
  resultSummary: "stale first-attempt result",
});

const fakeHarness: HarnessLike = {
  id: "fake-durable-retry",
  command: "fake-worker",
  args: [],
  cwd: process.cwd(),
  async spawn(options) { return { id: options?.sessionId ?? "fake-session", pid: 1234 }; },
  async *events() {},
  async send() {},
  async interrupt() {},
  async resize() {},
  async terminate() {},
  async forget() {},
  async writeContextRefs() { return "fake-context"; },
  async writeMessage() { return "fake-message"; },
  async close() {},
};
const harnesses = new Map([["worker-durable", fakeHarness]]);
const registry: HarnessRegistry = {
  get(agentId) { return harnesses.get(agentId); },
  set(agentId, harness) { harnesses.set(agentId, harness); },
  values() { return harnesses.values(); },
};
const scheduler = new Scheduler(repo, registry, { maxRetries: 2 });
await scheduler.retryTask(workspace.id, durableFailed.id);

const durableRunning = repo.getTask(durableFailed.id)!;
assert.equal(durableRunning.status, "running", "Scheduler retry should durably re-enter running state");
assert.equal(durableRunning.error, undefined, "Scheduler retry must clear the prior durable failure error");
assert.equal(durableRunning.resultSummary, undefined, "Scheduler retry must clear the prior durable result summary");
assert.equal(durableRunning.retryCount, 2, "Scheduler retry must durably increment retry count");
assert.equal(durableRunning.assignedTo, "worker-durable", "Scheduler retry cleanup must preserve assignment");
assert.ok(
  repo.getWorkspaceSnapshot(workspace.id).events.some((event) => event.taskId === durableFailed.id && event.type === "task.running"),
  "Scheduler retry must preserve the task.running event contract",
);
repo.close();

console.log("simple-mode-recovery-actions: ok — Retry respects terminal Mission history, per-Task ownership, retry budget, approvals, read-only state, and clears stale standalone Task failure state durably");
