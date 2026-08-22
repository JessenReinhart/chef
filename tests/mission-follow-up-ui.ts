import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../web/src/MissionPanel.tsx", import.meta.url), "utf8");

assert.match(source, /TERMINAL_STATUSES\.has\(mission\.status\)/, "follow-up UI should be gated by terminal Mission state");
assert.match(source, /aria-label="Continue with a follow-up Mission"/, "terminal Missions should expose a follow-up surface");
assert.match(source, /fetch\("\/api\/chat"/, "follow-up should use Chef's existing Mission-creating chat path");
assert.match(source, /Previous Mission goal: \$\{mission\.goal\}/, "follow-up request should carry the prior Mission goal as explicit context");
assert.match(source, /Start a new Mission/, "copy should make the new-Mission boundary clear");
assert.doesNotMatch(source, /redirectMission\(mission\.id/, "terminal follow-up must not reopen or mutate the finished Mission through redirect semantics");

console.log("mission follow-up UI acceptance passed");
