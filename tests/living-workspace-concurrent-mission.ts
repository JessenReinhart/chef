import { strict as assert } from "node:assert";
import { projectMissionActivity, selectLivingWorkspaceMission } from "../web/src/missionActivityProjection.ts";
import type { UiMission } from "../web/src/types.ts";

const ongoing: UiMission = {
  id: "mission-ongoing",
  goal: "Create a todo app",
  status: "active",
  taskIds: [],
  metadata: {},
  createdAt: 100,
  updatedAt: 300,
};

const newerCompleted: UiMission = {
  id: "mission-completed",
  goal: "Explain the project",
  status: "completed",
  taskIds: [],
  metadata: {},
  createdAt: 200,
  updatedAt: 250,
  completedAt: 250,
};

const projection = projectMissionActivity({
  missions: [ongoing, newerCompleted],
  tasks: [],
  events: [],
}, []);

assert.ok(projection, "concurrent Mission history should remain projectable");
assert.equal(projection.mission.id, ongoing.id, "ongoing work must remain the primary Living Workspace Mission even when newer terminal history exists");
assert.equal(projection.missionState, "Working", "the workspace must not claim Done while another Mission is still running");
assert.equal(
  selectLivingWorkspaceMission([ongoing, newerCompleted])?.id,
  ongoing.id,
  "all Simple Mode surfaces, including current results, must select the same ongoing Mission instead of newer terminal history",
);

const completedOngoing = { ...ongoing, status: "completed" as const, completedAt: 300 };
const historyOnly = projectMissionActivity({
  missions: [completedOngoing, newerCompleted],
  tasks: [],
  events: [],
}, []);

assert.ok(historyOnly);
assert.equal(historyOnly.mission.id, newerCompleted.id, "when no work remains active, the newest completed Mission should be the visible history item");
assert.equal(
  selectLivingWorkspaceMission([completedOngoing, newerCompleted])?.id,
  newerCompleted.id,
  "result selection should fall back to the same newest terminal Mission when no ongoing work remains",
);

console.log("living-workspace-concurrent-mission: ok — activity and result surfaces share one Mission selection contract so active work cannot be hidden by newer terminal history");
