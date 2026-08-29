import { strict as assert } from "node:assert";
import {
  missionResultHandoffProjection,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";

const completedNotice = "Work is marked complete, but Chef did not publish a durable result for this Mission.";
const scope = { missionId: "mission-current", taskIds: ["task-current"], threadId: "thread-current" };
const result: LivingArtifact = {
  id: "todo-result",
  workspaceId: "workspace-1",
  type: "code",
  name: "todo-app",
  uri: "file:///tmp/todo-app.mjs",
  version: 1,
  createdBy: "todo-builder",
  taskId: "task-current",
  metadata: {
    missionId: "mission-current",
    content: "Created runnable todo app",
    run: "node /tmp/todo-app.mjs",
    verifiedBy: "golden-path",
  },
};

assert.deepEqual(
  missionResultHandoffProjection([], scope, "thread-current", "completed"),
  { artifacts: [], notice: completedNotice },
  "a completed selected-Thread Mission with no durable artifact must project an explicit missing-result handoff",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "completed"),
  { artifacts: [result], notice: null },
  "a completed Mission with its durable result must project the result without a false warning",
);

assert.deepEqual(
  missionResultHandoffProjection([], scope, "thread-current", "active"),
  { artifacts: [], notice: null },
  "active work must not claim a missing result before completion",
);

assert.deepEqual(
  missionResultHandoffProjection([], scope, "thread-other", "completed"),
  { artifacts: [], notice: null },
  "a stale completed Mission from the previous Thread must not leak a missing-result warning after Thread selection changes",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-other", "completed"),
  { artifacts: [], notice: null },
  "a stale previous-Thread result must remain hidden together with its completion handoff",
);

console.log("result-handoff-projection: ok — completion handoff stays visible when missing and remains selected-Thread scoped");
