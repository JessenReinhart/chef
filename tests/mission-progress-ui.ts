import { strict as assert } from "node:assert";

import {
  deriveMissionHeartbeat,
  deriveMissionHomeState,
  summarizeMissionProgressEvent,
  summarizeMissionProgressForMission,
} from "../web/src/missionProgress.ts";
import {
  MISSION_PROGRESS_EVENT_TYPES,
  missionProgressEventStreamUrl,
  subscribeMissionProgressRefresh,
} from "../web/src/missionProgressStream.ts";
import type { UiRuntimeEvent } from "../web/src/types.ts";

function missionStatusEvent(id: string, status: string, missionId = "mission-1", timestamp = 1_000): UiRuntimeEvent {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    timestamp,
    source: { type: "mission", id: missionId },
    type: "mission.status",
    payload: { status },
  };
}

function taskEvent(id: string, type: string, payload: Record<string, unknown>, taskId = "task-1", timestamp = 1_000): UiRuntimeEvent {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    timestamp,
    source: { type: "runtime", id: "task-machine" },
    type,
    payload,
    taskId,
  };
}

assert.deepEqual(
  MISSION_PROGRESS_EVENT_TYPES,
  ["mission.*", "orchestrator.*", "approval.*", "node.failed", "task.*", "session.*"],
  "Simple Mode progress must subscribe to every runtime family its human-readable translator consumes",
);
assert.equal(
  missionProgressEventStreamUrl(),
  "/api/events?types=mission.*,orchestrator.*,approval.*,node.failed,task.*,session.*",
  "the live progress EventSource URL must retain Task and Session events alongside existing Mission signals",
);

let requestedProgressStream = "";
let liveRefreshCount = 0;
let liveStreamClosed = false;
let releaseFirstRefresh!: () => void;
const firstRefresh = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
const fakeProgressStream = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  close() { liveStreamClosed = true; },
};
const unsubscribeLiveProgress = subscribeMissionProgressRefresh(
  () => {
    liveRefreshCount += 1;
    return liveRefreshCount === 1 ? firstRefresh : Promise.resolve();
  },
  (url) => {
    requestedProgressStream = url;
    return fakeProgressStream;
  },
);
assert.equal(requestedProgressStream, missionProgressEventStreamUrl(), "the mounted progress projection must open the worker-aware runtime stream");
assert.ok(fakeProgressStream.onmessage, "the mounted progress projection must attach a live event handler");
fakeProgressStream.onmessage?.({} as MessageEvent);
fakeProgressStream.onmessage?.({} as MessageEvent);
fakeProgressStream.onmessage?.({} as MessageEvent);
assert.equal(liveRefreshCount, 1, "bursty worker output must not start concurrent state refreshes while one refresh is still in flight");
releaseFirstRefresh();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(liveRefreshCount, 2, "bursty worker output must collapse into one trailing refresh so the latest state is still observed");
unsubscribeLiveProgress();
assert.equal(liveStreamClosed, true, "unmounting the progress projection must release its EventSource connection");

const cancelled = summarizeMissionProgressEvent(missionStatusEvent("event-1", "cancelled"));
assert.ok(cancelled);
assert.equal(cancelled.text, "Mission cancelled.");
assert.equal(cancelled.tone, "attention", "cancelled Missions must remain visibly actionable");

const completed = summarizeMissionProgressEvent(missionStatusEvent("event-2", "completed"));
assert.ok(completed);
assert.equal(completed.tone, "success", "completed Missions must keep their success projection");

const active = summarizeMissionProgressEvent(missionStatusEvent("event-3", "active"));
assert.ok(active);
assert.equal(active.tone, "active", "active Missions must keep their active projection");

const paused = summarizeMissionProgressEvent(missionStatusEvent("event-4", "paused"));
assert.ok(paused);
assert.equal(paused.tone, "neutral", "paused Missions retain the existing neutral projection in this slice");

const failedTask = summarizeMissionProgressEvent(taskEvent("event-5", "task.failed", { from: "running", to: "failed", error: "worker exited" }));
assert.ok(failedTask);
assert.equal(failedTask.text, "A worker step failed: worker exited");
assert.equal(failedTask.tone, "attention", "worker failures must be visible in Simple Mode");

const retryingTask = summarizeMissionProgressEvent(taskEvent("event-6", "task.running", { from: "failed", to: "running", retryCount: 1 }));
assert.ok(retryingTask);
assert.equal(retryingTask.text, "Chef is retrying a work step (retry 1).");
assert.equal(retryingTask.tone, "active", "retries must read as active recovery, not frozen work");

const blockedTask = summarizeMissionProgressEvent(taskEvent("event-7", "task.blocked", { from: "running", to: "blocked", error: "dependency unavailable" }));
assert.ok(blockedTask);
assert.equal(blockedTask.text, "A work step is blocked: dependency unavailable");
assert.equal(blockedTask.tone, "attention");

const crashedSession = summarizeMissionProgressEvent({
  id: "event-8",
  seq: 8,
  timestamp: 1_000,
  source: { type: "runtime", id: "scheduler" },
  type: "session.crashed",
  payload: { reason: "orphan on startup" },
  taskId: "task-1",
  sessionId: "session-1",
});
assert.ok(crashedSession);
assert.equal(crashedSession.text, "A worker session stopped unexpectedly: orphan on startup");
assert.equal(crashedSession.tone, "attention");

assert.equal(
  deriveMissionHomeState({ submitting: true, needsAttention: false, working: false, done: false }),
  "working",
  "a request must leave Ready immediately, before the first runtime refresh",
);
assert.equal(
  deriveMissionHomeState({ submitting: true, needsAttention: true, working: false, done: false }),
  "working",
  "a newly submitted follow-up must not inherit a stale failed Mission presentation",
);
assert.equal(
  deriveMissionHomeState({ submitting: false, needsAttention: true, working: false, done: false }),
  "attention",
);
assert.equal(
  deriveMissionHomeState({ submitting: false, needsAttention: false, working: false, done: true }),
  "done",
);

const progressEvents: UiRuntimeEvent[] = [
  missionStatusEvent("event-10", "planning", "mission-1"),
  {
    id: "event-11",
    seq: 11,
    timestamp: 1_100,
    source: { type: "orchestrator", id: "orchestrator" },
    type: "orchestrator.plan.proposed",
    payload: { taskIds: ["task-1", "task-2"] },
    correlationId: "mission-1",
  },
  {
    id: "event-12",
    seq: 12,
    timestamp: 1_200,
    source: { type: "task", id: "task-1" },
    type: "orchestrator.plan.executing",
    payload: { taskIds: ["task-1", "task-2"] },
    taskId: "task-1",
  },
  missionStatusEvent("event-13", "planning", "mission-2"),
];

const scopedProgress = summarizeMissionProgressForMission(progressEvents, "mission-1", ["task-1", "task-2"], 3, 1_200);
assert.deepEqual(
  scopedProgress.map((item) => item.text),
  [
    "Chef started coordinating 2 planned steps.",
    "Chef prepared a plan with 2 steps.",
    "Chef is planning the Mission.",
  ],
  "Simple Mode progress must use current-Mission runtime events and exclude unrelated work",
);

const recoveryEvents: UiRuntimeEvent[] = [
  taskEvent("event-20", "task.failed", { from: "running", to: "failed", error: "worker crashed" }, "task-1"),
  taskEvent("event-21", "task.running", { from: "failed", to: "running", retryCount: 1 }, "task-1"),
  taskEvent("event-22", "task.failed", { from: "running", to: "failed", error: "unrelated failure" }, "task-other"),
];
const scopedRecovery = summarizeMissionProgressForMission(recoveryEvents, "mission-1", ["task-1"], 3, 1_000);
assert.deepEqual(
  scopedRecovery.map((item) => item.text),
  ["Chef is retrying a work step (retry 1).", "A worker step failed: worker crashed"],
  "current-Mission recovery activity must stay visible without leaking unrelated failures",
);

const heartbeatEvents: UiRuntimeEvent[] = [
  missionStatusEvent("event-30", "active", "mission-heartbeat", 1_000),
  taskEvent("event-31", "task.running", { from: "assigned", to: "running", retryCount: 0 }, "task-heartbeat", 2_000),
  {
    id: "event-32",
    seq: 32,
    timestamp: 5_000,
    source: { type: "runtime", id: "session-heartbeat" },
    type: "session.data",
    payload: { data: "worker is still processing" },
    taskId: "task-heartbeat",
    sessionId: "session-heartbeat",
  },
];

assert.equal(
  deriveMissionHeartbeat(heartbeatEvents, "mission-heartbeat", ["task-heartbeat"], 14_999),
  null,
  "heartbeat must not appear before ten seconds of real runtime silence",
);

const heartbeat = deriveMissionHeartbeat(heartbeatEvents, "mission-heartbeat", ["task-heartbeat"], 15_000);
assert.ok(heartbeat);
assert.equal(heartbeat.text, "Chef is still working. Last runtime activity was 10 seconds ago.");
assert.equal(heartbeat.tone, "active");

const heartbeatProgress = summarizeMissionProgressForMission(
  heartbeatEvents,
  "mission-heartbeat",
  ["task-heartbeat"],
  3,
  17_000,
);
assert.equal(heartbeatProgress[0]?.eventType, "mission.heartbeat", "stale active work must surface a heartbeat before older activity");
assert.equal(heartbeatProgress[0]?.text, "Chef is still working. Last runtime activity was 12 seconds ago.");

const completedHeartbeatEvents = [
  ...heartbeatEvents,
  missionStatusEvent("event-33", "completed", "mission-heartbeat", 6_000),
];
assert.equal(
  deriveMissionHeartbeat(completedHeartbeatEvents, "mission-heartbeat", ["task-heartbeat"], 20_000),
  null,
  "completed Missions must never keep emitting working heartbeats",
);

const failedHeartbeatEvents = [
  ...heartbeatEvents,
  missionStatusEvent("event-34", "failed", "mission-heartbeat", 6_000),
];
assert.equal(
  deriveMissionHeartbeat(failedHeartbeatEvents, "mission-heartbeat", ["task-heartbeat"], 20_000),
  null,
  "failed Missions must surface recovery state instead of a misleading working heartbeat",
);

const statuslessRunningEvents = [
  taskEvent("event-40", "task.running", { from: "assigned", to: "running", retryCount: 0 }, "task-statusless", 1_000),
];
assert.ok(
  deriveMissionHeartbeat(statuslessRunningEvents, "mission-statusless", ["task-statusless"], 11_000),
  "a running owned worker can truthfully support a heartbeat even when mission.status has not arrived",
);

for (const terminalType of ["task.completed", "task.failed", "task.blocked"] as const) {
  const terminalEvents = [
    taskEvent("event-41", "task.running", { from: "assigned", to: "running", retryCount: 0 }, "task-statusless", 1_000),
    taskEvent("event-42", terminalType, {}, "task-statusless", 2_000),
  ];
  assert.equal(
    deriveMissionHeartbeat(terminalEvents, "mission-statusless", ["task-statusless"], 20_000),
    null,
    `${terminalType} must suppress a working heartbeat when mission.status is unavailable`,
  );
}

const crashedStatuslessEvents: UiRuntimeEvent[] = [
  taskEvent("event-43", "task.running", { from: "assigned", to: "running", retryCount: 0 }, "task-statusless", 1_000),
  {
    id: "event-44",
    seq: 44,
    timestamp: 2_000,
    source: { type: "runtime", id: "session-statusless" },
    type: "session.crashed",
    payload: { reason: "worker exited" },
    taskId: "task-statusless",
    sessionId: "session-statusless",
  },
];
assert.equal(
  deriveMissionHeartbeat(crashedStatuslessEvents, "mission-statusless", ["task-statusless"], 20_000),
  null,
  "a crashed worker session must never degrade into a misleading still-working heartbeat",
);

console.log("mission-progress-ui: ok — mounted live refresh, bounded event bursts, scoped progress, recovery, and truthful long-running heartbeat behavior are covered");
