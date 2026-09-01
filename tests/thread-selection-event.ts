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

const { SELECTED_THREAD_EVENT, loadSelectedThreadId, saveSelectedThreadId } = await import("../web/src/threadApi.ts");
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

console.log("thread-selection-event: ok — Simple Mode selection changes signal immediately without disturbing Power Mode");
