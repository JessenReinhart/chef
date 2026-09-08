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

const resumedOutput = runtimeEvent({
  id: "resumed-output",
  seq: 5,
  timestamp: 5_000,
  type: "session.data",
  sourceType: "session",
  sourceId: "session-approved",
  missionId,
  taskId,
  sessionId: "session-approved",
  payload: { data: "continuing after approval" },
});
const resumedHeartbeat = deriveMissionHeartbeat(
  [...beforeResume, resumedOutput],
  missionId,
  [taskId],
  15_000,
  10_000,
);
assert.equal(
  resumedHeartbeat?.text,
  "Chef is still working. Last runtime activity was 10 seconds ago.",
  "same-Task worker output after approval must prove execution resumed and restore long-running heartbeat feedback",
);

const unrelatedOutput = runtimeEvent({
  id: "other-output",
  seq: 5,
  timestamp: 5_000,
  type: "session.data",
  sourceType: "session",
  sourceId: "session-other",
  missionId,
  taskId: "task-other",
  sessionId: "session-other",
  payload: { data: "other task output" },
});
assert.equal(
  deriveMissionHeartbeat([...beforeResume, unrelatedOutput], missionId, [taskId, "task-other"], 20_000, 10_000),
  null,
  "output from another Mission Task must not clear the approval recovery boundary",
);

console.log("mission-approval-heartbeat-resume: ok — approval recovery requires real same-Task execution and accepts resumed session output");
