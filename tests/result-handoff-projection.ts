import { strict as assert } from "node:assert";
import {
  missionResultHandoffProjection,
  shouldOfferArtifactShelf,
  shouldRetainMissionArtifactsOnRefreshFailure,
  shouldRetainMissionResultOnRefreshFailure,
  type LivingArtifact,
} from "../web/src/artifactProjection.ts";

const completedNotice = "Work is marked complete, but Chef did not publish a durable result for this Mission.";
const completedLocationNotice = "Work is marked complete, but Chef did not publish a durable result location for this Mission.";
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
  missionResultHandoffProjection([], scope, "thread-current", "completed", 4, false),
  { artifacts: [], notice: null },
  "an unavailable artifact snapshot must not turn zero cached cards into a false claim that completion published no durable result",
);
assert.deepEqual(
  missionResultHandoffProjection([], scope, "thread-current", "failed", 4, false),
  { artifacts: [], notice: null },
  "an artifact outage must also suppress zero-result recovery claims until Chef can observe the durable result set again",
);

assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "completed"),
  { artifacts: [result], notice: null },
  "a completed Mission with its durable result must project the result without a false warning",
);
assert.deepEqual(
  missionResultHandoffProjection([result], scope, "thread-current", "failed", 4, false),
  { artifacts: [result], notice: attentionPartialNotice },
  "a cached same-Mission artifact remains truthful evidence during an artifact refresh outage",
);

const opaqueResult: LivingArtifact = {
  ...result,
  id: "opaque-result",
  type: "result",
  uri: "sideband://worker/todo-result",
  metadata: {
    missionId: "mission-current",
    summary: "Created the todo app",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([opaqueResult], scope, "thread-current", "completed"),
  { artifacts: [opaqueResult], notice: completedLocationNotice },
  "a completed Mission must not look product-green when its only durable result has no usable location",
);
assert.deepEqual(
  missionResultHandoffProjection([opaqueResult], scope, "thread-current", "completed", 4, false),
  { artifacts: [opaqueResult], notice: null },
  "a cached opaque result during an artifact outage is not proof that the latest durable handoff lacks a location",
);

const explicitLocationResult: LivingArtifact = {
  ...opaqueResult,
  id: "explicit-location-result",
  metadata: {
    ...opaqueResult.metadata,
    resultLocation: "todo-app/index.html",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([explicitLocationResult], scope, "thread-current", "completed"),
  { artifacts: [explicitLocationResult], notice: null },
  "an explicit durable result location must satisfy the completed handoff",
);

const pathLocationResult: LivingArtifact = {
  ...opaqueResult,
  id: "path-location-result",
  metadata: {
    ...opaqueResult.metadata,
    path: "todo-app/index.html",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([pathLocationResult], scope, "thread-current", "completed"),
  { artifacts: [pathLocationResult], notice: null },
  "durable path metadata must satisfy the completed handoff",
);

const unrelatedLocatedResult: LivingArtifact = {
  ...explicitLocationResult,
  id: "other-thread-result",
  taskId: "task-other",
  metadata: {
    missionId: "mission-other",
    resultLocation: "other/index.html",
  },
};
assert.deepEqual(
  missionResultHandoffProjection([opaqueResult, unrelatedLocatedResult], scope, "thread-current", "completed"),
  { artifacts: [opaqueResult], notice: completedLocationNotice },
  "a located result from another Mission must never make the foreground Mission look complete",
);

assert.deepEqual(
  missionResultHandoffProjection([opaqueResult], scope, "thread-current", "active"),
  { artifacts: [opaqueResult], notice: null },
  "active work must not claim a missing final location before completion",
);
assert.deepEqual(
  missionResultHandoffProjection([opaqueResult], scope, "thread-current", "failed"),
  { artifacts: [opaqueResult], notice: attentionPartialNotice },
  "failure recovery messaging must continue to outrank completed-handoff completeness",
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

const hiddenLocatedArtifact: LivingArtifact = {
  ...opaqueResult,
  id: "hidden-located-result",
  metadata: {
    ...opaqueResult.metadata,
    resultLocation: "todo-app/index.html",
  },
};
const opaqueOverflowArtifacts: LivingArtifact[] = Array.from({ length: 5 }, (_, index) => ({
  ...opaqueResult,
  id: `opaque-leaf-${index + 1}`,
  name: `opaque-leaf-${index + 1}`,
}));
const hiddenLocationProjection = missionResultHandoffProjection(
  [hiddenLocatedArtifact, ...opaqueOverflowArtifacts],
  scope,
  "thread-current",
  "completed",
);
assert.equal(hiddenLocationProjection.artifacts.length, 4, "visible result cards must stay bounded independently from handoff completeness");
assert.equal(
  hiddenLocationProjection.artifacts.some((artifact) => artifact.id === hiddenLocatedArtifact.id),
  false,
  "the regression requires the located artifact to sit outside the visible-card cap",
);
assert.equal(
  hiddenLocationProjection.notice,
  null,
  "a valid foreground-Mission location outside the visible-card cap must still satisfy completion",
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

console.log("result-handoff-projection: ok — runnable overflow stays visible, completed results require a durable location across the full Mission artifact set, incomplete handoffs stay truthful, result absence stays unknown during artifact outages, refresh failures retain cards only for the same selected Mission, and durable workspace artifacts remain rediscoverable whenever results are hidden");
