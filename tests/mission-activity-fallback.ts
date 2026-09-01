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

const planning = projectEmptyActivity("planning");
assert.equal(
  planning.missionState,
  "Planning",
  "a real planning Mission must not collapse into the generic Working state before execution begins",
);
assert.equal(
  planning.fallback,
  "Chef is deciding who and what this work needs.",
  "planning without newer runtime activity must still explain what Chef is doing",
);

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

const blockedBeforeRecovery: UiMission = {
  id: "mission-blocked-before-recovery",
  goal: "Create a simple todo app",
  status: "blocked",
  taskIds: ["task-blocked-before-recovery"],
  createdAt: 1_000,
  updatedAt: 1_500,
};
const completedRecovery: UiMission = {
  id: "mission-completed-recovery",
  goal: "Create a simple todo app",
  status: "completed",
  taskIds: ["task-completed-recovery"],
  createdAt: 2_000,
  updatedAt: 2_500,
};
const completedRecoveryTask: UiTask = {
  id: "task-completed-recovery",
  title: "Build the recovered todo app",
  description: "Create a runnable todo app after the earlier blocked attempt",
  status: "completed",
};
const recoveredProjection = projectMissionActivity(
  {
    missions: [blockedBeforeRecovery, completedRecovery],
    tasks: [completedRecoveryTask],
    events: [],
  },
  [],
  3_000,
);
assert.ok(recoveredProjection, "a completed recovery Mission must remain visible after an older blocked attempt");
assert.equal(
  recoveredProjection.mission.id,
  completedRecovery.id,
  "an older blocked Mission must not steal Simple Mode foreground/results from a newer completed recovery Mission",
);
assert.equal(
  recoveredProjection.missionState,
  "Done",
  "the latest completed recovery must expose completion instead of regressing to the older blocked state",
);
assert.equal(
  recoveredProjection.fallback,
  "Work is complete. Results are available in this workspace.",
  "the recovery handoff must direct the user to the completed Mission's results",
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
  convergingVerificationProjection.mission.status,
  "verifying",
  "the projected Mission object must agree with the visible Verifying state so downstream Simple Mode consumers cannot regress to Active",
);
assert.equal(
  convergingVerificationProjection.missionState,
  "Verifying",
  "an active Mission whose authoritative owned work is durably completed must project the real verification phase instead of stale Working",
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

const secondPendingTask: UiTask = {
  ...activeTask,
  id: "task-check",
  title: "Check the todo app",
  status: "pending",
};
const partiallyCompletedMission: UiMission = {
  ...activeMission,
  id: "mission-partially-complete",
  taskIds: [completedTask.id, secondPendingTask.id],
};
const partialActivity = completedActivity.map((event) => ({
  ...event,
  source: event.source.type === "mission" ? { ...event.source, id: partiallyCompletedMission.id } : event.source,
  payload: event.payload && typeof event.payload === "object"
    ? { ...(event.payload as Record<string, unknown>), missionId: partiallyCompletedMission.id }
    : event.payload,
  correlationId: partiallyCompletedMission.id,
}));
const partialProjection = projectMissionActivity(
  { missions: [partiallyCompletedMission], tasks: [completedTask, secondPendingTask], events: partialActivity },
  [],
  30_000,
);
assert.ok(partialProjection, "partial Mission progress should remain visible even before every task emits activity");
assert.equal(
  partialProjection.missionState,
  "Working",
  "one completed task must not imply verification while another authoritative Mission task is still pending and has emitted no event",
);
assert.equal(
  partialProjection.feed[0],
  "Chef is still working. Last runtime activity was 20 seconds ago.",
  "heartbeat wording must remain Working until every authoritative Mission task is durably completed",
);

const redirectedMission: UiMission = {
  ...activeMission,
  id: "mission-redirected",
  taskIds: ["task-current"],
};
const obsoleteTask: UiTask = {
  ...activeTask,
  id: "task-obsolete",
  title: "Build the obsolete approach",
  status: "cancelled",
};
const currentTask: UiTask = {
  ...activeTask,
  id: "task-current",
  title: "Build the redirected todo app",
  status: "running",
};
const redirectedActivity: UiRuntimeEvent[] = [
  {
    id: "evt-current-task-running",
    seq: 20,
    timestamp: 28_000,
    source: { type: "task", id: currentTask.id },
    type: "task.running",
    payload: { missionId: redirectedMission.id, taskId: currentTask.id },
    taskId: currentTask.id,
    correlationId: redirectedMission.id,
  },
  {
    id: "evt-obsolete-task-finished-late",
    seq: 21,
    timestamp: 29_000,
    source: { type: "task", id: obsoleteTask.id },
    type: "task.completed",
    payload: { missionId: redirectedMission.id, taskId: obsoleteTask.id },
    taskId: obsoleteTask.id,
    correlationId: redirectedMission.id,
  },
];
const redirectedProjection = projectMissionActivity(
  { missions: [redirectedMission], tasks: [obsoleteTask, currentTask], events: redirectedActivity },
  [],
  30_000,
);
assert.ok(redirectedProjection, "a redirected Mission should keep showing its current attempt");
assert.deepEqual(
  redirectedProjection.taskIds,
  [currentTask.id],
  "once a Mission has authoritative taskIds, obsolete task ids from older correlated attempts must not be re-owned",
);
assert.deepEqual(
  redirectedProjection.workers.map((worker) => worker.id),
  [currentTask.id],
  "Simple Mode must not show workers from the superseded attempt after redirect/replan",
);
assert.ok(
  redirectedProjection.feed.includes("Chef started Build the redirected todo app."),
  "current-attempt worker activity must remain visible after redirect/replan",
);
assert.equal(
  redirectedProjection.feed.some((line) => line.includes("obsolete approach")),
  false,
  "a late event from a superseded task must not overwrite the current Mission activity feed",
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

console.log("mission-activity-fallback: ok — planning, attention, recovery result continuity, current-attempt continuity, authoritative verification evidence, and stale-silence heartbeat states remain explicit and stage-consistent in Simple Mode");