import assert from "node:assert/strict";

import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import { partitionMissionTasksForSimpleMode } from "../web/src/missionTaskVisibility.ts";
import type { UiMission, UiTask } from "../web/src/types.ts";

function task(id: string, status: UiTask["status"]): UiTask {
  return { id, title: id, description: id, status };
}

const actionableEarly = partitionMissionTasksForSimpleMode([
  task("failed-early", "failed"),
  task("done-1", "completed"),
  task("done-2", "completed"),
  task("done-3", "completed"),
  task("done-4", "completed"),
  task("done-5", "completed"),
  task("done-6", "completed"),
]);
assert.equal(actionableEarly.visible.length, 6, "Simple Mode must keep the current-Mission step budget bounded");
assert.ok(
  actionableEarly.visible.some(({ id }) => id === "failed-early"),
  "an early failed step must stay immediately visible instead of being hidden behind completed history",
);
assert.deepEqual(
  actionableEarly.earlier.map(({ id }) => id),
  ["done-1"],
  "completed history should absorb overflow before actionable work",
);

const cancelledEarly = partitionMissionTasksForSimpleMode([
  task("cancelled-early", "cancelled"),
  task("queued-1", "pending"),
  task("queued-2", "pending"),
  task("queued-3", "pending"),
  task("queued-4", "pending"),
  task("queued-5", "pending"),
  task("queued-6", "pending"),
]);
assert.ok(
  cancelledEarly.visible.some(({ id }) => id === "cancelled-early"),
  "a cancelled current-Mission step must remain visible instead of being displaced by queued work",
);
assert.deepEqual(
  cancelledEarly.earlier.map(({ id }) => id),
  ["queued-1"],
  "queued work should absorb overflow before a stopped step that needs user attention",
);

const workerOverflowTasks = [
  task("cancelled-worker", "cancelled"),
  task("queued-worker-1", "pending"),
  task("queued-worker-2", "pending"),
  task("queued-worker-3", "pending"),
  task("queued-worker-4", "pending"),
];
const workerOverflowMission: UiMission = {
  id: "mission-worker-overflow",
  goal: "Create a simple todo app",
  status: "active",
  taskIds: workerOverflowTasks.map(({ id }) => id),
  createdAt: 1_000,
  updatedAt: 1_000,
};
const workerOverflow = projectMissionActivity(
  { missions: [workerOverflowMission], tasks: workerOverflowTasks, events: [] },
  [],
  2_000,
);
assert.ok(workerOverflow, "the current Mission worker projection must remain available during overflow");
assert.deepEqual(
  workerOverflow.workers.map(({ id }) => id),
  ["cancelled-worker", "queued-worker-1", "queued-worker-2", "queued-worker-3"],
  "a stopped worker must survive the four-worker Simple Mode budget ahead of queued work",
);
assert.equal(
  workerOverflow.workers[0]?.state,
  "Stopped",
  "the retained cancelled worker must truthfully explain that work stopped rather than looking queued",
);

const mixedLive = partitionMissionTasksForSimpleMode([
  task("running-early", "running"),
  task("blocked-early", "blocked"),
  task("done-old", "completed"),
  task("queued", "pending"),
  task("assigned", "assigned"),
  task("spawning", "spawning"),
  task("done-new", "completed"),
  task("done-newest", "completed"),
]);
assert.deepEqual(
  mixedLive.visible.map(({ id }) => id),
  ["running-early", "blocked-early", "queued", "assigned", "spawning", "done-newest"],
  "live, actionable, and queued steps must survive the six-row budget while visible rows remain in Mission order",
);
assert.deepEqual(
  mixedLive.earlier.map(({ id }) => id),
  ["done-old", "done-new"],
  "completed history should be progressively disclosed before current work is hidden",
);

const allCompleted = partitionMissionTasksForSimpleMode(
  Array.from({ length: 8 }, (_, index) => task(`done-${index + 1}`, "completed")),
);
assert.deepEqual(
  allCompleted.visible.map(({ id }) => id),
  ["done-3", "done-4", "done-5", "done-6", "done-7", "done-8"],
  "when everything is historical, Simple Mode should retain the most recent six steps",
);
assert.deepEqual(
  allCompleted.earlier.map(({ id }) => id),
  ["done-1", "done-2"],
  "older completed steps must remain available through progressive disclosure",
);

console.log("intent-home-task-overflow-ui: ok — bounded Simple Mode task and worker visibility prioritizes actionable work over queued/history overflow");
