import { strict as assert } from "node:assert";
import { Api } from "../web/src/api.ts";
import {
  dismissVisibleAppError,
  stateRefreshErrorMessage,
  visibleAppError,
} from "../web/src/appErrorProjection.ts";

let stateRefreshError: string | null = null;
let actionError: string | null = null;

stateRefreshError = stateRefreshErrorMessage(new Error("Current workspace is temporarily unavailable"));
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  "Current workspace is temporarily unavailable",
  "a failed authoritative state refresh should remain visible while the refresh is failing",
);

stateRefreshError = null;
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  null,
  "a successful authoritative state refresh should retire the refresh-owned warning automatically",
);

actionError = "Could not retry node";
stateRefreshError = stateRefreshErrorMessage(new Error("Failed to load state"));
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  actionError,
  "an explicit user-action failure should remain the visible error even if background polling also fails",
);

stateRefreshError = null;
assert.equal(
  visibleAppError(actionError, stateRefreshError),
  actionError,
  "successful background polling must not clear an unrelated user-action failure",
);

stateRefreshError = "Failed to load state";
let dismissed = dismissVisibleAppError(actionError, stateRefreshError);
assert.equal(dismissed.actionError, null, "dismissing the visible action failure should clear only that action error");
assert.equal(dismissed.stateRefreshError, stateRefreshError, "a hidden refresh warning should retain its own lifecycle");

dismissed = dismissVisibleAppError(dismissed.actionError, dismissed.stateRefreshError);
assert.equal(dismissed.stateRefreshError, null, "once visible, the refresh warning can be dismissed independently");

assert.equal(stateRefreshErrorMessage("unknown"), "Failed to load state");

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  } satisfies Storage,
});

const snapshot = {
  tasks: [],
  canvasNodes: [],
  canvasEdges: [],
  missions: [],
  automations: [],
  events: [],
  approvals: [],
  sessions: [],
};
let fetchCalls = 0;
let releaseFirst: (() => void) | null = null;

try {
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    const call = fetchCalls;
    if (call === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return {
      ok: true,
      json: async () => ({ ...snapshot, events: [{ id: `state-${call}` }] }),
    } as Response;
  }) as typeof fetch;

  const client = new Api();
  const first = client.stateRaw();
  await Promise.resolve();
  const second = client.stateRaw();
  const third = client.stateRaw();
  await Promise.resolve();

  assert.equal(fetchCalls, 1, "overlapping state refreshes must keep only one request active");
  assert.ok(releaseFirst, "the first state request should be waiting in the controlled fixture");
  releaseFirst();

  const firstSnapshot = await first;
  assert.equal(firstSnapshot.events[0]?.id, "state-1");
  await Promise.resolve();
  assert.equal(fetchCalls, 2, "a burst during the active request should schedule exactly one trailing refresh");

  const [secondSnapshot, thirdSnapshot] = await Promise.all([second, third]);
  assert.equal(secondSnapshot.events[0]?.id, "state-2");
  assert.equal(thirdSnapshot.events[0]?.id, "state-2");
  assert.equal(fetchCalls, 2, "all overlapping followers should share the same trailing authoritative refresh");

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("temporary state failure");
  }) as typeof fetch;
  await assert.rejects(client.stateRaw(), /temporary state failure/);

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => snapshot,
    } as Response;
  }) as typeof fetch;
  await client.stateRaw();
  assert.equal(fetchCalls, 4, "a failed bounded refresh must release the queue so the next recovery read can run");

  storage.set("chef:selected-thread", "thread-a");
  let releaseThreadSwitch: (() => void) | null = null;
  globalThis.fetch = (async () => {
    await new Promise<void>((resolve) => {
      releaseThreadSwitch = resolve;
    });
    return {
      ok: true,
      json: async () => ({
        ...snapshot,
        missions: [
          { id: "mission-a", taskIds: [], metadata: { threadId: "thread-a" } },
          { id: "mission-b", taskIds: [], metadata: { threadId: "thread-b" } },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  const switchingSnapshot = client.stateRaw();
  await Promise.resolve();
  assert.ok(releaseThreadSwitch, "the thread-switch fixture should hold the authoritative state response open");
  storage.set("chef:selected-thread", "thread-b");
  releaseThreadSwitch();

  const settledAfterSwitch = await switchingSnapshot;
  assert.deepEqual(
    settledAfterSwitch.missions?.map((mission) => mission.id),
    ["mission-b"],
    "a slow authoritative response must be projected to the Thread selected when it settles, not the stale Thread selected when it started",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
}

console.log("app error recovery behavior passed");
