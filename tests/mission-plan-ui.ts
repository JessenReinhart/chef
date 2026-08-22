import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const feature = await readFile(new URL("../web/src/MissionTimelineFeature.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("../web/src/ChatPanel.tsx", import.meta.url), "utf8");

assert.match(feature, /\/api\/missions\/\$\{encodeURIComponent\(missionId\)\}\/plans/, "Mission overview should use the runtime-owned plan projection");
assert.match(feature, /plans\.find\(\(plan\) => plan\.isCurrent\)/, "the UI should prefer the runtime-marked current plan");
assert.match(feature, /currentPlan\.tasks\.slice\(0, PLAN_TASK_LIMIT\)/, "plan disclosure should remain bounded");
assert.match(feature, /const PLAN_TASK_LIMIT = 12/, "plan visualization should cap visible steps to a compact Mission overview");
assert.match(feature, /The work Chef intends to execute for this Mission\./, "Simple Mode should explain the plan in outcome-oriented language");
assert.match(feature, /state\?\.error \?\? state\?\.resultSummary \?\? task\.description/, "task cards should surface runtime failure/result detail before static descriptions");
assert.match(feature, /mode === "power"/, "Power Mode should retain technical plan and task metadata");
assert.match(feature, /Mission plan is temporarily unavailable\./, "plan projection failures should degrade honestly without breaking Mission controls");
assert.doesNotMatch(feature, /dangerouslySetInnerHTML/, "plan and runtime details must render as text, not executable HTML");
assert.match(chat, /Mission started with \$\{count\} planned step/, "Simple Mode should describe plan task count as planned work");
assert.doesNotMatch(chat, /Mission started with \$\{count\} teammate/, "Simple Mode must not claim one teammate per task");

console.log("mission-plan-ui: ok — current Mission plan is visible with bounded, truthful progressive disclosure");
