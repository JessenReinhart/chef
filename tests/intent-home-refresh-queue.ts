import { strict as assert } from "node:assert";

import { loadIntentHomeRefresh } from "../web/src/intentHomeRefresh.ts";
import { createMissionProgressRefreshQueue } from "../web/src/missionProgressStream.ts";
import type { UiThread } from "../web/src/threadApi.ts";
import type { ChatMessage } from "../web/src/types.ts";

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
const history = deferred<ChatMessage[]>();
const coreApplied = deferred<void>();
let visibleRuntimeMarker: string | null = null;
let fullRefreshSettled = false;
const refreshWithSlowHistory = loadIntentHomeRefresh({
  loadSnapshot: async () => ({ marker: "worker-running" }),
  loadThreads: async () => [selectedThread],
  rememberedThreadId: () => selectedThread.id,
  loadMessages: () => history.promise,
  onCore: ({ snapshot }) => {
    visibleRuntimeMarker = snapshot.marker;
    coreApplied.resolve();
  },
});
refreshWithSlowHistory.then(
  () => { fullRefreshSettled = true; },
  () => { fullRefreshSettled = true; },
);

await coreApplied.promise;
assert.equal(
  visibleRuntimeMarker,
  "worker-running",
  "Simple Mode must publish fresh Mission/task/event state before selected Thread history settles",
);
await Promise.resolve();
assert.equal(
  fullRefreshSettled,
  false,
  "conversation history may remain pending after runtime progress has already become visible",
);

const todoHistory = [{ role: "assistant", content: "Todo app is still running", timestamp: 2 }] as ChatMessage[];
history.resolve(todoHistory);
const completedRefresh = await refreshWithSlowHistory;
assert.deepEqual(completedRefresh.messages, todoHistory, "selected Thread history must still join the refresh once it becomes available");

const failingHistory = deferred<ChatMessage[]>();
const failingCoreApplied = deferred<void>();
let runtimePublishedBeforeHistoryFailure = false;
const refreshWithFailedHistory = loadIntentHomeRefresh({
  loadSnapshot: async () => ({ marker: "verifying" }),
  loadThreads: async () => [selectedThread],
  rememberedThreadId: () => selectedThread.id,
  loadMessages: () => failingHistory.promise,
  onCore: ({ snapshot }) => {
    runtimePublishedBeforeHistoryFailure = snapshot.marker === "verifying";
    failingCoreApplied.resolve();
  },
});

await failingCoreApplied.promise;
failingHistory.reject(new Error("Thread history unavailable"));
await assert.rejects(refreshWithFailedHistory, /Thread history unavailable/);
assert.equal(
  runtimePublishedBeforeHistoryFailure,
  true,
  "a conversation-history failure must not discard the successful runtime progress refresh that preceded it",
);

let historyCallsWithoutThread = 0;
const noThreadRefresh = await loadIntentHomeRefresh({
  loadSnapshot: async () => ({ marker: "ready" }),
  loadThreads: async () => [],
  rememberedThreadId: () => null,
  loadMessages: async () => {
    historyCallsWithoutThread += 1;
    return [];
  },
  onCore: () => undefined,
});
assert.equal(historyCallsWithoutThread, 0, "a workspace with no selected Thread must not manufacture a conversation-history read");
assert.deepEqual(noThreadRefresh.messages, [], "no selected Thread should yield empty conversation history normally");

console.log("intent-home-refresh-queue: ok");
