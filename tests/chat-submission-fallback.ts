import { strict as assert } from "node:assert";

import {
  assistantContentSeenSinceLastUser,
  chatSubmissionFallback,
} from "../web/src/chatSubmissionFallback.ts";

assert.deepEqual(
  chatSubmissionFallback({ ok: true, report: "Mission accepted.", accepted: true }),
  { content: "Mission accepted.", isError: false },
  "a successful POST report must remain a visible fallback when chat SSE is missed",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: true, report: "", accepted: true }),
  { content: "Got it. I’m starting this now.", isError: false },
  "an accepted Mission with no report must still acknowledge that Chef started",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: false, report: "Provider unavailable" }),
  { content: "Provider unavailable", isError: true },
  "a rejected submission must remain visibly marked as an error",
);

assert.deepEqual(
  chatSubmissionFallback({ ok: false, report: "" }),
  { content: "I couldn't start that work yet. Please try again.", isError: true },
  "an empty failed response must still provide a concrete retryable failure",
);

assert.equal(
  chatSubmissionFallback({ ok: true, report: "", accepted: false }),
  null,
  "a successful response without report or acceptance evidence must not invent progress",
);

const currentTurn = [
  { role: "user", content: "Create a simple todo app" },
  { role: "assistant", content: "Got it. I’m starting this now." },
  { role: "assistant", content: "Mission started with 1 planned step." },
];
assert.equal(
  assistantContentSeenSinceLastUser(currentTurn, "Got it. I’m starting this now."),
  true,
  "a matching SSE acknowledgement must be recognized even when another progress message followed the POST fallback",
);
assert.equal(
  assistantContentSeenSinceLastUser(
    [
      { role: "assistant", content: "Got it. I’m starting this now." },
      { role: "user", content: "Create a simple todo app" },
    ],
    "Got it. I’m starting this now.",
  ),
  false,
  "an acknowledgement from an older turn must not suppress the current submission fallback",
);

console.log("chat submission fallback behavior passed");
