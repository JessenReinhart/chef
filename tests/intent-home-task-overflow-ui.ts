import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(
  home,
  /const earlierMissionTasks = useMemo\([\s\S]*currentMissionTasks\.slice\(0, -6\)/,
  "Home should retain every earlier current-Mission task instead of silently dropping it",
);
assert.match(
  home,
  /const missionTasks = useMemo\([\s\S]*currentMissionTasks\.slice\(-6\)/,
  "Home should keep the latest six current-Mission tasks visible by default",
);
assert.match(
  home,
  /aria-label="Earlier current Mission steps"/,
  "Home should expose omitted earlier steps through Simple Mode progressive disclosure",
);
assert.match(
  home,
  /Earlier steps · \{earlierMissionTasks\.length\}/,
  "the disclosure should tell the user how many earlier steps are hidden by default",
);
assert.match(
  home,
  /earlierMissionTasks\.map\(renderMissionTask\)/,
  "revealed earlier steps should use the same human-readable task renderer as the default list",
);
assert.match(
  home,
  /missionTasks\.map\(renderMissionTask\)/,
  "the default task list should share task status and retry behavior with overflow steps",
);
assert.match(
  home,
  /const canRetry = task\.status === "failed" \|\| \(task\.status === "blocked" && !approvalTaskIds\.has\(task\.id\)\)/,
  "earlier failed or non-approval-blocked steps should remain actionable with the same retry policy",
);
assert.doesNotMatch(
  home,
  /earlierMissionTasks\.map\([^)]*=>[^)]*task\.id[^)]*\)/,
  "the overflow surface should not introduce raw Task IDs as user-facing content",
);

console.log("intent-home-task-overflow-ui: ok — earlier current-Mission steps stay discoverable and actionable in Simple Mode");
