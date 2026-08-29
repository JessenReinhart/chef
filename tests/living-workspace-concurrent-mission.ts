import { strict as assert } from "node:assert";
import { projectMissionActivity, selectLivingWorkspaceMission } from "../web/src/missionActivityProjection.ts";
import type { UiMission, UiRuntimeEvent, UiTask } from "../web/src/types.ts";

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
assert.equal(
  selectLivingWorkspaceMission([ongoing, newerCompleted])?.id,
  ongoing.id,
  "all Simple Mode surfaces, including current results, must select the same ongoing Mission instead of newer terminal history",
);

const completedOngoing = { ...ongoing, status: "completed" as const, completedAt: 300 };
const historyOnly = projectMissionActivity({
  missions: [completedOngoing, newerCompleted],
  tasks: [],
  events: [],
}, []);

assert.ok(historyOnly);
assert.equal(historyOnly.mission.id, newerCompleted.id, "when no work remains active, the newest completed Mission should be the visible history item");
assert.equal(
  selectLivingWorkspaceMission([completedOngoing, newerCompleted])?.id,
  newerCompleted.id,
  "result selection should fall back to the same newest terminal Mission when no ongoing work remains",
);

const recoveryMission: UiMission = {
  id: "mission-recovery",
  goal: "Create a todo app",
  status: "active",
  taskIds: ["task-build"],
  metadata: {},
  createdAt: 400,
  updatedAt: 500,
};
const buildTask: UiTask = {
  id: "task-build",
  title: "Build the todo app",
  description: "Create the requested app",
  status: "failed",
  assignedTo: "codex",
};
const failedEvent: UiRuntimeEvent = {
  id: "event-failed",
  seq: 1,
  timestamp: 1_000,
  source: { type: "runtime", id: "task-machine" },
  type: "task.failed",
  payload: { error: "worker exited with code 1" },
  taskId: buildTask.id,
};

const failedProjection = projectMissionActivity({
  missions: [recoveryMission],
  tasks: [buildTask],
  events: [failedEvent],
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 1_000);
assert.ok(failedProjection);
assert.equal(
  failedProjection.feed[0],
  "Codex failed Build the todo app: worker exited with code 1",
  "Simple Mode must preserve the durable failure reason instead of collapsing worker failure into a generic attention state",
);

const noisyFailureProjection = projectMissionActivity({
  missions: [recoveryMission],
  tasks: [buildTask],
  events: [{
    ...failedEvent,
    id: "event-noisy-failure",
    payload: { error: "\u001b[31mENOENT\u001b[0m: package.json missing\n    at spawnWorker (runtime/worker.ts:42:7)\n    at async runTask (runtime/task.ts:88:3)" },
  }],
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 1_000);
assert.ok(noisyFailureProjection);
assert.equal(
  noisyFailureProjection.feed[0],
  "Codex failed Build the todo app: ENOENT: package.json missing",
  "Simple Mode must keep the concrete failure reason while excluding ANSI noise and stack-trace detail from the normal-user surface",
);

const terminalPreludeProjection = projectMissionActivity({
  missions: [recoveryMission],
  tasks: [buildTask],
  events: [{
    ...failedEvent,
    id: "event-terminal-prelude",
    payload: { error: "\u001b[31m\u001b[0m\nENOENT: package.json missing\n    at spawnWorker (runtime/worker.ts:42:7)" },
  }],
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 1_000);
assert.ok(terminalPreludeProjection);
assert.equal(
  terminalPreludeProjection.feed[0],
  "Codex failed Build the todo app: ENOENT: package.json missing",
  "terminal-only lines must be discarded after ANSI cleanup so the next real failure reason remains visible",
);

const retryEvent: UiRuntimeEvent = {
  id: "event-retry",
  seq: 2,
  timestamp: 2_000,
  source: { type: "runtime", id: "task-machine" },
  type: "task.running",
  payload: { retryCount: 1 },
  taskId: buildTask.id,
};
const retryingTask: UiTask = { ...buildTask, status: "running" };
const retryProjection = projectMissionActivity({
  missions: [recoveryMission],
  tasks: [retryingTask],
  events: [failedEvent, retryEvent],
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 2_000);
assert.ok(retryProjection);
assert.deepEqual(
  retryProjection.feed.slice(0, 2),
  [
    "Codex is retrying Build the todo app (retry 1).",
    "Codex failed Build the todo app: worker exited with code 1",
  ],
  "a real retry must visibly replace the frozen failure state while retaining the recovery sequence",
);

const unexplainedFailureProjection = projectMissionActivity({
  missions: [recoveryMission],
  tasks: [buildTask],
  events: [{ ...failedEvent, payload: {} }],
}, [{ id: "codex", name: "Codex", type: "cli", available: true }], 1_000);
assert.ok(unexplainedFailureProjection);
assert.equal(
  unexplainedFailureProjection.feed[0],
  "Codex failed Build the todo app and needs recovery.",
  "failure without a durable error must stay truthful without inventing a reason",
);

console.log("living-workspace-concurrent-mission: ok — Mission selection and visible failure-to-retry recovery stay truthful and bounded in Simple Mode");
