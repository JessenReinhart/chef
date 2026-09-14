import { strict as assert } from "node:assert";

import { failedMissionFollowupPrompt } from "../web/src/missionRecovery.ts";

const osc8BelFailure = "\u001b]8;;https://example.test/build\u0007Build failed\u001b]8;;\u0007 after compile";
const osc8StActivity = "\u001b]8;;https://example.test/tests\u001b\\3 tests failed\u001b]8;;\u001b\\";

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: osc8BelFailure,
    lastActivity: osc8StActivity,
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: Build failed after compile\nLast useful activity: 3 tests failed",
  "OSC hyperlinks terminated by BEL or ST must keep their printable labels without leaking terminal markup into recovery",
);

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: "\u001b]0;build worker\u0007\u001b[31mnpm test failed\u001b[0m\u0007",
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: npm test failed",
  "OSC titles, CSI formatting, and stray control bytes must compose into one readable recovery sanitizer",
);

const duplicateAfterSanitization = failedMissionFollowupPrompt({
  goal: "Create a simple todo app",
  failureReason: "\u001b]8;;https://example.test/error\u0007npm test failed\u001b]8;;\u0007",
  lastActivity: "npm   test failed",
});
assert.equal(
  duplicateAfterSanitization,
  "Fix this failed work: Create a simple todo app\n\nWhat happened: npm test failed",
  "deduplication must compare the readable sanitized context rather than terminal-decorated source strings",
);

console.log("recovery-context-sanitization: ok — failed-work follow-ups strip OSC/CSI/control markup while preserving readable labels and deduplication");
