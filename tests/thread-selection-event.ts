import { strict as assert } from "node:assert";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
const eventTarget = new EventTarget();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: eventTarget });

const { SELECTED_THREAD_EVENT, loadSelectedThreadId, saveSelectedThreadId, threadMessages } = await import("../web/src/threadApi.ts");
const { subscribeMissionProgressProjection } = await import("../web/src/missionProgressStream.ts");
const { subscribeChatHistoryProjection } = await import("../web/src/chatHistoryProjection.ts");
const { createChatSubmissionOwnership, settleOwnedChatSubmission } = await import("../web/src/chatSubmissionOwnership.ts");
const observed: Array<string | null> = [];
eventTarget.addEventListener(SELECTED_THREAD_EVENT, (event) => {
  observed.push((event as CustomEvent<{ threadId: string | null }>).detail.threadId);
});

storage.setItem("chef:view-mode", "simple");
saveSelectedThreadId("thread-a");
assert.equal(loadSelectedThreadId(), "thread-a", "Simple Mode should persist the selected Thread");
assert.deepEqual(observed, ["thread-a"], "Simple Mode must emit a synchronous selection signal so stale Thread-scoped UI can invalidate immediately");

saveSelectedThreadId("thread-a");
assert.deepEqual(observed, ["thread-a"], "re-selecting the same Thread must not emit duplicate invalidations");

storage.setItem("chef:view-mode", "power");
saveSelectedThreadId("thread-b");
assert.equal(loadSelectedThreadId(), "thread-b", "Power Mode may preserve Thread continuity for the next Simple Mode visit");
assert.deepEqual(observed, ["thread-a"], "Power Mode must not emit the Simple Mode invalidation signal or disturb workspace-global presentation");

storage.setItem("chef:view-mode", "simple");
saveSelectedThreadId("thread-c");
assert.deepEqual(observed, ["thread-a", "thread-c"], "returning to Simple Mode should restore immediate Thread-selection invalidation");

saveSelectedThreadId("thread-progress-active");
let progressLoads = 0;
let activeProgressLoads = 0;
let maxConcurrentProgressLoads = 0;
let projectedProgress: string[] = ["stale progress"];
let progressStreamClosed = false;
let releaseFirstProgressLoad!: () => void;
const firstProgressLoad = new Promise<void>((resolve) => { releaseFirstProgressLoad = resolve; });
const progressStream = {
  onmessage: null as ((event: MessageEvent) => void) | null,
  close() { progressStreamClosed = true; },
};
let heartbeatTick: (() => void) | null = null;
let heartbeatTimerCancelled = false;
let heartbeatVisible = false;
const unsubscribeProgress = subscribeMissionProgressProjection(
  async () => {
    progressLoads += 1;
    activeProgressLoads += 1;
    maxConcurrentProgressLoads = Math.max(maxConcurrentProgressLoads, activeProgressLoads);
    if (progressLoads === 1) await firstProgressLoad;
    const projection = loadSelectedThreadId() === "thread-progress-active"
      ? ["Chef is working in Thread A"]
      : heartbeatVisible
        ? ["Chef is still working"]
        : [];
    activeProgressLoads -= 1;
    return projection;
  },
  (projection) => { projectedProgress = projection; },
  () => progressStream,
  eventTarget,
  (onTick) => {
    heartbeatTick = onTick;
    return () => {
      heartbeatTimerCancelled = true;
      heartbeatTick = null;
    };
  },
);
await Promise.resolve();
assert.equal(progressLoads, 1, "mounting Mission progress should start one authoritative projection load");

heartbeatTick?.();
assert.equal(
  progressLoads,
  1,
  "a heartbeat refresh during a slow progress read must queue rather than start a concurrent state load",
);
saveSelectedThreadId("thread-progress-quiet");
assert.equal(
  progressLoads,
  1,
  "a Thread switch during a slow progress refresh must queue rather than start a concurrent state load",
);
releaseFirstProgressLoad();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(progressLoads, 2, "timer and Thread-selection invalidations must coalesce into one trailing authoritative refresh after the slow load settles");
assert.equal(maxConcurrentProgressLoads, 1, "runtime, timer, and Thread-selection invalidations must share the same single-flight refresh budget");
assert.deepEqual(
  projectedProgress,
  [],
  "switching to a quiet Thread must clear the previous Thread's progress without waiting for runtime SSE",
);

heartbeatVisible = true;
heartbeatTick?.();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(progressLoads, 3, "silent elapsed heartbeat time must trigger a fresh authoritative projection even when SSE emits nothing");
assert.deepEqual(
  projectedProgress,
  ["Chef is still working"],
  "the periodic invalidation must let a time-based heartbeat become visible without unrelated runtime events",
);

const tickBeforeUnmount = heartbeatTick;
unsubscribeProgress();
assert.equal(heartbeatTimerCancelled, true, "unmounting Mission progress must cancel its periodic heartbeat refresh");
const loadsBeforeUnmountedSelection = progressLoads;
tickBeforeUnmount?.();
saveSelectedThreadId("thread-progress-after-unmount");
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(progressLoads, loadsBeforeUnmountedSelection, "unmounted Mission progress must stop reacting to timer and Thread-selection changes");
assert.equal(progressStreamClosed, true, "unmounting Mission progress must release its runtime stream alongside the selection listener");

// ChatPanel history uses the same synchronous selection signal but owns its own
// asynchronous read. The old conversation must disappear immediately and a slow
// previous Thread read must never overwrite the newly selected history.
saveSelectedThreadId("thread-chat-a");
let projectedHistory = ["stale Thread history"];
let historyClearCount = 0;
const historyResolvers: Array<(history: string[]) => void> = [];
const historyLoads: string[] = [];
const unsubscribeChatHistory = subscribeChatHistoryProjection(
  () => {
    const requestedThread = loadSelectedThreadId() ?? "none";
    historyLoads.push(requestedThread);
    return new Promise<string[]>((resolve) => historyResolvers.push(resolve));
  },
  (history) => { projectedHistory = history; },
  () => {
    historyClearCount += 1;
    projectedHistory = [];
  },
  eventTarget,
);
await Promise.resolve();
assert.deepEqual(historyLoads, ["thread-chat-a"], "mounting chat history should load the foreground Thread");
assert.deepEqual(projectedHistory, [], "mounting the projection must not retain unrelated rendered history");

saveSelectedThreadId("thread-chat-b");
await Promise.resolve();
assert.deepEqual(projectedHistory, [], "changing Threads must synchronously clear the previous conversation before the new read settles");
assert.deepEqual(historyLoads, ["thread-chat-a", "thread-chat-b"], "changing Threads must start a fresh history read for the new foreground selection");

historyResolvers[0]?.(["Thread A message"]);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual(projectedHistory, [], "a late history response from the previous Thread must not commit after selection changes");
historyResolvers[1]?.(["Thread B message"]);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual(projectedHistory, ["Thread B message"], "the newest foreground Thread history should commit normally");
assert.equal(historyClearCount, 2, "history should clear once on mount and once for the actual Thread change");

unsubscribeChatHistory();
const historyLoadsBeforeUnmount = historyLoads.length;
saveSelectedThreadId("thread-chat-after-unmount");
await Promise.resolve();
assert.equal(historyLoads.length, historyLoadsBeforeUnmount, "unmounted chat history must stop reacting to foreground Thread changes");

// In-flight chat POST settlement must obey the same foreground ownership. Thread A
// can keep executing server-side, but its late UI success/failure/finally callbacks
// must never land in Thread B or release Thread B's newer submission state.
saveSelectedThreadId("thread-submit-a");
let submissionInvalidations = 0;
const submissionEvents: string[] = [];
const ownership = createChatSubmissionOwnership(
  () => {
    submissionInvalidations += 1;
    submissionEvents.push("selection-released");
  },
  eventTarget,
);
let resolveA!: (value: string) => void;
const operationA = new Promise<string>((resolve) => { resolveA = resolve; });
const submissionA = settleOwnedChatSubmission(
  ownership,
  () => operationA,
  {
    onSuccess: (value) => submissionEvents.push(`A-success:${value}`),
    onFailure: () => submissionEvents.push("A-failure"),
    onSettled: () => submissionEvents.push("A-settled"),
  },
);

saveSelectedThreadId("thread-submit-b");
assert.equal(submissionInvalidations, 1, "switching Threads must immediately release the newly selected composer from the previous submission");
let resolveB!: (value: string) => void;
const operationB = new Promise<string>((resolve) => { resolveB = resolve; });
const submissionB = settleOwnedChatSubmission(
  ownership,
  () => operationB,
  {
    onSuccess: (value) => submissionEvents.push(`B-success:${value}`),
    onFailure: () => submissionEvents.push("B-failure"),
    onSettled: () => submissionEvents.push("B-settled"),
  },
);

resolveA("late Thread A acknowledgement");
await submissionA;
assert.deepEqual(
  submissionEvents,
  ["selection-released"],
  "late success and settlement from the previous Thread must not mutate or release the foreground Thread",
);

resolveB("Thread B acknowledgement");
await submissionB;
assert.deepEqual(
  submissionEvents,
  ["selection-released", "B-success:Thread B acknowledgement", "B-settled"],
  "the newest foreground Thread submission must settle normally after an older request finishes",
);

let rejectSameThread!: (reason: unknown) => void;
const sameThreadFailure = new Promise<string>((_resolve, reject) => { rejectSameThread = reject; });
const submissionFailure = settleOwnedChatSubmission(
  ownership,
  () => sameThreadFailure,
  {
    onSuccess: () => submissionEvents.push("unexpected-success"),
    onFailure: (error) => submissionEvents.push(`B-failure:${error instanceof Error ? error.message : String(error)}`),
    onSettled: () => submissionEvents.push("B-failure-settled"),
  },
);
rejectSameThread(new Error("network unavailable"));
await submissionFailure;
assert.deepEqual(
  submissionEvents.slice(-2),
  ["B-failure:network unavailable", "B-failure-settled"],
  "same-Thread submission failures must still surface and release the composer normally",
);
ownership.dispose();
const invalidationsBeforeDisposedSelection = submissionInvalidations;
saveSelectedThreadId("thread-submit-after-dispose");
assert.equal(submissionInvalidations, invalidationsBeforeDisposedSelection, "unmounted submission ownership must stop reacting to Thread selection");

// IntentHome waits for Thread history before committing its refreshed Mission,
// Task, event, approval, and message projections. If the foreground Thread
// changes during that await, the old refresh must fail before any of those
// stale projections can be committed.
const originalFetch = globalThis.fetch;
let resolveHistory: ((response: Response) => void) | null = null;
globalThis.fetch = async () => new Promise<Response>((resolve) => {
  resolveHistory = resolve;
});

saveSelectedThreadId("thread-race-a");
const staleHistory = threadMessages("thread-race-a");
saveSelectedThreadId("thread-race-b");
resolveHistory?.(new Response(JSON.stringify({
  ok: true,
  data: [{ role: "assistant", content: "Thread A is still working", timestamp: 10 }],
}), { status: 200, headers: { "content-type": "application/json" } }));
await assert.rejects(
  staleHistory,
  /Thread selection changed while history was loading/,
  "a history request that crosses a Simple Mode Thread switch must stop the stale refresh transaction",
);

const selectedMessages = [{ role: "assistant", content: "Thread B is working", timestamp: 11 }];
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, data: selectedMessages }), {
  status: 200,
  headers: { "content-type": "application/json" },
});
await assert.rejects(
  threadMessages("thread-race-a"),
  /Thread selection changed while history was loading/,
  "history that is already stale when its request starts must not commit into the current foreground Thread",
);
assert.deepEqual(
  await threadMessages("thread-race-b"),
  selectedMessages,
  "history for the unchanged foreground Thread must still complete normally",
);
globalThis.fetch = originalFetch;

console.log("thread-selection-event: ok — Simple Mode selection re-scopes Mission progress, Chat history, and in-flight chat settlement without stale cross-Thread commits");
