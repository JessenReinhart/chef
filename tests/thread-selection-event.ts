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
const unsubscribeProgress = subscribeMissionProgressProjection(
  async () => {
    progressLoads += 1;
    activeProgressLoads += 1;
    maxConcurrentProgressLoads = Math.max(maxConcurrentProgressLoads, activeProgressLoads);
    if (progressLoads === 1) await firstProgressLoad;
    const projection = loadSelectedThreadId() === "thread-progress-active" ? ["Chef is working in Thread A"] : [];
    activeProgressLoads -= 1;
    return projection;
  },
  (projection) => { projectedProgress = projection; },
  () => progressStream,
  eventTarget,
);
await Promise.resolve();
assert.equal(progressLoads, 1, "mounting Mission progress should start one authoritative projection load");

saveSelectedThreadId("thread-progress-quiet");
assert.equal(
  progressLoads,
  1,
  "a Thread switch during a slow progress refresh must queue rather than start a concurrent state load",
);
releaseFirstProgressLoad();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(progressLoads, 2, "the Thread-selection invalidation must run one trailing authoritative refresh after the slow load settles");
assert.equal(maxConcurrentProgressLoads, 1, "runtime and Thread-selection invalidations must share the same single-flight refresh budget");
assert.deepEqual(
  projectedProgress,
  [],
  "switching to a quiet Thread must clear the previous Thread's progress without waiting for runtime SSE",
);

unsubscribeProgress();
const loadsBeforeUnmountedSelection = progressLoads;
saveSelectedThreadId("thread-progress-after-unmount");
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(progressLoads, loadsBeforeUnmountedSelection, "unmounted Mission progress must stop reacting to Thread-selection changes");
assert.equal(progressStreamClosed, true, "unmounting Mission progress must release its runtime stream alongside the selection listener");

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

console.log("thread-selection-event: ok — Simple Mode selection changes immediately re-scope Mission progress and stale history without disturbing Power Mode");
