import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(home, /const priorMissionResults = useMemo/, "Simple Mode must derive prior Mission results from already-loaded Thread messages");
assert.match(home, /new Set\(recentPriorMissions\.map\(\(mission\) => mission\.id\)\)/, "prior result projection must stay bounded to the visible prior Missions");
assert.match(home, /message\.role !== "assistant"/, "only durable assistant messages may become Mission result previews");
assert.match(home, /message\.metadata\?\.missionId/, "prior Mission results must be scoped by durable Mission lineage metadata");
assert.match(home, /!missionIds\.has\(missionId\)/, "messages from the current or sibling Mission must not leak into prior Mission rows");
assert.match(home, /results\.has\(missionId\)/, "only the latest durable assistant result for each prior Mission should be retained");
assert.match(home, /missionResultPreview\(message\.content\)/, "prior Mission results must pass through a bounded preview helper");
assert.match(home, /normalized\.length <= 220/, "prior Mission previews must stay compact on Home");
assert.match(home, /priorMissionResults\.get\(mission\.id\)/, "each visible prior Mission row must resolve its own result");
assert.match(home, /aria-label="Prior Mission result"/, "prior Mission results must be directly discoverable in Simple Mode");
assert.doesNotMatch(home, /find\(\(message\) => message\.role === "assistant"\)\?\.content/, "prior history must never fall back to an unscoped assistant message");

console.log("intent-home-prior-results-ui: ok");
