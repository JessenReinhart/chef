import { strict as assert } from "node:assert";

import { Api } from "../web/src/api.ts";
import {
  acceptedMissionSubmissionForThread,
  acceptedMissionSubmissionIsPending,
  clearAcceptedMissionSubmission,
  clearMissionSubmissionFailure,
  missionSubmissionAccepted,
  missionSubmissionAcknowledgement,
  missionSubmissionFailureRecovery,
  missionSubmissionStarted,
  missionSubmissionSucceeded,
  observeAcceptedMissionSubmission,
  rememberAcceptedMissionSubmission,
  rememberMissionSubmissionFailure,
  takeMissionSubmissionFailure,
} from "../web/src/missionSubmissionFeedback.ts";
import { isThreadSubmissionPending } from "../web/src/threadSelection.ts";

const acknowledgement = missionSubmissionAcknowledgement();

assert.equal(
  acknowledgement,
  "Got it. I’m starting this now.",
  "Simple Mode must acknowledge a submitted request immediately with a concrete starting state",
);
assert.doesNotMatch(
  acknowledgement,
  /\b(team|crew|squad|worker|planner|planning|route|routing)\b/i,
  "the immediate acknowledgement must not claim an execution shape before durable routing evidence exists",
);

const submittedText = "Create a simple todo app";
const started = missionSubmissionStarted(submittedText);
assert.deepEqual(
  started,
  {
    input: "",
    optimisticGoal: submittedText,
    chefNote: "Got it. I’m starting this now.",
  },
  "starting Simple Mode work must immediately clear the composer, preserve the visible goal, and acknowledge receipt before durable work exists",
);

const accepted = missionSubmissionAccepted("thread-a", "mission-a", submittedText);
assert.deepEqual(
  accepted,
  { threadId: "thread-a", missionId: "mission-a", goal: submittedText },
  "the HTTP acknowledgement must preserve the exact Thread, Mission, and goal ownership needed for the provisional starting state",
);
assert.equal(
  acceptedMissionSubmissionIsPending(accepted, "thread-a", []),
  true,
  "accepted work must remain visibly pending for its owning Thread until authoritative Mission state catches up",
);
assert.equal(
  acceptedMissionSubmissionIsPending(accepted, "thread-b", []),
  false,
  "accepted work must not leak its provisional starting state into another Thread",
);
assert.equal(
  acceptedMissionSubmissionIsPending(accepted, "thread-a", [{ id: "mission-a" }]),
  false,
  "the provisional starting state must retire as soon as authoritative Mission state contains the accepted Mission",
);

rememberAcceptedMissionSubmission(accepted);
assert.deepEqual(
  acceptedMissionSubmissionForThread("thread-a"),
  accepted,
  "accepted Mission ownership must survive a Simple Mode surface remount",
);
assert.equal(
  isThreadSubmissionPending(new Set(), "thread-a"),
  true,
  "the owning Thread must stay single-flight after the immediate HTTP request itself has settled",
);
assert.equal(
  isThreadSubmissionPending(new Set(), "thread-b"),
  false,
  "an accepted Mission must not block submissions in another Thread",
);
observeAcceptedMissionSubmission("thread-a", [{ id: "older-mission" }]);
assert.equal(
  isThreadSubmissionPending(new Set(), "thread-a"),
  true,
  "an unrelated Mission snapshot must not retire the exact accepted-Mission guard",
);
observeAcceptedMissionSubmission("thread-a", [{ id: "mission-a" }]);
assert.equal(
  isThreadSubmissionPending(new Set(), "thread-a"),
  false,
  "the accepted-Mission guard must retire only when authoritative state contains that Mission id",
);

const successful = missionSubmissionSucceeded("  Mission started.  ");
assert.deepEqual(
  successful,
  {
    input: "",
    optimisticGoal: "",
    chefNote: "Mission started.",
  },
  "a successful start must retire optimistic submission state once the server has a truthful report",
);
assert.deepEqual(
  missionSubmissionSucceeded("   "),
  { input: "", optimisticGoal: "", chefNote: null },
  "a successful start without a server report must not preserve a stale optimistic acknowledgement once authoritative work is visible",
);

const reportedFailure = missionSubmissionFailureRecovery(submittedText, "Provider unavailable");
assert.deepEqual(
  reportedFailure,
  {
    input: submittedText,
    optimisticGoal: "",
    chefNote: "Provider unavailable",
  },
  "a rejected start must remove the optimistic mission, restore the request, and preserve the truthful failure",
);

const fallbackFailure = missionSubmissionFailureRecovery(submittedText, "   ");
assert.deepEqual(
  fallbackFailure,
  {
    input: submittedText,
    optimisticGoal: "",
    chefNote: "I couldn't start that work yet. Your request is ready to try again.",
  },
  "failed starts without a useful report must remain retryable with a clear fallback message",
);

const threadAKey = "thread-a";
const threadBKey = "thread-b";
rememberMissionSubmissionFailure(threadAKey, reportedFailure);
assert.equal(
  takeMissionSubmissionFailure(threadBKey),
  null,
  "a failure that completes off-foreground must not leak into another Thread",
);
assert.deepEqual(
  takeMissionSubmissionFailure(threadAKey),
  reportedFailure,
  "the owning Thread must recover its exact retry text and truthful failure after a remount",
);
assert.deepEqual(
  takeMissionSubmissionFailure(threadAKey),
  reportedFailure,
  "the outgoing Thread surface must not consume retry state before the remounted owning surface can read it",
);
clearMissionSubmissionFailure(threadAKey);
assert.equal(
  takeMissionSubmissionFailure(threadAKey),
  null,
  "starting the next submission must clear prior retry state so stale failure UI cannot resurrect later",
);

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

let stateMissions: Array<Record<string, unknown>> = [];
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/api/threads/thread-a/chat")) {
    return new Response(JSON.stringify({
      ok: true,
      data: {
        ok: true,
        accepted: true,
        taskIds: [],
        report: "",
        missionId: "mission-live",
        threadId: "thread-a",
      },
    }), { status: 202, headers: { "content-type": "application/json" } });
  }
  if (url.endsWith("/api/state")) {
    return new Response(JSON.stringify({
      tasks: [],
      sessions: [],
      approvals: [],
      canvasNodes: [],
      canvasEdges: [],
      missions: stateMissions,
      automations: [],
      events: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected request ${url}`);
};

try {
  clearAcceptedMissionSubmission("thread-a");
  const api = new Api();
  const result = await api.chat(submittedText);
  assert.equal(result.missionId, "mission-live", "the immediate chat acknowledgement must expose its durable Mission id");
  assert.equal(
    isThreadSubmissionPending(new Set(), "thread-a"),
    true,
    "the real API acknowledgement path must keep the composer guarded after the POST has settled",
  );

  await api.stateRaw();
  assert.equal(
    isThreadSubmissionPending(new Set(), "thread-a"),
    true,
    "a successful state refresh that has not caught up to the accepted Mission must keep the guard active",
  );

  stateMissions = [{
    id: "mission-live",
    goal: submittedText,
    status: "planning",
    taskIds: [],
    metadata: { threadId: "thread-a" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }];
  await api.stateRaw();
  assert.equal(
    isThreadSubmissionPending(new Set(), "thread-a"),
    false,
    "the real state projection must release the guard once the exact acknowledged Mission is authoritative",
  );
} finally {
  clearAcceptedMissionSubmission("thread-a");
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}

console.log("Simple Mode submission feedback behavior passed.");
