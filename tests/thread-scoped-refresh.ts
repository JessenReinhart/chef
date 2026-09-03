import { strict as assert } from "node:assert";
import { loadForSelectedThread } from "../web/src/threadScopedRefresh.ts";

let selectedThreadId: string | null = "thread-a";
let resolveState: ((value: { marker: string }) => void) | null = null;
const delayedState = new Promise<{ marker: string }>((resolve) => {
  resolveState = resolve;
});

const staleRefresh = loadForSelectedThread(
  "thread-a",
  () => selectedThreadId,
  () => delayedState,
);

selectedThreadId = "thread-b";
resolveState?.({ marker: "thread-a-state" });
assert.deepEqual(
  await staleRefresh,
  { current: false },
  "a slow Simple Mode activity read must be discarded after the foreground Thread changes",
);

let currentLoads = 0;
const currentRefresh = await loadForSelectedThread(
  "thread-b",
  () => selectedThreadId,
  async () => {
    currentLoads += 1;
    return { marker: "thread-b-state" };
  },
);
assert.deepEqual(
  currentRefresh,
  { current: true, value: { marker: "thread-b-state" } },
  "the selected Thread should still receive its own authoritative activity snapshot",
);
assert.equal(currentLoads, 1, "a current activity refresh should perform exactly one authoritative read");

selectedThreadId = null;
const workspaceRefresh = await loadForSelectedThread(
  null,
  () => selectedThreadId,
  async () => ({ marker: "workspace-state" }),
);
assert.deepEqual(
  workspaceRefresh,
  { current: true, value: { marker: "workspace-state" } },
  "workspace-level activity should remain valid when no Thread is selected",
);

console.log("thread-scoped-refresh: ok — slow activity snapshots cannot cross the Simple Mode foreground Thread boundary");
