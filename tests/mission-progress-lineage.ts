import { strict as assert } from "node:assert";
import {
  deriveMissionHeartbeat,
  summarizeMissionProgressForMission,
} from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const runtimeEvent = (
  id: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): UiRuntimeEvent => ({
  id,
  seq,
  timestamp: seq * 1_000,
  source: { type: "runtime", id: "workspace-1" },
  type,
  payload,
});

const missionId = "mission-fast-path";
const taskId = "task-fast-path";
const events: UiRuntimeEvent[] = [
  runtimeEvent("mission-active", 1, "mission.status", { missionId, status: "active" }),
  runtimeEvent("plan", 2, "orchestrator.plan.proposed", {
    missionId,
    taskId,
    routingMode: "single-worker",
  }),
  runtimeEvent("task-running", 3, "task.running", { taskId }),
  runtimeEvent("worker-output", 4, "session.data", { taskId }),
  runtimeEvent("unrelated-worker", 14, "session.data", { taskId: "task-other" }),
];

const progress = summarizeMissionProgressForMission(
  events,
  missionId,
  [],
  4,
  5_000,
);
assert.equal(
  progress[0]?.id,
  "worker-output",
  "fast-path worker output must remain visible while the Mission taskIds snapshot is still empty",
);
assert.ok(
  progress.some((item) => item.id === "task-running"),
  "singular payload.taskId lineage must retain the worker-start update",
);
assert.ok(
  !progress.some((item) => item.id === "unrelated-worker"),
  "recovering singular Task lineage must not leak another Task into Mission progress",
);

const heartbeat = deriveMissionHeartbeat(events, missionId, [], 15_000, 10_000);
assert.equal(
  heartbeat?.text,
  "Chef is still working. Last runtime activity was 11 seconds ago.",
  "heartbeat silence must be measured from the real fast-path worker activity, not the earlier plan event",
);

console.log("mission-progress-lineage: ok — fast-path singular Task lineage keeps worker activity and heartbeat truthful while Mission task IDs lag");
