import { strict as assert } from "node:assert";
import {
  missionResultHandoffProjection,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";

const completedNotice = "Work is marked complete, but Chef did not publish a durable result for this Mission.";
const attentionPartialNotice = "Chef saved a partial result, but this Mission still needs attention before the handoff is complete.";
const stoppedPartialNotice = "Chef saved a partial result, but this Mission was stopped before the handoff was complete.";
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
  missionResultHandoffProjection([result], scope, "thread-current", "failed"),
  { artifacts: [result], notice: attentionPartialNotice },
  "a failed Mission must keep its partial durable result visible without hiding that recovery is still required",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "blocked"),
  { artifacts: [result], notice: attentionPartialNotice },
  "a blocked Mission must not let a partial result masquerade as a completed handoff",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "waiting_for_approval"),
  { artifacts: [result], notice: attentionPartialNotice },
  "approval-wait Missions may expose partial results but must still tell the user the handoff needs attention",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "cancelled"),
  { artifacts: [result], notice: stoppedPartialNotice },
  "a stopped Mission must identify an existing artifact as partial rather than implying successful completion",
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
  missionResultHandoffProjection([result], scope, "thread-other", "failed"),
  { artifacts: [], notice: null },
  "a stale previous-Thread partial result and its recovery warning must remain hidden after Thread selection changes",
);

console.log("result-handoff-projection: ok — terminal handoff stays truthful for missing and partial results and remains selected-Thread scoped");
