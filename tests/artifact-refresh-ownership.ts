import { strict as assert } from "node:assert";
import { createInvalidationOwnedRefreshQueue } from "../web/src/invalidationOwnedRefresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const pending = new Map<number, ReturnType<typeof deferred<string>>>();
const visible: string[] = [];
let loads = 0;
const queue = createInvalidationOwnedRefreshQueue(async (isCurrent) => {
  const loadNumber = ++loads;
  const result = deferred<string>();
  pending.set(loadNumber, result);
  const snapshot = await result.promise;
  if (isCurrent()) visible.push(snapshot);
});

queue.trigger();
await Promise.resolve();
assert.equal(loads, 1, "initial result loading should start one authoritative read");

queue.trigger();
queue.trigger();
pending.get(1)!.resolve("stale-result-v1");
await nextTurn();
assert.deepEqual(visible, [], "a newer same-Thread invalidation must suppress the superseded in-flight result");
assert.equal(loads, 2, "multiple invalidations while busy should converge through one trailing result read");

pending.get(2)!.resolve("result-v2");
await nextTurn();
assert.deepEqual(visible, ["result-v2"], "the trailing authoritative result must become visible after stale work is discarded");

queue.trigger();
await Promise.resolve();
assert.equal(loads, 3, "settled result refreshes must remain refreshable");
queue.close();
pending.get(3)!.resolve("late-after-unmount");
await nextTurn();
assert.deepEqual(visible, ["result-v2"], "closing Simple Mode must prevent a late result read from applying");

queue.trigger();
await nextTurn();
assert.equal(loads, 3, "closed result refresh ownership must ignore later invalidations");

console.log("artifact-refresh-ownership: ok");
