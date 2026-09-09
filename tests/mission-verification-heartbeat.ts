import { strict as assert } from "node:assert";

import { deriveMissionHeartbeat, summarizeMissionProgressForMission } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const missionId = "mission-verification-heartbeat";
const taskId = "task-verification-heartbeat";

function event(
  id: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  task?: string,
): UiRuntimeEvent {
  return {
    id,
    seq,
    timestamp: seq * 1_000,
    source: { type: type.startsWith("mission.") ? "mission" : "runtime", id: type.startsWith("mission.") ? missionId : "test" },
    type,
    payload: { missionId, ...payload },
    taskId: task,
    correlationId: missionId,
  };
}

const verifyingBase: UiRuntimeEvent[] = [
  event("mission-verifying", 1, "mission.status", { status: "verifying" }),
  event("task-completed", 2, "task.completed", { resultSummary: "Todo app created" }, taskId),
];

for (const failedEvaluation of [
  event("evaluation-failed", 3, "orchestrator.task.evaluated", { status: "failed", summary: "Verification rejected the result" }, taskId),
  event("evaluation-error", 3, "orchestrator.task.evaluated", { status: "accepted", error: "Could not verify generated app" }, taskId),
]) {
  const events = [...verifyingBase, failedEvaluation];
  const progress = summarizeMissionProgressForMission(events, missionId, [taskId], 3, 13_000);

  assert.equal(progress[0]?.id, failedEvaluation.id, "verification attention must remain the newest Simple Mode progress item");
  assert.equal(progress[0]?.tone, "attention", "failed verification must remain an attention state");
  assert.equal(
    deriveMissionHeartbeat(events, missionId, [taskId], 13_000, 10_000),
    null,
    "failed verification must suppress stale still-verifying heartbeat feedback",
  );
}

const successfulEvaluation = [
  ...verifyingBase,
  event("evaluation-accepted", 3, "orchestrator.task.evaluated", { status: "accepted", summary: "Todo app verified" }, taskId),
];
assert.equal(
  deriveMissionHeartbeat(successfulEvaluation, missionId, [taskId], 13_000, 10_000)?.text,
  "Chef is still verifying. Last runtime activity was 10 seconds ago.",
  "successful evaluation must not become a heartbeat blocker while terminal Mission status catches up",
);

const failedThenRetried = [
  ...verifyingBase,
  event("evaluation-failed-before-retry", 3, "orchestrator.task.evaluated", { status: "failed", summary: "Needs another pass" }, taskId),
  event("same-task-retry", 4, "task.running", { retryCount: 1 }, taskId),
];
assert.ok(
  deriveMissionHeartbeat(failedThenRetried, missionId, [taskId], 14_000, 10_000),
  "real runtime recovery for the same task must restore long-running feedback",
);

const otherTaskRetry = [
  ...verifyingBase,
  event("evaluation-failed-owned", 3, "orchestrator.task.evaluated", { status: "failed", summary: "Needs another pass" }, taskId),
  event("unrelated-task-running", 4, "task.running", {}, "other-task"),
];
assert.equal(
  deriveMissionHeartbeat(otherTaskRetry, missionId, [taskId, "other-task"], 14_000, 10_000),
  null,
  "unrelated parallel activity must not clear the failed verification owner",
);

const missionLevelFailure: UiRuntimeEvent[] = [
  event("mission-level-verifying", 1, "mission.status", { status: "verifying" }),
  event("evaluation-failed-unowned", 2, "orchestrator.task.evaluated", { status: "failed", error: "Verifier unavailable" }),
];
assert.equal(
  deriveMissionHeartbeat(missionLevelFailure, missionId, [], 12_000, 10_000),
  null,
  "unowned verification failure must suppress heartbeat until Mission-level recovery is durable",
);
missionLevelFailure.push(event("mission-recovered", 3, "mission.status", { status: "active" }));
assert.equal(
  deriveMissionHeartbeat(missionLevelFailure, missionId, [], 13_000, 10_000)?.text,
  "Chef is still working. Last runtime activity was 10 seconds ago.",
  "a later active Mission status may recover an unowned verification blocker",
);

console.log("mission-verification-heartbeat: ok — failed verification never degrades into false active heartbeat feedback");
