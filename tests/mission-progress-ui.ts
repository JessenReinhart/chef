import { strict as assert } from "node:assert";

import {
  deriveMissionHomeState,
  summarizeMissionProgressEvent,
  summarizeMissionProgressForMission,
} from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

function missionStatusEvent(id: string, status: string, missionId = "mission-1"): UiRuntimeEvent {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    timestamp: 1_000,
    source: { type: "mission", id: missionId },
    type: "mission.status",
    payload: { status },
  };
}

const cancelled = summarizeMissionProgressEvent(missionStatusEvent("event-1", "cancelled"));
assert.ok(cancelled);
assert.equal(cancelled.text, "Mission cancelled.");
assert.equal(cancelled.tone, "attention", "cancelled Missions must remain visibly actionable");

const completed = summarizeMissionProgressEvent(missionStatusEvent("event-2", "completed"));
assert.ok(completed);
assert.equal(completed.tone, "success", "completed Missions must keep their success projection");

const active = summarizeMissionProgressEvent(missionStatusEvent("event-3", "active"));
assert.ok(active);
assert.equal(active.tone, "active", "active Missions must keep their active projection");

const paused = summarizeMissionProgressEvent(missionStatusEvent("event-4", "paused"));
assert.ok(paused);
assert.equal(paused.tone, "neutral", "paused Missions retain the existing neutral projection in this slice");

assert.equal(
  deriveMissionHomeState({ submitting: true, needsAttention: false, working: false, done: false }),
  "working",
  "a request must leave Ready immediately, before the first runtime refresh",
);
assert.equal(
  deriveMissionHomeState({ submitting: true, needsAttention: true, working: false, done: false }),
  "working",
  "a newly submitted follow-up must not inherit a stale failed Mission presentation",
);
assert.equal(
  deriveMissionHomeState({ submitting: false, needsAttention: true, working: false, done: false }),
  "attention",
);
assert.equal(
  deriveMissionHomeState({ submitting: false, needsAttention: false, working: false, done: true }),
  "done",
);

const progressEvents: UiRuntimeEvent[] = [
  missionStatusEvent("event-10", "planning", "mission-1"),
  {
    id: "event-11",
    seq: 11,
    timestamp: 1_100,
    source: { type: "orchestrator", id: "orchestrator" },
    type: "orchestrator.plan.proposed",
    payload: { taskIds: ["task-1", "task-2"] },
    correlationId: "mission-1",
  },
  {
    id: "event-12",
    seq: 12,
    timestamp: 1_200,
    source: { type: "task", id: "task-1" },
    type: "orchestrator.plan.executing",
    payload: { taskIds: ["task-1", "task-2"] },
    taskId: "task-1",
  },
  missionStatusEvent("event-13", "planning", "mission-2"),
];

const scopedProgress = summarizeMissionProgressForMission(progressEvents, "mission-1", ["task-1", "task-2"]);
assert.deepEqual(
  scopedProgress.map((item) => item.text),
  [
    "Chef started coordinating 2 planned steps.",
    "Chef prepared a plan with 2 steps.",
    "Chef is planning the Mission.",
  ],
  "Simple Mode progress must use current-Mission runtime events and exclude unrelated work",
);

console.log("mission-progress-ui: ok — submitted work leaves Ready and current Mission events project truthful live progress");
