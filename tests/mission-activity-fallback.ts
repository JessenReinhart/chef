import { strict as assert } from "node:assert";

import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { UiMission } from "../web/src/types.ts";

function projectFallback(status: UiMission["status"]): string {
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
  return projection.fallback;
}

assert.equal(
  projectFallback("waiting_for_approval"),
  "Chef needs your approval before work can continue.",
  "approval waits must tell normal users what action is required",
);
assert.equal(
  projectFallback("blocked"),
  "Work is blocked. Chef is waiting for a dependency or recovery action before it can continue.",
  "blocked work must not pretend a useful latest update exists",
);
assert.equal(
  projectFallback("failed"),
  "Work failed before a useful recovery update was available.",
  "failed work without runtime detail must stay truthful about the missing recovery evidence",
);

console.log("mission-activity-fallback: ok — no-event attention states remain distinct and actionable in Simple Mode");
