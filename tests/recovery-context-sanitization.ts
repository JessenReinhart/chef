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

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: "\u009d8;;https://example.test/c1\u009cC1 link label\u009d8;;\u009c after link",
    lastActivity: "\u009b31mred failure\u009b0m\u0085next",
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: C1 link label after link\nLast useful activity: red failure next",
  "C1 OSC/ST/CSI/control forms must be sanitized just like their 7-bit ESC equivalents",
);

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: "compile failed \u001bP1;2;3+qterminal query payload\u001b\\after query",
    lastActivity: "worker output \u009fprivate terminal payload\u009cstill useful",
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: compile failed after query\nLast useful activity: worker output still useful",
  "DCS/APC and equivalent string controls must drop their terminal-only payload instead of leaking it into recovery context",
);

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: "npm test failed then terminal started a link \u001b]8;;https://example.test/truncated",
    lastActivity: "worker was interrupted during terminal query \u0090private payload without terminator",
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: npm test failed then terminal started a link\nLast useful activity: worker was interrupted during terminal query",
  "unterminated OSC and terminal string controls must drop their truncated protocol tails when worker output ends mid-sequence",
);

assert.equal(
  failedMissionFollowupPrompt({
    goal: "Create a simple todo app",
    failureReason: "build failed \u001b[31",
    lastActivity: "test failed \u009b1;4",
  }),
  "Fix this failed work: Create a simple todo app\n\nWhat happened: build failed\nLast useful activity: test failed",
  "unterminated CSI fragments must not survive when worker output ends before the final control byte",
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

console.log("recovery-context-sanitization: ok — failed-work follow-ups strip complete and truncated terminal controls while preserving readable labels and deduplication");
