import { strict as assert } from "node:assert";
import { TaskMachine } from "../src/runtime/task-machine.ts";
import type { Task } from "../src/core/types.ts";
import { canRetryMissionTask } from "../web/src/missionRecovery.ts";

assert.equal(canRetryMissionTask({
  missionStatus: "failed",
  taskStatus: "failed",
  blockedByApproval: false,
  readOnly: false,
}), true, "failed Mission work must remain retryable");

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

console.log("simple-mode-recovery-actions: ok — Retry follows Mission lifecycle, approvals, read-only state, and clears stale Task failure state");
