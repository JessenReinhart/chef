import { strict as assert } from "node:assert";

import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { UiMission, UiRuntimeEvent, UiTask } from "../web/src/types.ts";

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

const activeMission: UiMission = {
  id: "mission-active-silent",
  goal: "Create a simple todo app",
  status: "active",
  taskIds: ["task-build"],
  createdAt: 1_000,
  updatedAt: 10_000,
};
const activeTask: UiTask = {
  id: "task-build",
  title: "Build the todo app",
  description: "Create the runnable todo app",
  status: "running",
};
const olderActivity: UiRuntimeEvent[] = [
  {
    id: "evt-plan-started",
    seq: 1,
    timestamp: 8_000,
    source: { type: "mission", id: activeMission.id },
    type: "orchestrator.plan.started",
    payload: { missionId: activeMission.id },
    correlationId: activeMission.id,
  },
  {
    id: "evt-plan-proposed",
    seq: 2,
    timestamp: 9_000,
    source: { type: "mission", id: activeMission.id },
    type: "orchestrator.plan.proposed",
    payload: { missionId: activeMission.id, routingMode: "single-worker", taskIds: [activeTask.id] },
    correlationId: activeMission.id,
  },
  {
    id: "evt-task-running",
    seq: 3,
    timestamp: 10_000,
    source: { type: "task", id: activeTask.id },
    type: "task.running",
    payload: { missionId: activeMission.id, taskId: activeTask.id },
    taskId: activeTask.id,
    correlationId: activeMission.id,
  },
];

const silentProjection = projectMissionActivity(
  { missions: [activeMission], tasks: [activeTask], events: olderActivity },
  [],
  30_000,
);
assert.ok(silentProjection, "an active Mission with runtime history should remain visible");
assert.equal(
  silentProjection.feed[0],
  "Chef is still working. Last runtime activity was 20 seconds ago.",
  "a stale active Mission must surface the heartbeat even when older activity already fills the feed",
);
assert.equal(
  silentProjection.feed.length,
  3,
  "heartbeat priority must keep the Simple Mode feed bounded while preserving recent concrete activity",
);
assert.ok(
  silentProjection.feed.includes("Chef started Build the todo app."),
  "promoting the heartbeat must still retain the newest concrete worker update",
);

const completedTask: UiTask = {
  ...activeTask,
  status: "completed",
};
const completedActivity: UiRuntimeEvent[] = [
  ...olderActivity,
  {
    id: "evt-mission-active",
    seq: 4,
    timestamp: 10_000,
    source: { type: "mission", id: activeMission.id },
    type: "mission.status",
    payload: { missionId: activeMission.id, status: "active" },
    correlationId: activeMission.id,
  },
  {
    id: "evt-task-completed",
    seq: 5,
    timestamp: 10_000,
    source: { type: "task", id: completedTask.id },
    type: "task.completed",
    payload: { missionId: activeMission.id, taskId: completedTask.id, resultSummary: "Todo app created" },
    taskId: completedTask.id,
    correlationId: activeMission.id,
  },
];
const convergingVerificationProjection = projectMissionActivity(
  { missions: [activeMission], tasks: [completedTask], events: completedActivity },
  [],
  30_000,
);
assert.ok(convergingVerificationProjection, "completed task evidence should remain visible while Mission status catches up");
assert.equal(
  convergingVerificationProjection.missionState,
  "Verifying",
  "an active Mission whose owned work is durably completed must project the real verification phase instead of stale Working",
);
assert.equal(
  convergingVerificationProjection.fallback,
  "Chef is verifying the completed work.",
  "the fallback must agree with durable completed-task verification evidence while Mission status converges",
);
assert.equal(
  convergingVerificationProjection.feed[0],
  "Chef is still verifying. Last runtime activity was 20 seconds ago.",
  "a stale-silence heartbeat must preserve inferred verification rather than rewriting it back to Working",
);

const verifyingMission: UiMission = {
  ...activeMission,
  id: "mission-verifying-silent",
  status: "verifying",
  taskIds: ["task-verify"],
};
const verifyingTask: UiTask = {
  ...activeTask,
  id: "task-verify",
  title: "Verify the todo app",
};
const staleWorkerActivity: UiRuntimeEvent[] = [
  {
    id: "evt-verifying-task-running",
    seq: 1,
    timestamp: 10_000,
    source: { type: "task", id: verifyingTask.id },
    type: "task.running",
    payload: { missionId: verifyingMission.id, taskId: verifyingTask.id },
    taskId: verifyingTask.id,
    correlationId: verifyingMission.id,
  },
];
const verifyingSilentProjection = projectMissionActivity(
  { missions: [verifyingMission], tasks: [verifyingTask], events: staleWorkerActivity },
  [],
  30_000,
);
assert.ok(verifyingSilentProjection, "a verifying Mission with stale worker activity should remain visible");
assert.equal(
  verifyingSilentProjection.missionState,
  "Verifying",
  "the prominent Mission state must reflect the current Mission snapshot",
);
assert.equal(
  verifyingSilentProjection.feed[0],
  "Chef is still verifying. Last runtime activity was 20 seconds ago.",
  "the promoted heartbeat must agree with the authoritative current Mission stage even when older events only imply working",
);

console.log("mission-activity-fallback: ok — attention, durable verification evidence, and stale-silence heartbeat states remain explicit and stage-consistent in Simple Mode");
