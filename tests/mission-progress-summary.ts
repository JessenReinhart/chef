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

const approval = summarizeMissionProgressEvent(event("approval", "approval.requested", { reason: "Push branch" }, 2));
assert.equal(approval?.text, "Approval needed: Push branch");
assert.equal(approval?.tone, "attention");

const completed = summarizeMissionProgressEvent(event("done", "mission.status", { status: "completed" }, 3));
assert.equal(completed?.text, "Mission completed.");
assert.equal(completed?.tone, "success");

const timeout = summarizeMissionProgressEvent(event("timeout", "mission.timeout", { missionId: "mission-1", timeoutMs: 10_000 }, 4));
assert.equal(timeout?.text, "Mission timed out after 10 seconds.");
assert.equal(timeout?.tone, "attention");

assert.equal(summarizeMissionProgressEvent(event("noise", "session.data", { text: "raw output" }, 5)), null);

const digest = summarizeMissionProgress([
  event("start", "mission.created", { goal: "Ship report" }, 1),
  event("noise", "session.data", { text: "raw output" }, 2),
  event("execute", "orchestrator.plan.executing", { taskIds: ["a", "b"] }, 3),
  event("approval", "approval.requested", {}, 4),
  event("done", "mission.status", { status: "completed" }, 5),
], 3);
assert.deepEqual(digest.map((item) => item.id), ["execute", "approval", "done"]);
assert.ok(digest.every((item) => !item.text.includes("session.data")));

const orchestratorScoped = [
  event("active", "mission.status", { missionId: "mission-1", status: "active" }, 1_000),
  event("plan", "orchestrator.plan.proposed", { planId: "plan-1", taskIds: ["task-1"] }, 2_000),
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
assert.ok(
  !missionDigest.some((item) => item.id === "other"),
  "payload lineage must not leak updates from another Mission",
);

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

console.log("mission-progress-summary: ok — durable Mission progress surfaces timeouts without false heartbeats");
