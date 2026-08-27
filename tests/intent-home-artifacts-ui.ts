import { strict as assert } from "node:assert";
import {
  MAX_VISIBLE_RESULTS,
  artifactsForMission,
  canDownload,
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
  recentArtifacts(currentMissionResults, MAX_VISIBLE_RESULTS).map((item) => item.id),
  ["current-mission-metadata", "current-task"],
  "current Mission results should still be newest-first after lineage scoping",
);

assert.equal(workspaceSurfacePlan("simple").livingArtifacts, true, "normal work should keep result projection in the same Living Workspace");
assert.equal(workspaceSurfacePlan("power").livingArtifacts, false, "opening runtime detail should not duplicate the normal result projection");
assert.equal(canDownload(artifact("file-result", 11, "task-file", "file:///tmp/result.txt")), true, "file-backed results should expose a real download action");
assert.equal(canDownload(artifact("runtime-result", 12)), false, "runtime-only artifacts must not invent a download action");
assert.equal(provenanceLabel(artifact("artifact-13", 13)), "v13 · by claude-code · task task-13", "result handoff should preserve concise provenance");

console.log("intent-home-artifacts-ui: ok — current Mission result handoff is lineage-scoped");
