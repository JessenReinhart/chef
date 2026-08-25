import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const home = await readFile(new URL("../web/src/IntentHome.tsx", import.meta.url), "utf8");

assert.match(home, /const recentMissionActivity = useMemo/, "Home must derive a bounded current-Mission activity projection");
assert.match(home, /currentMissionTaskIds\.has\(event\.taskId\)/, "recent activity must stay scoped to the current Mission task lineage");
assert.match(home, /const text = activityText\(event\)/, "recent activity must reuse the existing human-readable session output normalization");
assert.match(home, /text === previousText/, "adjacent duplicate worker output must not repeat in the activity list");
assert.match(home, /recent\.length === 3/, "the default recent activity list must stay bounded to three entries");
assert.match(home, /sort\(\(a, b\) => b\.seq - a\.seq\)/, "recent activity must show newest runtime output first");
assert.match(home, /Current Mission recent activity/, "Home must render current-Mission activity without requiring Workbench");
assert.match(home, />Recent activity</, "the activity surface must use plain product language");
assert.match(home, /recentMissionActivity\.map/, "all bounded recent activity entries must be projected in the Home surface");
assert.doesNotMatch(home, /payload\.data.*Recent activity/s, "Home must not render raw event payload objects in the recent activity surface");

console.log("intent home recent activity UI tests passed");
