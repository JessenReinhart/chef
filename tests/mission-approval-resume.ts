import { strict as assert } from "node:assert";

import { deriveMissionHeartbeat } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const missionId = "mission-approval";
const taskId = "task-approval";

function event(id: string, seq: number, type: string, payload: Record<string, unknown>, task?: string): UiRuntimeEvent {
  return {
    id,
    seq,
    timestamp: seq * 1_000,
    source: { type: task ? "task" : "mission", id: task ?? missionId },
    type,
    payload: { missionId, ...payload },
    taskId: task,
    correlationId: missionId,
  };
}

const waitingForApproval: UiRuntimeEvent[] = [
  event("active", 1, "mission.status", { status: "active" }),
  event("running", 2, "task.running", {}, taskId),
  event("approval-requested", 3, "approval.requested", { reason: "Write generated files" }, taskId),
];

const acceptedButNotResumed = [
  ...waitingForApproval,
  event("approval-accepted", 4, "approval.resolved", { decision: "approved" }, taskId),
];
assert.equal(
  deriveMissionHeartbeat(acceptedButNotResumed, missionId, [taskId], 15_000, 10_000),
  null,
  "accepting an approval must not claim Chef is still working until runtime actually resumes",
);

const resumedByWorker = [
  ...acceptedButNotResumed,
  event("worker-resumed", 5, "task.running", { retryCount: 0 }, taskId),
];
assert.equal(
  deriveMissionHeartbeat(resumedByWorker, missionId, [taskId], 16_000, 10_000)?.text,
  "Chef is still working. Last runtime activity was 11 seconds ago.",
  "a real worker resume after approval must restore long-running feedback",
);

const resumedByMission = [
  ...acceptedButNotResumed,
  event("mission-resumed", 5, "mission.status", { status: "active" }),
];
assert.equal(
  deriveMissionHeartbeat(resumedByMission, missionId, [taskId], 16_000, 10_000)?.text,
  "Chef is still working. Last runtime activity was 11 seconds ago.",
  "a fresh active Mission status after approval is authoritative evidence that work resumed",
);

const rejectedThenIdle = [
  ...waitingForApproval,
  event("approval-rejected", 4, "approval.resolved", { decision: "rejected" }, taskId),
];
assert.equal(
  deriveMissionHeartbeat(rejectedThenIdle, missionId, [taskId], 15_000, 10_000),
  null,
  "a rejected approval must keep suppressing stale working feedback",
);

console.log("mission-approval-resume: ok — approval resolution is acknowledgement, while durable runtime resumption owns heartbeat recovery");
