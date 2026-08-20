import { strict as assert } from "node:assert";
import { summarizeMissionProgress, summarizeMissionProgressEvent } from "../web/src/missionProgress.ts";
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

assert.equal(summarizeMissionProgressEvent(event("noise", "session.data", { text: "raw output" }, 4)), null);

const digest = summarizeMissionProgress([
  event("start", "mission.created", { goal: "Ship report" }, 1),
  event("noise", "session.data", { text: "raw output" }, 2),
  event("execute", "orchestrator.plan.executing", { taskIds: ["a", "b"] }, 3),
  event("approval", "approval.requested", {}, 4),
  event("done", "mission.status", { status: "completed" }, 5),
], 3);
assert.deepEqual(digest.map((item) => item.id), ["execute", "approval", "done"]);
assert.ok(digest.every((item) => !item.text.includes("session.data")));

console.log("mission-progress-summary: ok — meaningful Mission events become a bounded human digest");
