import { strict as assert } from "node:assert";

import { loadIntentHomeRefresh } from "../web/src/intentHomeRefresh.ts";
import { createMissionProgressRefreshQueue } from "../web/src/missionProgressStream.ts";
import type { UiThread } from "../web/src/threadApi.ts";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let releaseFirst!: () => void;
const firstRefresh = new Promise<void>((resolve) => { releaseFirst = resolve; });
let refreshCount = 0;
const appliedVersions: number[] = [];
const queue = createMissionProgressRefreshQueue(async () => {
  const version = ++refreshCount;
  if (version === 1) await firstRefresh;
  appliedVersions.push(version);
});

queue.trigger();
await Promise.resolve();
queue.trigger();
queue.trigger();
assert.equal(refreshCount, 1, "Intent Home refresh bursts must never start a second composite read while the first is still active");

releaseFirst();
await nextTurn();
assert.equal(refreshCount, 2, "a refresh requested during the active read must produce one fresh trailing read");
assert.deepEqual(appliedVersions, [1, 2], "composite refreshes must settle in invocation order so older progress cannot overwrite newer progress");
queue.close();

let rejectFirst!: (reason: Error) => void;
const failingRefresh = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
let recoveryRefreshCount = 0;
let recoveryApplied = false;
const recoveryQueue = createMissionProgressRefreshQueue(async () => {
  recoveryRefreshCount += 1;
  if (recoveryRefreshCount === 1) await failingRefresh;
  else recoveryApplied = true;
});

recoveryQueue.trigger();
await Promise.resolve();
recoveryQueue.trigger();
assert.equal(recoveryRefreshCount, 1, "recovery refresh must remain queued while a failed composite read is unresolved");

rejectFirst(new Error("temporary workspace refresh failure"));
await nextTurn();
assert.equal(recoveryRefreshCount, 2, "a failed refresh must release the queue and run the requested trailing recovery read");
assert.equal(recoveryApplied, true, "the trailing recovery refresh must be allowed to converge Intent Home back to authoritative state");
recoveryQueue.close();

const selectedThread: UiThread = {
  id: "thread-todo",
  workspaceId: "workspace-a",
  title: "Todo app",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
};

// Model the production boundary: runtime state goes through the bounded refresh
// queue, while selected-Thread conversation history is explicitly launched in
// the background after the core snapshot is published.
const slowHistory = deferred<void>();
let runtimeVersion = 0;
const visibleRuntimeMarkers: string[] = [];
let backgroundHistoryStarts = 0;
const progressQueue = createMissionProgressRefreshQueue(async () => {
  const version = ++runtimeVersion;
  const core = await loadIntentHomeRefresh({
    loadSnapshot: async () => ({ marker: version === 1 ? "worker-running" : "verifying" }),
    loadThreads: async () => [selectedThread],
    rememberedThreadId: () => selectedThread.id,
  });
  visibleRuntimeMarkers.push(core.snapshot.marker);
  backgroundHistoryStarts += 1;
  void slowHistory.promise.catch(() => undefined);
});

progressQueue.trigger();
await nextTurn();
assert.deepEqual(
  visibleRuntimeMarkers,
  ["worker-running"],
  "Simple Mode must publish fresh Mission/task/event state without waiting for selected Thread history",
);
assert.equal(backgroundHistoryStarts, 1, "the selected Thread history refresh may still start after runtime state is published");

progressQueue.trigger();
await nextTurn();
assert.deepEqual(
  visibleRuntimeMarkers,
  ["worker-running", "verifying"],
  "a still-pending conversation history request must not occupy the heartbeat queue or block the next runtime snapshot",
);
assert.equal(backgroundHistoryStarts, 2, "later heartbeat refreshes may independently refresh conversation history without blocking progress");

slowHistory.reject(new Error("Thread history unavailable"));
await nextTurn();
progressQueue.trigger();
await nextTurn();
assert.equal(
  visibleRuntimeMarkers.length,
  3,
  "a conversation-history failure must not poison later authoritative runtime progress refreshes",
);
progressQueue.close();

const noThreadRefresh = await loadIntentHomeRefresh({
  loadSnapshot: async () => ({ marker: "ready" }),
  loadThreads: async () => [],
  rememberedThreadId: () => null,
});
assert.equal(noThreadRefresh.selection.selectedThread, null, "a workspace with no Threads must resolve without inventing a conversation owner");
assert.equal(noThreadRefresh.snapshot.marker, "ready", "runtime state remains available even when no conversation history exists");

console.log("intent-home-refresh-queue: ok");
