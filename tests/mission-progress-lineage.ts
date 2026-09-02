import { strict as assert } from "node:assert";
import {
  deriveMissionHeartbeat,
  summarizeMissionProgressForMission,
} from "../web/src/missionProgress.ts";
import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { UiMission, UiRuntimeEvent, UiTask } from "../web/src/types.ts";

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
  taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
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

const laggingMission: UiMission = {
  id: missionId,
  goal: "Create a simple todo app",
  status: "active",
  taskIds: [],
  metadata: { threadId: "thread-fast-path" },
  createdAt: 1_000,
  updatedAt: 4_000,
};
const completedFastTask: UiTask = {
  id: taskId,
  title: "Build todo app",
  description: "Create and verify the requested todo app",
  status: "completed",
  assignedTo: "codex",
  completedAt: 5_000,
};
const unrelatedCompletedTask: UiTask = {
  id: "task-other",
  title: "Unrelated work",
  description: "Must not affect this Mission",
  status: "completed",
  completedAt: 14_000,
};
const completionEvents = [
  ...events,
  runtimeEvent("task-completed", 5, "task.completed", { missionId, taskId }),
  runtimeEvent("unrelated-completed", 15, "task.completed", { taskId: "task-other" }),
];

const projected = projectMissionActivity({
  missions: [laggingMission],
  tasks: [completedFastTask, unrelatedCompletedTask],
  events: completionEvents,
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 6_000);
assert.ok(projected, "the lagging fast-path Mission should remain visible");
assert.deepEqual(
  projected.taskIds,
  [taskId],
  "the visible Mission must recover only its own singular fast-path Task lineage",
);
assert.equal(
  projected.mission.status,
  "verifying",
  "completed recovered fast-path work must move Simple Mode out of stale Working state while Mission.taskIds still lags",
);
assert.equal(projected.missionState, "Verifying");
assert.ok(
  projected.feed.some((item) => item.includes("finished Build todo app")),
  "the completion transition should retain the worker-finished update that justifies Verifying",
);

console.log("mission-progress-lineage: ok — fast-path Task lineage keeps worker progress, heartbeat, and the pre-completion verifying state truthful while Mission task IDs lag");
