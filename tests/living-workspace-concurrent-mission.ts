import { strict as assert } from "node:assert";
import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
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

const historyOnly = projectMissionActivity({
  missions: [
    { ...ongoing, status: "completed", completedAt: 300 },
    newerCompleted,
  ],
  tasks: [],
  events: [],
}, []);

assert.ok(historyOnly);
assert.equal(historyOnly.mission.id, newerCompleted.id, "when no work remains active, the newest completed Mission should be the visible history item");

console.log("living-workspace-concurrent-mission: ok — active work cannot be hidden by newer terminal history");
