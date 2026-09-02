import { strict as assert } from "node:assert";

import {
  missionSubmissionAcknowledgement,
  missionSubmissionFailureRecovery,
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
assert.equal(
  takeMissionSubmissionFailure(threadAKey),
  null,
  "restored failure state must be consumed once so a later successful retry cannot resurrect stale failure UI",
);

console.log("Simple Mode submission feedback behavior passed.");
