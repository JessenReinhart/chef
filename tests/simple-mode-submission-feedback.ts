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
const hiddenFailure = rememberMissionSubmissionFailure(new Map(), threadAKey, reportedFailure);
assert.equal(
  hiddenFailure.get(threadAKey)?.input,
  submittedText,
  "a failure that completes off-foreground must stay owned by the Thread that submitted it",
);
assert.equal(
  hiddenFailure.get(threadBKey),
  undefined,
  "an off-foreground failure must not leak into the currently selected Thread",
);

const wrongThreadRead = takeMissionSubmissionFailure(hiddenFailure, threadBKey);
assert.equal(
  wrongThreadRead.recovery,
  null,
  "selecting another Thread must not consume a failed request owned elsewhere",
);
assert.equal(
  wrongThreadRead.remaining.get(threadAKey)?.input,
  submittedText,
  "failed retry state must remain available until its owning Thread becomes foreground again",
);

const restoredThreadA = takeMissionSubmissionFailure(wrongThreadRead.remaining, threadAKey);
assert.deepEqual(
  restoredThreadA.recovery,
  reportedFailure,
  "returning to the submitting Thread must restore its exact retry text and truthful failure",
);
assert.equal(
  restoredThreadA.remaining.has(threadAKey),
  false,
  "restored failure state must be consumed once so a later successful retry cannot resurrect stale failure UI",
);

console.log("Simple Mode submission feedback behavior passed.");
