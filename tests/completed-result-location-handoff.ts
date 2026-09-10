import { strict as assert } from "node:assert";
import { missionResultHandoffProjection, type LivingArtifact } from "../web/src/artifactProjection.ts";

const scope = { missionId: "mission-current", taskIds: ["task-current"], threadId: "thread-current" };
const baseResult: LivingArtifact = {
  id: "todo-result",
  workspaceId: "workspace-1",
  type: "result",
  name: "todo-app",
  uri: "sideband://worker/todo-result",
  version: 1,
  createdBy: "todo-builder",
  taskId: "task-current",
  metadata: {
    missionId: "mission-current",
    summary: "Created the todo app",
  },
};

const missingLocationNotice = "Work is marked complete, but Chef did not publish a durable result location for this Mission.";

assert.deepEqual(
  missionResultHandoffProjection([baseResult], scope, "thread-current", "completed"),
  { artifacts: [baseResult], notice: missingLocationNotice },
  "a completed Mission must not look product-green when its only durable result has no usable location",
);

assert.deepEqual(
  missionResultHandoffProjection([baseResult], scope, "thread-current", "completed", 4, false),
  { artifacts: [baseResult], notice: null },
  "a cached opaque result during an artifact outage is not proof that the latest durable handoff lacks a location",
);

const explicitLocation: LivingArtifact = {
  ...baseResult,
  id: "todo-result-with-location",
  metadata: {
    ...baseResult.metadata,
    resultLocation: "todo-app/index.html",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([explicitLocation], scope, "thread-current", "completed"),
  { artifacts: [explicitLocation], notice: null },
  "an explicit durable result location must satisfy the completed handoff",
);

const fileUriResult: LivingArtifact = {
  ...baseResult,
  id: "todo-result-file-uri",
  uri: "file:///tmp/todo-app/index.html",
};
assert.deepEqual(
  missionResultHandoffProjection([fileUriResult], scope, "thread-current", "completed"),
  { artifacts: [fileUriResult], notice: null },
  "a file-backed durable result must satisfy the completed handoff even without duplicate location metadata",
);

const unrelatedLocatedResult: LivingArtifact = {
  ...explicitLocation,
  id: "other-thread-result",
  taskId: "task-other",
  metadata: {
    missionId: "mission-other",
    resultLocation: "other/index.html",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([baseResult, unrelatedLocatedResult], scope, "thread-current", "completed"),
  { artifacts: [baseResult], notice: missingLocationNotice },
  "a located result from another Mission must never make the foreground Mission look complete",
);

assert.deepEqual(
  missionResultHandoffProjection([baseResult], scope, "thread-current", "active"),
  { artifacts: [baseResult], notice: null },
  "active work must not claim a missing final location before completion",
);

assert.deepEqual(
  missionResultHandoffProjection([baseResult], scope, "thread-current", "failed"),
  {
    artifacts: [baseResult],
    notice: "Chef saved a partial result, but this Mission still needs attention before the handoff is complete.",
  },
  "failure recovery messaging must continue to outrank completed-handoff completeness",
);

console.log("completed-result-location-handoff: ok — completed Mission handoffs stay visibly incomplete until their own durable result exposes a location");
