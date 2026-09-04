import { strict as assert } from "node:assert";

import {
  acceptedMissionSubmissionIsPending,
  clearMissionSubmissionFailure,
  missionSubmissionAccepted,
  missionSubmissionAcknowledgement,
  missionSubmissionFailureRecovery,
  missionSubmissionStarted,
  missionSubmissionSucceeded,
  rememberMissionSubmissionFailure,
  takeMissionSubmissionFailure,
} from "../web/src/missionSubmissionFeedback.ts";

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

console.log("Simple Mode submission feedback behavior passed.");
