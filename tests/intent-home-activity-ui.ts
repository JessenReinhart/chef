import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(home, /const recentMissionActivity = useMemo/, "Home must derive a reusable current-Mission activity projection");
assert.match(home, /if \(currentMissionTaskIds\.size === 0\) return \[\];/, "activity must stop when the current Mission has no task lineage");
assert.match(home, /currentMissionTaskIds\.has\(event\.taskId\)/, "activity must exclude prior Missions and sibling Threads");
assert.match(home, /const text = activityText\(event\)/, "activity history must reuse the existing human-readable worker-output normalization");
assert.match(home, /text === recent\[recent\.length - 1\]/, "adjacent duplicate activity output must be suppressed");
assert.match(home, /if \(recent\.length === 4\) break;/, "default Mission activity history must remain bounded to four entries");
assert.match(home, /const lastMissionActivity = recentMissionActivity\[0\] \?\? null;/, "failure recovery must reuse the newest item from the same bounded activity projection");
assert.match(home, /aria-label="Recent Mission activity"/, "normal current work must expose recent activity without opening Workbench");
assert.match(home, />Recent activity</, "the activity surface must use product language");
assert.match(home, /recentMissionActivity\.map/, "Home must render the bounded current-Mission activity list");
assert.doesNotMatch(home, /Recent activity[\s\S]{0,600}\{event\.type\}|Recent activity[\s\S]{0,600}\{event\.taskId\}/, "the default activity surface must not expose raw runtime event vocabulary or IDs");

console.log("intent-home-activity-ui: ok");
