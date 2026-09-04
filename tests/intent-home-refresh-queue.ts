import { strict as assert } from "node:assert";

import { createMissionProgressRefreshQueue } from "../web/src/missionProgressStream.ts";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

console.log("intent-home-refresh-queue: ok");
