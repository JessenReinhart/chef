import { strict as assert } from "node:assert";

import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { UiMission, UiTask } from "../web/src/types.ts";

function task(id: string, status: UiTask["status"]): UiTask {
  return {
    id,
    title: `Task ${id}`,
    description: `Exercise ${id}`,
    status,
  };
}

function project(statuses: UiTask["status"][]) {
  const tasks = statuses.map((status, index) => task(`task-${index + 1}`, status));
  const mission: UiMission = {
    id: "mission-parallel-cancellation",
    goal: "Create a simple todo app",
    status: "active",
    taskIds: tasks.map((item) => item.id),
    createdAt: 1_000,
    updatedAt: 2_000,
  };
  const projection = projectMissionActivity({ missions: [mission], tasks, events: [] }, [], 30_000);
  assert.ok(projection, "parallel Mission should remain visible in Simple Mode");
  return projection;
}

const partiallyCancelled = project(["cancelled", "running"]);
assert.equal(
  partiallyCancelled.mission.status,
  "active",
  "cancelling one branch must not project the whole Mission as cancelled while sibling work is still running",
);
assert.equal(
  partiallyCancelled.missionState,
  "Working",
  "Simple Mode must keep the Mission visibly working while a surviving branch continues",
);
assert.equal(
  partiallyCancelled.workers.find((worker) => worker.id === "task-2")?.state,
  "Working",
  "the surviving running worker must remain visible after a sibling cancellation",
);
assert.equal(
  partiallyCancelled.workers.find((worker) => worker.id === "task-1")?.state,
  "Stopped",
  "the cancelled branch itself should remain truthfully stopped",
);

for (const liveStatus of ["pending", "assigned", "spawning"] as const) {
  const projection = project(["cancelled", liveStatus]);
  assert.equal(
    projection.mission.status,
    "active",
    `cancelled + ${liveStatus} must keep the Mission active while owned work remains nonterminal`,
  );
}

const terminalCancellation = project(["cancelled", "completed"]);
assert.equal(
  terminalCancellation.mission.status,
  "cancelled",
  "once all owned work is terminal, any cancelled branch should keep terminal cancellation truthful",
);
assert.equal(terminalCancellation.missionState, "Stopped");

const allCompleted = project(["completed", "completed"]);
assert.equal(
  allCompleted.mission.status,
  "verifying",
  "all-completed owned work must still converge into verification",
);

const failedSibling = project(["cancelled", "failed", "running"]);
assert.equal(
  failedSibling.mission.status,
  "failed",
  "failed work must retain attention precedence over partial cancellation and surviving activity",
);

const blockedSibling = project(["cancelled", "blocked", "running"]);
assert.equal(
  blockedSibling.mission.status,
  "blocked",
  "blocked work must retain attention precedence over partial cancellation and surviving activity",
);

console.log("mission parallel cancellation behavior: OK");
