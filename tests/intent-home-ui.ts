import { strict as assert } from "node:assert";
import {
  nextWorkspaceDepth,
  readWorkspaceDepth,
  workspaceSurfacePlan,
} from "../web/src/canonicalWorkspaceModel.ts";
import { projectMissionActivity } from "../web/src/missionActivityProjection.ts";
import type { HarnessInfo, UiMission, UiRuntimeEvent, UiTask } from "../web/src/types.ts";

assert.equal(readWorkspaceDepth(null), "simple", "a fresh session should open the canonical Living Workspace");
assert.equal(readWorkspaceDepth("simple"), "simple");
assert.equal(readWorkspaceDepth("power"), "power");
assert.equal(nextWorkspaceDepth("simple"), "power");
assert.equal(nextWorkspaceDepth("power"), "simple");

const simple = workspaceSurfacePlan("simple");
assert.deepEqual(simple, {
  projectContext: true,
  livingWorkspace: true,
  missionActivity: true,
  livingArtifacts: true,
  runtimeApp: false,
  contextScopes: false,
  canvasDeletion: false,
  decisions: false,
  missionArtifacts: false,
  rooms: false,
  agentContext: false,
}, "normal use should mount one project-grounded Living Workspace without hidden runtime surfaces");

const power = workspaceSurfacePlan("power");
assert.equal(power.livingWorkspace, false, "runtime detail must replace rather than duplicate the streaming Living Workspace");
assert.equal(power.runtimeApp, true, "runtime detail should remain reachable");
assert.equal(power.rooms, true, "Rooms remain available at advanced depth");
assert.equal(power.agentContext, true, "agent context remains available at advanced depth");

const mission: UiMission = {
  id: "mission-1",
  goal: "Create a todo app",
  status: "active",
  taskIds: ["task-1"],
  metadata: {},
  createdAt: 100,
  updatedAt: 120,
};
const task: UiTask = {
  id: "task-1",
  title: "Build the app",
  description: "Implement the requested todo app",
  status: "running",
  assignedTo: "claude-code",
};
const events: UiRuntimeEvent[] = [
  {
    id: "event-1",
    seq: 1,
    timestamp: 105,
    source: { type: "orchestrator", id: "orchestrator" },
    type: "orchestrator.plan.started",
    payload: { missionId: "mission-1" },
    correlationId: "mission-1",
  },
  {
    id: "event-2",
    seq: 2,
    timestamp: 108,
    source: { type: "orchestrator", id: "orchestrator" },
    type: "orchestrator.plan.proposed",
    payload: { missionId: "mission-1", routingMode: "single-worker", taskIds: ["task-1"] },
    correlationId: "mission-1",
  },
  {
    id: "event-3",
    seq: 3,
    timestamp: 110,
    source: { type: "task", id: "task-1" },
    type: "task.running",
    payload: {},
    taskId: "task-1",
  },
  {
    id: "event-4",
    seq: 4,
    timestamp: 120,
    source: { type: "session", id: "session-1" },
    type: "session.data",
    payload: { data: "raw terminal output that should not be rendered directly" },
    taskId: "task-1",
  },
];
const harnesses: HarnessInfo[] = [
  { id: "claude-code", name: "Claude Code", type: "specialized", available: true },
];

const activity = projectMissionActivity({ missions: [mission], tasks: [task], events }, harnesses, 120);
assert.ok(activity, "an active Mission should have a visible activity projection");
assert.equal(activity.mission.goal, "Create a todo app");
assert.equal(activity.missionState, "Working");
assert.deepEqual(activity.workers.map((worker) => [worker.name, worker.title, worker.state]), [
  ["Claude Code", "Build the app", "Working"],
]);
assert.deepEqual(activity.feed, [
  "A worker is actively producing output.",
  "Claude Code started Build the app.",
  "Chef chose one worker for this Mission.",
], "activity should preserve meaningful routing and worker progress in recent-first order");
assert.equal(activity.feed.some((line) => line.includes("raw terminal output")), false, "normal activity must not expose raw CLI output");

const planningMission: UiMission = {
  ...mission,
  id: "mission-planning",
  status: "planning",
  taskIds: [],
  createdAt: 200,
  updatedAt: 200,
};
const planningEvents: UiRuntimeEvent[] = [{
  id: "event-planning",
  seq: 5,
  timestamp: 200,
  source: { type: "orchestrator", id: "orchestrator" },
  type: "orchestrator.plan.started",
  payload: { missionId: "mission-planning" },
  correlationId: "mission-planning",
}];
const planningActivity = projectMissionActivity({
  missions: [planningMission],
  tasks: [],
  events: planningEvents,
}, harnesses, 200);
assert.ok(planningActivity, "pre-worker planning should still have visible Mission activity");
assert.deepEqual(planningActivity.feed, [
  "Chef is deciding how to approach this Mission.",
], "Mission-correlated planning must be visible before any Task or Session exists");

const slowPlanningActivity = projectMissionActivity({
  missions: [planningMission],
  tasks: [],
  events: planningEvents,
}, harnesses, 10_500);
assert.ok(slowPlanningActivity, "slow planning should keep the Living Workspace visibly alive");
assert.equal(
  slowPlanningActivity.feed[0],
  "Chef is still planning. Last runtime activity was 10 seconds ago.",
  "the canonical workspace should surface the durable Mission heartbeat after ten seconds of silence",
);
assert.equal(
  slowPlanningActivity.feed[1],
  "Chef is deciding how to approach this Mission.",
  "heartbeat feedback should supplement rather than replace the last meaningful runtime event",
);

const completedPlanningActivity = projectMissionActivity({
  missions: [{ ...planningMission, status: "completed", updatedAt: 10_500 }],
  tasks: [],
  events: planningEvents,
}, harnesses, 10_500);
assert.ok(completedPlanningActivity, "completed Missions should remain projectable from durable history");
assert.equal(
  completedPlanningActivity.feed.some((line) => line.startsWith("Chef is still")),
  false,
  "stale planning history must not produce a heartbeat after the authoritative Mission has terminated",
);

const startupMission: UiMission = {
  ...mission,
  id: "mission-startup",
  taskIds: [],
  createdAt: 300,
  updatedAt: 305,
};
const startupActivity = projectMissionActivity({
  missions: [startupMission],
  tasks: [task],
  events: [
    {
      id: "event-startup-plan",
      seq: 6,
      timestamp: 300,
      source: { type: "orchestrator", id: "orchestrator" },
      type: "orchestrator.plan.proposed",
      payload: { missionId: "mission-startup", routingMode: "single-worker", taskIds: ["task-1"] },
      correlationId: "mission-startup",
    },
    {
      id: "event-startup-worker",
      seq: 7,
      timestamp: 305,
      source: { type: "task", id: "task-1" },
      type: "task.running",
      payload: {},
      taskId: "task-1",
    },
  ],
}, harnesses, 305);
assert.ok(startupActivity, "startup activity should recover durable Task ownership from the Mission plan");
assert.deepEqual(startupActivity.workers.map((worker) => [worker.name, worker.title, worker.state]), [
  ["Claude Code", "Build the app", "Working"],
], "the worker list should not disappear while the Mission snapshot catches up to its durable plan");
assert.deepEqual(startupActivity.feed, [
  "Claude Code started Build the app.",
  "Chef chose one worker for this Mission.",
]);

console.log("intent-home-ui: ok — canonical workspace and Mission activity are verified by executable behavior, not source shape");
