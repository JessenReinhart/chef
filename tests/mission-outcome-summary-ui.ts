import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/MissionTimelineFeature.tsx", import.meta.url), "utf8");

assert.match(feature, /aria-label="Mission outcome summary"/, "finished Missions should expose a dedicated outcome summary");
assert.match(feature, /TERMINAL_PLAN_STATUSES = new Set\(\["completed", "failed", "cancelled"\]\)/, "outcome summary should only appear for terminal plan states");
assert.match(feature, /const OUTCOME_HIGHLIGHT_LIMIT = 4/, "outcome detail should remain bounded");
assert.match(feature, /state\.error \?\? state\.resultSummary/, "outcome highlights should prefer durable task errors or result summaries");
assert.match(feature, /Chef finished this Mission\./, "Simple Mode should use an outcome-oriented completion message");
assert.match(feature, /Summary derived from durable plan and task state/, "Power Mode should explain the summary provenance");
assert.match(feature, /outcome\.completed} done/, "summary should expose completed work counts");
assert.match(feature, /outcome\.failed} failed/, "summary should expose failed work counts when present");
assert.doesNotMatch(feature, /dangerouslySetInnerHTML/, "runtime outcome text must render as text, not executable HTML");

console.log("mission-outcome-summary-ui: ok — finished Missions expose bounded durable outcome summaries");
