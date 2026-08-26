import { strict as assert } from "node:assert";
import {
  deriveMissionHeartbeat,
  summarizeMissionProgress,
  summarizeMissionProgressEvent,
  summarizeMissionProgressForMission,
} from "../web/src/missionProgress.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const event = (id: string, type: string, payload: unknown, timestamp: number): UiRuntimeEvent => ({
  id,
  seq: timestamp,
  timestamp,
  source: { type: "runtime", id: "test" },
  type,
  payload,
});

const planned = summarizeMissionProgressEvent(event("plan", "orchestrator.plan.proposed", { taskIds: ["a", "b"] }, 1));
assert.equal(planned?.text, "Chef prepared a plan with 2 steps.");
assert.equal(planned?.tone, "active");

const singleWorkerPlan = summarizeMissionProgressEvent(event(
  "single-worker-plan",
  "orchestrator.plan.proposed",
  { taskIds: ["a"], routingMode: "single-worker" },
  2,
));
assert.equal(singleWorkerPlan?.text, "Chef chose one worker for this Mission.");
assert.equal(singleWorkerPlan?.tone, "active");

const coordinatedPlan = summarizeMissionProgressEvent(event(
  "coordinated-plan",
  "orchestrator.plan.proposed",
  { taskIds: ["a", "b", "c"], routingMode: "planner" },
  3,
));
assert.equal(coordinatedPlan?.text, "Chef chose a coordinated plan with 3 steps.");
assert.equal(coordinatedPlan?.tone, "active");

const approval = summarizeMissionProgressEvent(event("approval", "approval.requested", { reason: "Push branch" }, 4));
assert.equal(approval?.text, "Approval needed: Push branch");
assert.equal(approval?.tone, "attention");

const completed = summarizeMissionProgressEvent(event("done", "mission.status", { status: "completed" }, 5));
assert.equal(completed?.text, "Mission completed.");
assert.equal(completed?.tone, "success");

const timeout = summarizeMissionProgressEvent(event("timeout", "mission.timeout", { missionId: "mission-1", timeoutMs: 10_000 }, 6));
assert.equal(timeout?.text, "Mission timed out after 10 seconds.");
assert.equal(timeout?.tone, "attention");

const workerOutput = summarizeMissionProgressEvent(event("output", "session.data", { text: "raw terminal output" }, 7));
assert.equal(workerOutput?.text, "A worker is actively producing output.");
assert.equal(workerOutput?.tone, "active");
assert.ok(!workerOutput?.text.includes("raw terminal output"), "Simple Mode must not echo raw terminal output");

const digest = summarizeMissionProgress([
  event("start", "mission.created", { goal: "Ship report" }, 1),
  event("output", "session.data", { text: "raw terminal output" }, 2),
  event("execute", "orchestrator.plan.executing", { taskIds: ["a", "b"] }, 3),
  event("approval", "approval.requested", {}, 4),
  event("done", "mission.status", { status: "completed" }, 5),
], 3);
assert.deepEqual(digest.map((item) => item.id), ["execute", "approval", "done"]);
assert.ok(digest.every((item) => !item.text.includes("raw terminal output")));

const orchestratorScoped = [
  event("active", "mission.status", { missionId: "mission-1", status: "active" }, 1_000),
  event("plan", "orchestrator.plan.proposed", { planId: "plan-1", taskIds: ["task-1"], routingMode: "single-worker" }, 2_000),
  event("other", "mission.status", { missionId: "mission-2", status: "completed" }, 3_000),
];
const missionDigest = summarizeMissionProgressForMission(
  orchestratorScoped,
  "mission-1",
  ["task-1"],
  3,
  5_000,
);
assert.deepEqual(
  missionDigest.map((item) => item.id),
  ["plan", "active"],
  "orchestrator-emitted Mission status and plan updates must remain visible through durable payload lineage",
);
assert.equal(
  missionDigest[0]?.text,
  "Chef chose one worker for this Mission.",
  "the durable routing decision must become human-readable Simple Mode feedback",
);
assert.ok(
  !missionDigest.some((item) => item.id === "other"),
  "payload lineage must not leak updates from another Mission",
);

const scopedWorkerOutput: UiRuntimeEvent = {
  ...event("worker-output", "session.data", { text: "building files..." }, 2_500),
  taskId: "task-1",
};
const workerActivityDigest = summarizeMissionProgressForMission(
  [...orchestratorScoped.slice(0, 2), scopedWorkerOutput],
  "mission-1",
  ["task-1"],
  3,
  5_000,
);
assert.equal(workerActivityDigest[0]?.id, "worker-output", "real worker output activity must become visible in Simple Mode");
assert.equal(workerActivityDigest[0]?.text, "A worker is actively producing output.");
assert.ok(!workerActivityDigest[0]?.text.includes("building files"), "Mission progress must project activity without exposing terminal text");

const heartbeat = deriveMissionHeartbeat(
  orchestratorScoped.slice(0, 2),
  "mission-1",
  ["task-1"],
  13_000,
  10_000,
);
assert.equal(heartbeat?.text, "Chef is still working. Last runtime activity was 11 seconds ago.");
assert.equal(heartbeat?.tone, "active");

const timedOutScoped = [
  ...orchestratorScoped.slice(0, 2),
  event("timeout", "mission.timeout", { missionId: "mission-1", planId: "plan-1", timeoutMs: 10_000 }, 3_000),
];
const timeoutDigest = summarizeMissionProgressForMission(
  timedOutScoped,
  "mission-1",
  ["task-1"],
  3,
  20_000,
);
assert.equal(timeoutDigest[0]?.id, "timeout", "a Mission timeout must become the latest visible Simple Mode update");
assert.equal(timeoutDigest[0]?.tone, "attention");
assert.equal(
  deriveMissionHeartbeat(timedOutScoped, "mission-1", ["task-1"], 20_000, 10_000),
  null,
  "a timed-out Mission must not emit a false still-working heartbeat while terminal status catches up",
);

for (const blocker of [
  { id: "failed", type: "task.failed", payload: { error: "worker exited" } },
  { id: "blocked", type: "task.blocked", payload: { reason: "dependency unavailable" } },
  { id: "crashed", type: "session.crashed", payload: { reason: "pty closed" } },
]) {
  const blockerEvent: UiRuntimeEvent = {
    ...event(blocker.id, blocker.type, blocker.payload, 3_000),
    taskId: "task-1",
  };
  const blockedScoped = [...orchestratorScoped.slice(0, 2), blockerEvent];
  const blockedDigest = summarizeMissionProgressForMission(blockedScoped, "mission-1", ["task-1"], 3, 20_000);
  assert.equal(blockedDigest[0]?.id, blocker.id, `${blocker.type} must remain the latest visible Mission update`);
  assert.equal(blockedDigest[0]?.tone, "attention");
  assert.equal(
    deriveMissionHeartbeat(blockedScoped, "mission-1", ["task-1"], 20_000, 10_000),
    null,
    `${blocker.type} must suppress a false still-working heartbeat while Mission status is stale`,
  );
}

const failedThenRetried: UiRuntimeEvent[] = [
  ...orchestratorScoped.slice(0, 2),
  { ...event("failed", "task.failed", { error: "worker exited" }, 3_000), taskId: "task-1" },
  { ...event("retry", "task.running", { retryCount: 1 }, 4_000), taskId: "task-1" },
];
const retryHeartbeat = deriveMissionHeartbeat(failedThenRetried, "mission-1", ["task-1"], 15_000, 10_000);
assert.equal(
  retryHeartbeat?.text,
  "Chef is still working. Last runtime activity was 11 seconds ago.",
  "a durable retry after failure must resume truthful long-running feedback",
);

console.log("mission-progress-summary: ok — routing, worker activity, and recovery blockers produce truthful Simple Mode progress");
