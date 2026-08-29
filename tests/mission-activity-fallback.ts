import { strict as assert } from "node:assert";

import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { UiMission } from "../web/src/types.ts";

function projectEmptyActivity(status: UiMission["status"]) {
  const mission: UiMission = {
    id: `mission-${status}`,
    goal: "Create a simple todo app",
    status,
    taskIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
  const projection = projectMissionActivity({ missions: [mission], tasks: [], events: [] }, []);
  assert.ok(projection, `${status} Mission should remain visible in Simple Mode`);
  assert.deepEqual(projection.feed, [], `${status} fallback should be used only when no runtime activity is available`);
  return projection;
}

assert.equal(
  projectEmptyActivity("waiting_for_approval").fallback,
  "Chef needs your approval before work can continue.",
  "approval waits must tell normal users what action is required",
);
assert.equal(
  projectEmptyActivity("blocked").fallback,
  "Work is blocked. Chef is waiting for a dependency or recovery action before it can continue.",
  "blocked work must not pretend a useful latest update exists",
);
assert.equal(
  projectEmptyActivity("failed").fallback,
  "Work failed before a useful recovery update was available.",
  "failed work without runtime detail must stay truthful about the missing recovery evidence",
);

const verifying = projectEmptyActivity("verifying");
assert.equal(
  verifying.missionState,
  "Verifying",
  "verification must be a distinct prominent Simple Mode state instead of collapsing back into Working",
);
assert.equal(
  verifying.fallback,
  "Chef is verifying the completed work.",
  "verification with no newer runtime event must explain what Chef is doing",
);

console.log("mission-activity-fallback: ok — attention and verification states remain explicit in Simple Mode");
