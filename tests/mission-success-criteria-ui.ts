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

console.log("mission-success-criteria-ui: ok — Mission completion intent is inspectable and editable");
