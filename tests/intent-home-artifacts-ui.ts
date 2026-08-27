import { strict as assert } from "node:assert";
import {
  MAX_VISIBLE_RESULTS,
  canDownload,
  provenanceLabel,
  recentArtifacts,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";
import { workspaceSurfacePlan } from "../web/src/canonicalWorkspaceModel.ts";

const artifact = (id: string, version: number, uri = `chef:${id}`): LivingArtifact => ({
  id,
  workspaceId: "workspace-1",
  type: "document",
  name: `Result ${version}`,
  uri,
  version,
  createdBy: "claude-code",
  taskId: `task-${version}`,
  metadata: {},
});

const timeline = Array.from({ length: 6 }, (_, index) => artifact(`artifact-${index + 1}`, index + 1));
const visible = recentArtifacts(timeline, MAX_VISIBLE_RESULTS);
assert.deepEqual(visible.map((item) => item.id), ["artifact-6", "artifact-5", "artifact-4", "artifact-3"], "the canonical workspace should hand off the newest durable results first");
assert.equal(workspaceSurfacePlan("simple").livingArtifacts, true, "normal work should keep result projection in the same Living Workspace");
assert.equal(workspaceSurfacePlan("power").livingArtifacts, false, "opening runtime detail should not duplicate the normal result projection");
assert.equal(canDownload(artifact("file-result", 7, "file:///tmp/result.txt")), true, "file-backed results should expose a real download action");
assert.equal(canDownload(artifact("runtime-result", 8)), false, "runtime-only artifacts must not invent a download action");
assert.equal(provenanceLabel(artifact("artifact-9", 9)), "v9 · by claude-code · task task-9", "result handoff should preserve concise provenance");

console.log("intent-home-artifacts-ui: ok — result handoff is verified by artifact and workspace behavior");
