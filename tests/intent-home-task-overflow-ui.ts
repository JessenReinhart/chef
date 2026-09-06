import assert from "node:assert/strict";

import { partitionMissionTasksForSimpleMode } from "../web/src/missionTaskVisibility.ts";
import type { UiTask } from "../web/src/types.ts";

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

console.log("intent-home-task-overflow-ui: ok — bounded Simple Mode task visibility prioritizes actionable work over completed history");
