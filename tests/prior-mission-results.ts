import { strict as assert } from "node:assert";
import { priorMissionResults } from "../web/src/priorMissionResults.ts";
import type { ChatMessage, UiMission } from "../web/src/types.ts";

const missions: UiMission[] = [
  { id: "current", goal: "Current", status: "active", taskIds: [], metadata: { threadId: "thread-a" }, createdAt: 30, updatedAt: 30 },
  { id: "prior-a", goal: "Prior A", status: "completed", taskIds: [], metadata: { threadId: "thread-a" }, createdAt: 20, updatedAt: 20 },
  { id: "prior-b", goal: "Prior B", status: "completed", taskIds: [], metadata: { threadId: "thread-a" }, createdAt: 10, updatedAt: 10 },
  { id: "sibling", goal: "Sibling", status: "completed", taskIds: [], metadata: { threadId: "thread-b" }, createdAt: 25, updatedAt: 25 },
];

const messages: ChatMessage[] = [
  { role: "assistant", content: "wrong sibling result", timestamp: 1, metadata: { missionId: "sibling" } },
  { role: "assistant", content: "old prior result", timestamp: 2, metadata: { missionId: "prior-a" } },
  { role: "assistant", content: "latest prior result", timestamp: 3, metadata: { missionId: "prior-a" } },
  { role: "assistant", content: "second prior result", timestamp: 4, metadata: { missionId: "prior-b" } },
  { role: "assistant", content: "current result", timestamp: 5, metadata: { missionId: "current" } },
  { role: "assistant", content: "unscoped result", timestamp: 6 },
];

const results = priorMissionResults(missions, messages, "thread-a");
assert.deepEqual(results.map((entry) => entry.mission.id), ["prior-a", "prior-b"]);
assert.equal(results[0]?.result, "latest prior result");
assert.equal(results[1]?.result, "second prior result");
assert.ok(results.every((entry) => entry.result !== "current result"));
assert.ok(results.every((entry) => entry.result !== "wrong sibling result"));
assert.ok(results.every((entry) => entry.result !== "unscoped result"));

const longResult = priorMissionResults(
  missions,
  [{ role: "assistant", content: "x".repeat(400), timestamp: 7, metadata: { missionId: "prior-a" } }],
  "thread-a",
)[0]?.result;
assert.ok(longResult && longResult.length <= 220 && longResult.endsWith("…"));

console.log("prior Mission result projection behavior passed");
