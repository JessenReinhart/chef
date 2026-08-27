import { strict as assert } from "node:assert";
import {
  MAX_VISIBLE_RESULTS,
  artifactHandoff,
  artifactsForCurrentMission,
  artifactsForMission,
  canDownload,
  copyRunCommand,
  provenanceLabel,
  recentArtifacts,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";

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
assert.deepEqual(
  artifactsForCurrentMission(mixedMissionResults, null),
  [],
  "without an authoritative current Mission, workspace history must not masquerade as current-task results",
);
assert.deepEqual(
  artifactsForCurrentMission(mixedMissionResults, undefined),
  [],
  "while Mission scope is loading, Chef should show no current-result claim rather than stale workspace history",
);
assert.deepEqual(
  recentArtifacts(currentMissionResults, MAX_VISIBLE_RESULTS).map((item) => item.id),
  ["current-mission-metadata", "current-task"],
  "current Mission results should still be newest-first after lineage scoping",
);

const goldenTodoResult = artifact("golden-todo", 11, "task-todo", "file:///tmp/todo-app.mjs", {
  content: "Created runnable todo app at /tmp/todo-app.mjs",
  run: "node /tmp/todo-app.mjs",
  verifiedBy: "golden-path",
});
assert.deepEqual(
  artifactHandoff(goldenTodoResult),
  {
    summary: "Created runnable todo app at /tmp/todo-app.mjs",
    runCommand: "node /tmp/todo-app.mjs",
    verifiedBy: "golden-path",
  },
  "the Living Workspace must preserve the canonical artifact contract for what changed, how to run it, and what verified it",
);

let copiedCommand = "";
assert.equal(
  await copyRunCommand("node /tmp/todo-app.mjs", async (command) => { copiedCommand = command; }),
  "copied",
  "a durable run command should be directly actionable from the result handoff",
);
assert.equal(copiedCommand, "node /tmp/todo-app.mjs", "copy action must preserve the exact worker-provided run command");
assert.equal(
  await copyRunCommand("npm start"),
  "unavailable",
  "the result handoff must report when clipboard support is unavailable instead of pretending the action succeeded",
);
assert.equal(
  await copyRunCommand("npm start", async () => { throw new Error("clipboard denied"); }),
  "failed",
  "clipboard rejection must remain a visible failure state rather than a false success",
);

assert.deepEqual(
  artifactHandoff(artifact("legacy-result", 12, "task-legacy", "chef:legacy", { description: "Generated report", runCommand: "npm start", verification: "runtime smoke" })),
  { summary: "Generated report", runCommand: "npm start", verifiedBy: "runtime smoke" },
  "result handoff should remain useful for older/custom artifact metadata aliases",
);

assert.equal(workspaceSurfacePlan("simple").livingArtifacts, true, "normal work should keep result projection in the same Living Workspace");
assert.equal(workspaceSurfacePlan("power").livingArtifacts, false, "opening runtime detail should not duplicate the normal result projection");
assert.equal(canDownload(artifact("file-result", 13, "task-file", "file:///tmp/result.txt")), true, "file-backed results should expose a real download action");
assert.equal(canDownload(artifact("runtime-result", 14)), false, "runtime-only artifacts must not invent a download action");
assert.equal(provenanceLabel(artifact("artifact-15", 15)), "v15 · by claude-code · task task-15", "result handoff should preserve concise provenance");

console.log("intent-home-artifacts-ui: ok — current Mission result handoff is lineage-scoped and actionable");