import { strict as assert } from "node:assert";
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

console.log("simple-mode-recovery-actions: ok — Retry follows Mission lifecycle, approvals, and read-only state");
