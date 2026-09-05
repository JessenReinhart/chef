import { strict as assert } from "node:assert";
import {
  missionResultHandoffProjection,
  shouldOfferArtifactShelf,
  shouldRetainMissionArtifactsOnRefreshFailure,
  shouldRetainMissionResultOnRefreshFailure,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";

const completedNotice = "Work is marked complete, but Chef did not publish a durable result for this Mission.";
const attentionPartialNotice = "Chef saved a partial result, but this Mission still needs attention before the handoff is complete.";
const pausedPartialNotice = "Chef saved a partial result, but this Mission is paused before the handoff is complete.";
const pausedEmptyNotice = "No durable result is available because this Mission is paused.";
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

const overflowLeafArtifacts: LivingArtifact[] = Array.from({ length: 5 }, (_, index) => ({
  ...result,
  id: `leaf-${index + 1}`,
  name: `leaf-${index + 1}.tsx`,
  uri: `file:///tmp/todo-app/leaf-${index + 1}.tsx`,
  metadata: {
    missionId: "mission-current",
    content: `Generated leaf file ${index + 1}`,
  },
}));
const overflowProjection = missionResultHandoffProjection(
  [result, ...overflowLeafArtifacts],
  scope,
  "thread-current",
  "completed",
);
assert.equal(overflowProjection.artifacts.length, 4, "Simple Mode result handoff must remain bounded when a Mission publishes many files");
assert.deepEqual(
  overflowProjection.artifacts.map((artifact) => artifact.id),
  ["leaf-5", "leaf-4", "leaf-3", "todo-result"],
  "overflow must preserve recent outputs while reserving one visible slot for the most recent runnable Mission handoff",
);
assert.equal(
  overflowProjection.artifacts.at(-1)?.metadata.run,
  "node /tmp/todo-app.mjs",
  "the preserved runnable handoff must retain the exact durable run instruction instead of synthesizing one",
);

const newerRunnableResult: LivingArtifact = {
  ...result,
  id: "todo-result-newer",
  version: 2,
  metadata: {
    ...result.metadata,
    run: "npm run dev",
  },
};
const multipleRunnableProjection = missionResultHandoffProjection(
  [result, newerRunnableResult, ...overflowLeafArtifacts],
  scope,
  "thread-current",
  "completed",
);
assert.equal(
  multipleRunnableProjection.artifacts.at(-1)?.id,
  newerRunnableResult.id,
  "when multiple runnable handoffs overflow, Simple Mode should preserve the most recent one",
);

const unrelatedRunnable: LivingArtifact = {
  ...result,
  id: "other-thread-runnable",
  taskId: "task-other",
  metadata: {
    missionId: "mission-other",
    run: "npm start",
  },
};
const scopedOverflowProjection = missionResultHandoffProjection(
  [unrelatedRunnable, ...overflowLeafArtifacts],
  scope,
  "thread-current",
  "completed",
);
assert.deepEqual(
  scopedOverflowProjection.artifacts.map((artifact) => artifact.id),
  ["leaf-5", "leaf-4", "leaf-3", "leaf-2"],
  "overflow must never promote a runnable artifact that does not belong to the current Mission",
);

assert.equal(
  shouldRetainMissionResultOnRefreshFailure("thread-current", "thread-current"),
  true,
  "a transient full refresh failure for the still-selected Thread may keep its last known result handoff available",
);
assert.equal(
  shouldRetainMissionResultOnRefreshFailure("thread-current", "thread-other"),
  false,
  "a refresh failure after switching Threads must never retain the previous Thread's result as current",
);
assert.equal(
  shouldRetainMissionResultOnRefreshFailure(null, "thread-current"),
  false,
  "Chef must not invent a retained handoff when no successful result snapshot has loaded for the selected Thread",
);

assert.equal(
  shouldRetainMissionArtifactsOnRefreshFailure("thread-current", "thread-current", "mission-current", "mission-current"),
  true,
  "an artifact-only failure may retain the last known cards when state confirms the same Thread and Mission are still current",
);
assert.equal(
  shouldRetainMissionArtifactsOnRefreshFailure("thread-current", "thread-current", "mission-previous", "mission-current"),
  false,
  "a newer Mission in the same Thread must not inherit the previous Mission's result cards when artifact refresh fails",
);
assert.equal(
  shouldRetainMissionArtifactsOnRefreshFailure("thread-current", "thread-other", "mission-current", "mission-current"),
  false,
  "Mission identity cannot make a prior Thread's result safe after Thread selection changes",
);
assert.equal(
  shouldRetainMissionArtifactsOnRefreshFailure("thread-current", "thread-current", "mission-current", null),
  false,
  "a selected Thread with no current Mission must clear prior Mission cards after an artifact-only failure",
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
  missionResultHandoffProjection([result], scope, "thread-current", "paused"),
  { artifacts: [result], notice: pausedPartialNotice },
  "a paused Mission must identify an existing artifact as partial rather than implying a finished handoff",
);

assert.deepEqual(
  missionResultHandoffProjection([], scope, "thread-current", "paused"),
  { artifacts: [], notice: pausedEmptyNotice },
  "a paused Mission with no durable output must keep its incomplete handoff visible",
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

const otherScope = { missionId: "mission-other", taskIds: ["task-other"], threadId: "thread-other" };
const otherResult: LivingArtifact = {
  ...result,
  id: "other-result",
  name: "other-output",
  taskId: "task-other",
  metadata: {
    ...result.metadata,
    missionId: "mission-other",
    content: "Created another output",
  },
};

assert.deepEqual(
  missionResultHandoffProjection([result, otherResult], otherScope, "thread-other", "completed"),
  { artifacts: [otherResult], notice: null },
  "switching to Thread B must project only B's current Mission result",
);

assert.deepEqual(
  missionResultHandoffProjection([result, otherResult], scope, "thread-current", "completed"),
  { artifacts: [result], notice: null },
  "returning to Thread A must restore A's result without leaking B's newer workspace result",
);

assert.deepEqual(
  missionResultHandoffProjection([result, otherResult], null, "thread-other", "completed"),
  { artifacts: [], notice: null },
  "a selected Thread with no Mission must not inherit a workspace-global result",
);

assert.equal(
  shouldOfferArtifactShelf(1, 0),
  true,
  "an idle selected Thread must keep the workspace artifact shelf reachable when a durable result exists elsewhere",
);
assert.equal(
  shouldOfferArtifactShelf(4, 0),
  true,
  "a small workspace history must remain reachable even when there are too few artifacts to trigger overflow behavior",
);
assert.equal(
  shouldOfferArtifactShelf(4, 1),
  true,
  "a current result must not hide other workspace artifacts merely because the workspace has four or fewer outputs",
);
assert.equal(
  shouldOfferArtifactShelf(4, 4),
  false,
  "when the current Thread already shows the entire workspace result set, Simple Mode should stay compact instead of duplicating a shelf affordance",
);
assert.equal(
  shouldOfferArtifactShelf(5, 4),
  true,
  "workspace overflow must continue exposing the shelf when one result is outside the visible handoff",
);
assert.equal(
  shouldOfferArtifactShelf(0, 0),
  false,
  "an empty workspace must not render an empty artifact shelf affordance",
);

console.log("result-handoff-projection: ok — runnable overflow stays visible, incomplete handoffs stay truthful, refresh failures retain cards only for the same selected Mission, and durable workspace artifacts remain rediscoverable whenever results are hidden");
