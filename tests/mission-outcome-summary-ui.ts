import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/MissionTimelineFeature.tsx", import.meta.url), "utf8");

assert.match(feature, /aria-label="Mission outcome summary"/, "finished Missions should expose a dedicated outcome summary");
assert.match(feature, /TERMINAL_PLAN_STATUSES = new Set\(\["completed", "failed", "cancelled"\]\)/, "outcome summary should only appear for terminal plan states");
assert.match(feature, /const OUTCOME_HIGHLIGHT_LIMIT = 4/, "outcome detail should remain bounded");
assert.match(feature, /state\.error \?\? state\.resultSummary/, "outcome highlights should prefer durable task errors or result summaries");
assert.match(feature, /Chef finished this Mission\./, "Simple Mode should use an outcome-oriented completion message");
assert.match(feature, /Summary derived from durable plan and task state/, "Power Mode should explain the outcome-summary provenance");
assert.match(feature, /outcome\.completed} done/, "summary should expose completed work counts");
assert.match(feature, /outcome\.failed} failed/, "summary should expose failed work counts when present");

assert.match(feature, /aria-label="Mission progress summary"/, "active Missions should expose a dedicated human-readable progress summary");
assert.match(feature, /function buildMissionProgressSummary\(plan: MissionPlan\)/, "progress copy should be derived from durable plan state");
assert.match(feature, /if \(TERMINAL_PLAN_STATUSES\.has\(plan\.status\)\) return null/, "progress summary should hand off to the terminal outcome summary");
assert.match(feature, /const PROGRESS_HIGHLIGHT_LIMIT = 3/, "current-focus disclosure should remain bounded");
assert.match(feature, /ATTENTION_TASK_STATUSES = new Set\(\["failed", "blocked"\]\)/, "blocked and failed work should take priority in the progress summary");
assert.match(feature, /What Chef is doing now/, "progress summary should use plain-language current-work framing");
assert.match(feature, /Chef is working on \$\{activeStates\.length\}/, "active work should be summarized without raw event inspection");
assert.match(feature, /Chef is preparing the next work item\./, "queued work should have an honest waiting summary");
assert.match(feature, /Summary derived from the current durable plan and task state/, "Power Mode should explain progress-summary provenance");
assert.doesNotMatch(feature, /dangerouslySetInnerHTML/, "runtime summary text must render as text, not executable HTML");

console.log("mission-outcome-summary-ui: ok — active and finished Missions expose bounded durable summaries");
