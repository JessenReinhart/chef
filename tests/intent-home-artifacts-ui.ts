import { strict as assert } from "node:assert";
import {
  MAX_VISIBLE_RESULTS,
  artifactHandoff,
  artifactsForCurrentMission,
  artifactsForMission,
  canDownload,
  copyRunCommand,
  missingResultHandoffNotice,
  provenanceLabel,
  recentArtifacts,
  visibleArtifactsForCurrentMission,
  visibleArtifactsForSelectedThreadMission,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";
import { missionProgressEventStreamUrl, subscribeMissionProgressRefresh } from "../web/src/missionProgressStream.ts";
import { createSingleFlightArtifactRevealer, revealArtifact as requestArtifactReveal } from "../web/src/resultActions.ts";
import { missionTaskIdsFromEvents } from "../web/src/threadScope.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

const artifact = (
  id: string,
  version: number,
  taskId = `task-${version}`,
  uri = `chef:${id}`,
  metadata: Record<string, unknown> = {},
): LivingArtifact => ({
  id,
  workspaceId: "workspace-1",
  type: "document",
  name: `Result ${version}`,
  uri,
  version,
  createdBy: "claude-code",
  taskId,
  metadata,
});

const timeline = Array.from({ length: 6 }, (_, index) => artifact(`artifact-${index + 1}`, index + 1));
const visible = recentArtifacts(timeline, MAX_VISIBLE_RESULTS);
assert.deepEqual(visible.map((item) => item.id), ["artifact-6", "artifact-5", "artifact-4", "artifact-3"], "workspace history should keep newest durable results first");

const mixedMissionResults = [
  artifact("older-unrelated", 7, "task-old"),
  artifact("current-task", 8, "task-current"),
  artifact("current-mission-metadata", 9, "task-other", "chef:metadata", { missionId: "mission-current" }),
  artifact("newer-unrelated", 10, "task-newer"),
];
const currentMissionResults = artifactsForMission(mixedMissionResults, "mission-current", ["task-current"]);
assert.deepEqual(
  currentMissionResults.map((item) => item.id),
  ["current-task", "current-mission-metadata"],
  "the visible result handoff must not let unrelated workspace history impersonate the current Mission result",
);
assert.deepEqual(
  artifactsForCurrentMission(mixedMissionResults, { missionId: "mission-current", taskIds: ["task-current"] }).map((item) => item.id),
  ["current-task", "current-mission-metadata"],
  "the primary result projection should follow the authoritative current Mission scope",
);
assert.deepEqual(artifactsForCurrentMission(mixedMissionResults, null), [], "without an authoritative current Mission, workspace history must not masquerade as current-task results");
assert.deepEqual(artifactsForCurrentMission(mixedMissionResults, undefined), [], "while Mission scope is loading, Chef should show no current-result claim rather than stale workspace history");
assert.deepEqual(recentArtifacts(currentMissionResults, MAX_VISIBLE_RESULTS).map((item) => item.id), ["current-mission-metadata", "current-task"], "current Mission results should still be newest-first after lineage scoping");

const earlyMissionResult = artifact("early-current-result", 11, "task-not-yet-in-mission-snapshot", "chef:early-result", { missionId: "mission-current", summary: "First durable result is ready" });
assert.deepEqual(
  visibleArtifactsForCurrentMission(
    [artifact("other-thread-result", 12, "task-other-thread", "chef:other", { missionId: "mission-other" }), earlyMissionResult],
    { missionId: "mission-current", taskIds: [] },
  ).map((item) => item.id),
  ["early-current-result"],
  "a durable current-Mission result should become visible immediately even while the Mission taskIds snapshot is still catching up",
);

assert.deepEqual(visibleArtifactsForSelectedThreadMission([earlyMissionResult], { missionId: "mission-current", taskIds: [], threadId: "thread-a" }, "thread-b"), [], "switching Threads must suppress the previous Thread's Mission results immediately while the new Thread state is loading");
assert.deepEqual(visibleArtifactsForSelectedThreadMission([earlyMissionResult], { missionId: "mission-current", taskIds: [], threadId: "thread-a" }, "thread-a").map((item) => item.id), ["early-current-result"], "the selected Thread should still surface its own current Mission result");

const durableTaskLineageEvent: UiRuntimeEvent = {
  id: "mission-current-plan",
  seq: 13,
  timestamp: 1_300,
  source: { type: "orchestrator", id: "orchestrator" },
  type: "orchestrator.plan.proposed",
  correlationId: "mission-current",
  payload: { taskId: "task-event-linked" },
};
const recoveredTaskIds = missionTaskIdsFromEvents([durableTaskLineageEvent], ["mission-current"], []);
assert.deepEqual(
  visibleArtifactsForCurrentMission([
    artifact("other-task-only-result", 14, "task-other-thread"),
    artifact("early-task-only-result", 15, "task-event-linked", "chef:task-only-result", { summary: "Task-linked result is ready" }),
  ], { missionId: "mission-current", taskIds: recoveredTaskIds }).map((item) => item.id),
  ["early-task-only-result"],
  "durable Mission-correlated Task lineage should surface a current result even before Mission.taskIds converges, without leaking another Task's artifact",
);

assert.equal(missingResultHandoffNotice("completed", 0), "Work is marked complete, but Chef did not publish a durable result for this Mission.", "a completed Mission without an artifact must expose the missing result handoff instead of silently rendering no Results surface");
assert.equal(missingResultHandoffNotice("active", 0), null, "active work should not be mislabeled as a missing result before completion");
assert.equal(missingResultHandoffNotice("completed", 1), null, "a completed Mission with a durable result should not show a false handoff warning");
assert.equal(missingResultHandoffNotice("failed", 0), "No durable result is available because this Mission needs attention.", "failed work should explain why no result is available without pretending completion succeeded");

const goldenTodoResult = artifact("golden-todo", 16, "task-todo", "file:///tmp/todo-app.mjs", {
  content: "Created runnable todo app at /tmp/todo-app.mjs",
  run: "node /tmp/todo-app.mjs",
  verifiedBy: "golden-path",
});
assert.deepEqual(artifactHandoff(goldenTodoResult), { summary: "Created runnable todo app at /tmp/todo-app.mjs", runCommand: "node /tmp/todo-app.mjs", verifiedBy: "golden-path" }, "the Living Workspace must preserve the canonical artifact contract for what changed, how to run it, and what verified it");

let copiedCommand = "";
assert.equal(await copyRunCommand("node /tmp/todo-app.mjs", async (command) => { copiedCommand = command; }), "copied", "a durable run command should be directly actionable from the result handoff");
assert.equal(copiedCommand, "node /tmp/todo-app.mjs", "copy action must preserve the exact worker-provided run command");
assert.equal(await copyRunCommand("npm start"), "unavailable", "the result handoff must report when clipboard support is unavailable instead of pretending the action succeeded");
assert.equal(await copyRunCommand("npm start", async () => { throw new Error("clipboard denied"); }), "failed", "clipboard rejection must remain a visible failure state rather than a false success");

let revealUrl = "";
let revealMethod = "";
const revealSuccess = await requestArtifactReveal("golden todo/result", async (input, init) => {
  revealUrl = String(input);
  revealMethod = init?.method ?? "";
  return { ok: true, json: async () => ({ ok: true }) } as Pick<Response, "ok" | "json">;
});
assert.deepEqual(revealSuccess, { ok: true }, "a file-backed durable result should expose a truthful successful reveal action");
assert.equal(revealUrl, "/api/artifacts/golden%20todo%2Fresult/reveal", "the browser must send only the encoded durable artifact id, never a filesystem path");
assert.equal(revealMethod, "POST", "revealing a local result is an explicit action rather than a passive GET");

const revealRejected = await requestArtifactReveal("outside-result", async () => ({ ok: false, json: async () => ({ error: "artifact file is outside the project root" }) }) as Pick<Response, "ok" | "json">);
assert.deepEqual(revealRejected, { ok: false, error: "artifact file is outside the project root" }, "Simple Mode must surface the server's safe reveal rejection instead of pretending the folder opened");

const revealUnavailable = await requestArtifactReveal("missing-result", async () => { throw new Error("connection lost"); });
assert.deepEqual(revealUnavailable, { ok: false, error: "connection lost" }, "transport failure must remain visible in the result handoff");

let releaseReveal!: (result: { ok: true }) => void;
let revealCalls = 0;
const singleFlightReveal = createSingleFlightArtifactRevealer(async () => {
  revealCalls += 1;
  if (revealCalls > 1) return { ok: true };
  return new Promise<{ ok: true }>((resolve) => { releaseReveal = resolve; });
});
const firstReveal = singleFlightReveal("golden-todo");
const duplicateReveal = singleFlightReveal("golden-todo");
assert.equal(firstReveal, duplicateReveal, "repeated clicks for the same pending result must share one external reveal action");
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(revealCalls, 1, "one pending result reveal must invoke the desktop opener path only once");
releaseReveal({ ok: true });
await Promise.all([firstReveal, duplicateReveal]);
await singleFlightReveal("golden-todo");
assert.equal(revealCalls, 2, "after the prior reveal settles, a later user retry must be allowed to open the result again");

assert.deepEqual(artifactHandoff(artifact("legacy-result", 17, "task-legacy", "chef:legacy", { description: "Generated report", runCommand: "npm start", verification: "runtime smoke" })), { summary: "Generated report", runCommand: "npm start", verifiedBy: "runtime smoke" }, "result handoff should remain useful for older/custom artifact metadata aliases");

let requestedLiveResultStream = "";
let liveResultRefreshCount = 0;
let liveResultStreamClosed = false;
const fakeLiveResultStream = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  close() { liveResultStreamClosed = true; },
};
const unsubscribeLiveResults = subscribeMissionProgressRefresh(
  () => { liveResultRefreshCount += 1; },
  (url) => {
    requestedLiveResultStream = url;
    return fakeLiveResultStream;
  },
);
assert.equal(requestedLiveResultStream, missionProgressEventStreamUrl(), "the Simple Mode result handoff should reuse the authoritative worker-aware Mission event stream instead of waiting only for polling");
assert.ok(fakeLiveResultStream.onmessage, "the live result handoff must attach an event-driven refresh callback");
fakeLiveResultStream.onmessage?.({} as MessageEvent);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(liveResultRefreshCount, 1, "authoritative Mission/Task/Session activity should make durable results eligible for immediate refresh");
unsubscribeLiveResults();
assert.equal(liveResultStreamClosed, true, "unmounting the result handoff must release the live progress stream");

assert.equal(workspaceSurfacePlan("simple").livingArtifacts, true, "normal work should keep result projection in the same Living Workspace");
assert.equal(workspaceSurfacePlan("power").livingArtifacts, false, "opening runtime detail should not duplicate the normal result projection");
assert.equal(canDownload(artifact("file-result", 18, "task-file", "file:///tmp/result.txt")), true, "file-backed results should expose a real download action");
assert.equal(canDownload(artifact("runtime-result", 19)), false, "runtime-only artifacts must not invent a download action");
assert.equal(provenanceLabel(artifact("artifact-20", 20)), "v20 · by claude-code · task task-20", "result handoff should preserve concise provenance");

console.log("intent-home-artifacts-ui: ok — current Mission result handoff is lineage-scoped, thread-correct, actionable, live-refreshable, safely revealable, duplicate-safe, and can surface mission- or task-linked durable results before snapshot convergence");
