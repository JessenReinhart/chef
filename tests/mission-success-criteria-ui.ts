import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const panel = await readFile(new URL("../web/src/MissionPanel.tsx", import.meta.url), "utf8");
const types = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server/http-server.ts", import.meta.url), "utf8");

assert.match(types, /metadata\?: Record<string, unknown>/, "Mission UI contract should expose runtime metadata");
assert.match(panel, /Mission success criteria/, "Mission overview should expose a dedicated success-criteria surface");
assert.match(panel, /metadata\?\.successCriteria/, "success criteria should come from durable Mission metadata");
assert.match(panel, /\/api\/missions\/\$\{encodeURIComponent\(mission\.id\)\}\/success-criteria/, "editing should use the runtime-owned success-criteria endpoint");
assert.match(panel, /One criterion per line/, "criteria editing should be simple and outcome-oriented");
assert.match(panel, /No explicit success criteria yet/, "Missions without criteria should have an honest empty state");
assert.match(panel, /canControl && !editingCriteria/, "terminal Missions should keep criteria read-only");
assert.match(server, /mission\.success_criteria\.updated/, "criteria updates should remain event-auditable");
assert.doesNotMatch(panel, /dangerouslySetInnerHTML/, "criteria must render as text, not executable HTML");

assert.match(panel, /!TERMINAL_STATUSES\.has\(mission\.status\) \? \(/, "active Missions should keep redirect while terminal Missions get a separate continuation path");
assert.match(panel, /aria-label="Continue with a follow-up Mission"/, "terminal Missions should expose a follow-up surface");
assert.match(panel, /fetch\("\/api\/chat"/, "follow-up should use Chef's existing Mission-creating chat path");
assert.match(panel, /Previous Mission goal: \$\{mission\.goal\}/, "follow-up should carry the previous Mission goal into the new request");
assert.match(panel, /Follow-up request: \$\{request\}/, "follow-up should keep the user's next request distinct from the previous goal");
assert.match(panel, /keeping this finished run intact/, "follow-up copy should state that the terminal Mission remains intact");
assert.match(panel, /Start follow-up/, "terminal Missions should offer an outcome-oriented continuation action");

console.log("mission-success-criteria-ui: ok — Mission completion intent and follow-up are inspectable");
