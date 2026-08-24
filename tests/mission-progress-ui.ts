import { strict as assert } from "node:assert";

import { summarizeMissionProgressEvent } from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

function missionStatusEvent(id: string, status: string): UiRuntimeEvent {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    timestamp: 1_000,
    source: { type: "mission", id: "mission-1" },
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

console.log("mission-progress-ui: ok — cancelled Mission progress remains actionable without changing other status tones");
