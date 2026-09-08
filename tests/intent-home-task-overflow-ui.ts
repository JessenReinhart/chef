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

const liveWithStoppedOverflow = partitionMissionTasksForSimpleMode([
  task("running-now", "running"),
  task("cancelled-1", "cancelled"),
  task("cancelled-2", "cancelled"),
  task("cancelled-3", "cancelled"),
  task("cancelled-4", "cancelled"),
  task("cancelled-5", "cancelled"),
  task("cancelled-6", "cancelled"),
  task("queued-after-stop", "pending"),
]);
assert.ok(
  liveWithStoppedOverflow.visible.some(({ id }) => id === "running-now"),
  "stopped history must not crowd genuinely active work out of the bounded step list",
);
assert.equal(
  liveWithStoppedOverflow.visible.filter(({ status }) => status === "cancelled").length,
  5,
  "the step budget should retain as much stopped work as possible after preserving live work",
);
assert.ok(
  liveWithStoppedOverflow.earlier.some(({ id }) => id === "queued-after-stop"),
  "queued work should yield before stopped recovery context when the step budget is full",
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

const liveWorkerOverflowTasks = [
  task("running-worker", "running"),
  task("cancelled-worker-1", "cancelled"),
  task("cancelled-worker-2", "cancelled"),
  task("cancelled-worker-3", "cancelled"),
  task("cancelled-worker-4", "cancelled"),
  task("queued-worker-after-stop", "pending"),
];
const liveWorkerOverflowMission: UiMission = {
  ...workerOverflowMission,
  id: "mission-live-worker-overflow",
  taskIds: liveWorkerOverflowTasks.map(({ id }) => id),
};
const liveWorkerOverflow = projectMissionActivity(
  { missions: [liveWorkerOverflowMission], tasks: liveWorkerOverflowTasks, events: [] },
  [],
  2_000,
);
assert.ok(liveWorkerOverflow, "live work must stay observable alongside stopped overflow");
assert.ok(
  liveWorkerOverflow.workers.some(({ id }) => id === "running-worker"),
  "cancelled workers must not crowd the genuinely running worker out of the four-worker strip",
);
assert.equal(
  liveWorkerOverflow.workers.filter(({ status }) => status === "cancelled").length,
  3,
  "the worker strip should retain stopped recovery context after reserving space for live work",
);
assert.equal(
  liveWorkerOverflow.workers.some(({ id }) => id === "queued-worker-after-stop"),
  false,
  "queued worker state should yield before stopped recovery context when the strip is full",
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

console.log("intent-home-task-overflow-ui: ok — bounded Simple Mode task and worker visibility prioritizes live/recovery work over queued/history overflow");
