import { strict as assert } from "node:assert";

import { sendThreadMessage } from "../web/src/threadApi.ts";
import {
  acceptedMissionSubmissionForThread,
  clearAcceptedMissionSubmission,
} from "../web/src/missionSubmissionFeedback.ts";

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new Map<string, string>([
  ["chef:view-mode", "simple"],
  ["chef:selected-thread", "thread-a"],
]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) { return storage.get(key) ?? null; },
    setItem(key: string, value: string) { storage.set(key, value); },
    removeItem(key: string) { storage.delete(key); },
  },
});

function deferredResponse() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

let requestGate = deferredResponse();
let requestStarted!: () => void;
let started = new Promise<void>((resolve) => { requestStarted = resolve; });

globalThis.fetch = async (input) => {
  const url = String(input);
  assert.match(url, /\/api\/threads\/thread-a\/chat$/, "the scenario should exercise the real Thread chat path");
  requestStarted();
  await requestGate.ready;
  return new Response(JSON.stringify({
    ok: true,
    data: {
      ok: true,
      accepted: true,
      taskIds: [],
      report: "",
      missionId: "mission-mode-race",
      threadId: "thread-a",
    },
  }), { status: 202, headers: { "content-type": "application/json" } });
};

function resetRequestGate() {
  requestGate = deferredResponse();
  started = new Promise<void>((resolve) => { requestStarted = resolve; });
}

try {
  clearAcceptedMissionSubmission("thread-a");

  storage.set("chef:view-mode", "simple");
  storage.set("chef:selected-thread", "thread-a");
  const simpleStartedRequest = sendThreadMessage("thread-a", "Create a simple todo app");
  await started;
  storage.set("chef:view-mode", "power");
  requestGate.release();
  await simpleStartedRequest;

  assert.equal(
    acceptedMissionSubmissionForThread("thread-a")?.missionId,
    "mission-mode-race",
    "a request that starts in Simple Mode must retain duplicate-submission protection even if view mode changes before the 202 settles",
  );

  clearAcceptedMissionSubmission("thread-a");
  resetRequestGate();

  storage.set("chef:view-mode", "power");
  storage.set("chef:selected-thread", "thread-a");
  const powerStartedRequest = sendThreadMessage("thread-a", "Create a simple todo app");
  await started;
  storage.set("chef:view-mode", "simple");
  requestGate.release();
  await powerStartedRequest;

  assert.equal(
    acceptedMissionSubmissionForThread("thread-a"),
    null,
    "a request that starts in Power Mode must not acquire Simple Mode duplicate-submission semantics merely because the UI mode changes before settlement",
  );

  clearAcceptedMissionSubmission("thread-a");
  resetRequestGate();

  storage.set("chef:view-mode", "simple");
  storage.set("chef:selected-thread", "thread-a");
  const switchedThreadRequest = sendThreadMessage("thread-a", "Create a simple todo app");
  await started;
  storage.set("chef:selected-thread", "thread-b");
  requestGate.release();
  await switchedThreadRequest;

  assert.equal(
    acceptedMissionSubmissionForThread("thread-a")?.missionId,
    "mission-mode-race",
    "accepted work must stay guarded by its originating Thread even when the user switches Threads before the acknowledgement settles",
  );
} finally {
  clearAcceptedMissionSubmission("thread-a");
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}

console.log("thread-submission-mode-race: ok — submission guard ownership is fixed at request start");
