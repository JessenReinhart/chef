import { strict as assert } from "node:assert";

import { deriveMissionHeartbeat } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

function runtimeEvent(input: {
  id: string;
  seq: number;
  timestamp: number;
  type: string;
  sourceType?: string;
  sourceId?: string;
  missionId?: string;
  taskId?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}): UiRuntimeEvent {
  return {
    id: input.id,
    seq: input.seq,
    timestamp: input.timestamp,
    source: { type: input.sourceType ?? "runtime", id: input.sourceId ?? "test" },
    type: input.type,
    payload: { ...(input.missionId ? { missionId: input.missionId } : {}), ...(input.payload ?? {}) },
    taskId: input.taskId,
    sessionId: input.sessionId,
  };
}

const missionId = "mission-approval-resume";
const taskId = "task-approved";
const approvalId = "approval-1";
const beforeResume: UiRuntimeEvent[] = [
  runtimeEvent({ id: "active", seq: 1, timestamp: 1_000, type: "mission.status", sourceType: "mission", sourceId: missionId, payload: { status: "active" } }),
  runtimeEvent({ id: "running", seq: 2, timestamp: 2_000, type: "task.running", taskId }),
  runtimeEvent({ id: "approval-requested", seq: 3, timestamp: 3_000, type: "approval.requested", sourceType: "approval", sourceId: approvalId, missionId, taskId }),
  runtimeEvent({ id: "approval-resolved", seq: 4, timestamp: 4_000, type: "approval.resolved", sourceType: "approval", sourceId: approvalId, missionId, taskId, payload: { decision: "accepted" } }),
];

assert.equal(
  deriveMissionHeartbeat(beforeResume, missionId, [taskId], 20_000, 10_000),
  null,
  "resolving an approval must not claim that work resumed before durable execution evidence appears",
);

const projectedActive = runtimeEvent({
  id: "active-after-approval",
  seq: 5,
  timestamp: 5_000,
  type: "mission.status",
  sourceType: "mission",
  sourceId: missionId,
  payload: { status: "active" },
});
assert.equal(
  deriveMissionHeartbeat([...beforeResume, projectedActive], missionId, [taskId], 20_000, 10_000),
  null,
  "a Mission status projection after task approval must not claim that the approved worker resumed",
);

const resumedOutput = runtimeEvent({
  id: "resumed-output",
  seq: 6,
  timestamp: 6_000,
  type: "session.data",
  sourceType: "session",
  sourceId: "session-approved",
  missionId,
  taskId,
  sessionId: "session-approved",
  payload: { data: "continuing after approval" },
});
const resumedHeartbeat = deriveMissionHeartbeat(
  [...beforeResume, projectedActive, resumedOutput],
  missionId,
  [taskId],
  16_000,
  10_000,
);
assert.equal(
  resumedHeartbeat?.text,
  "Chef is still working. Last runtime activity was 10 seconds ago.",
  "same-Task worker output after approval must prove execution resumed and restore long-running heartbeat feedback",
);

const unrelatedOutput = runtimeEvent({
  id: "other-output",
  seq: 6,
  timestamp: 6_000,
  type: "session.data",
  sourceType: "session",
  sourceId: "session-other",
  missionId,
  taskId: "task-other",
  sessionId: "session-other",
  payload: { data: "other task output" },
});
assert.equal(
  deriveMissionHeartbeat([...beforeResume, projectedActive, unrelatedOutput], missionId, [taskId, "task-other"], 20_000, 10_000),
  null,
  "output from another Mission Task must not clear the approval recovery boundary",
);

const rejectedTaskApproval: UiRuntimeEvent[] = [
  runtimeEvent({ id: "active-before-rejection", seq: 1, timestamp: 1_000, type: "mission.status", sourceType: "mission", sourceId: missionId, payload: { status: "active" } }),
  runtimeEvent({ id: "running-before-rejection", seq: 2, timestamp: 2_000, type: "task.running", taskId }),
  runtimeEvent({ id: "approval-requested-before-rejection", seq: 3, timestamp: 3_000, type: "approval.requested", sourceType: "approval", sourceId: approvalId, missionId, taskId }),
  runtimeEvent({ id: "approval-rejected", seq: 4, timestamp: 4_000, type: "approval.resolved", sourceType: "approval", sourceId: approvalId, missionId, taskId, payload: { decision: "rejected" } }),
];
assert.equal(
  deriveMissionHeartbeat(rejectedTaskApproval, missionId, [taskId], 20_000, 10_000),
  null,
  "a denied task approval alone must not pretend Chef has already resumed",
);
const replanningAfterRejection = runtimeEvent({
  id: "planning-after-rejection",
  seq: 5,
  timestamp: 5_000,
  type: "mission.status",
  sourceType: "mission",
  sourceId: missionId,
  payload: { status: "planning" },
});
assert.equal(
  deriveMissionHeartbeat([...rejectedTaskApproval, replanningAfterRejection], missionId, [taskId], 15_000, 10_000)?.text,
  "Chef is still planning. Last runtime activity was 10 seconds ago.",
  "durable Mission replanning after a denied task approval must restore meaningful long-running feedback",
);
const activeAfterRejection = runtimeEvent({
  id: "active-after-rejection",
  seq: 5,
  timestamp: 5_000,
  type: "mission.status",
  sourceType: "mission",
  sourceId: missionId,
  payload: { status: "active" },
});
assert.equal(
  deriveMissionHeartbeat([...rejectedTaskApproval, activeAfterRejection], missionId, [taskId], 20_000, 10_000),
  null,
  "a generic active projection after denial must not weaken the task ownership boundary",
);

const missionApprovalId = "approval-mission";
const missionLevelApproval: UiRuntimeEvent[] = [
  runtimeEvent({ id: "mission-active-before", seq: 1, timestamp: 1_000, type: "mission.status", sourceType: "mission", sourceId: missionId, payload: { status: "active" } }),
  runtimeEvent({ id: "mission-approval-requested", seq: 2, timestamp: 2_000, type: "approval.requested", sourceType: "approval", sourceId: missionApprovalId, missionId }),
  runtimeEvent({ id: "mission-approval-resolved", seq: 3, timestamp: 3_000, type: "approval.resolved", sourceType: "approval", sourceId: missionApprovalId, missionId, payload: { decision: "accepted" } }),
  runtimeEvent({ id: "mission-active-after", seq: 4, timestamp: 4_000, type: "mission.status", sourceType: "mission", sourceId: missionId, payload: { status: "active" } }),
];
const missionLevelHeartbeat = deriveMissionHeartbeat(missionLevelApproval, missionId, [], 14_000, 10_000);
assert.equal(
  missionLevelHeartbeat?.text,
  "Chef is still working. Last runtime activity was 10 seconds ago.",
  "Mission-level approvals without a Task id may use a later active Mission status as their recovery signal",
);

console.log("mission-approval-heartbeat-resume: ok — accepted approvals require same-Task execution while denied approvals may recover through durable replanning");
